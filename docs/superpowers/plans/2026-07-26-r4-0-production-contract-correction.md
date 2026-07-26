# R4.0 Production Contract Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax so progress can be tracked directly in this document.

**Goal:** Make the checked-in ACA manifests the production runtime contract, align ClamAV signature freshness with the approved weekly operating model, and prove the corrected contract through deterministic tests, Kernel acceptance, CI, and one production release.

**Architecture:** Keep the existing modular monolith and finite ACA Job design. Add one pure ClamAV signature-policy module used by the worker and its job entrypoint. The scan Job manifest supplies the approved 7-day warning and 8-day fail-closed thresholds. `aca.containerapp.yaml` owns bot Dapr, ingress, probes, scale, resources, mounts, and environment-variable structure; `scripts/deploy-aca.sh` owns environment-specific values, secret-reference names, secret values, image selection, rendering, application order, and rollout verification.

**Tech Stack:** TypeScript, Vitest, Fastify service image, Azure Container Apps and Jobs YAML, Bash, Azure CLI, GitHub Actions, Kernel v1 deterministic acceptance corpus.

## Global Constraints

- Work on the existing `codex/single-church-roadmap-redesign` branch because this is the same unfinished roadmap task.
- Use TDD for every behavior or deployment-contract change: write the failing assertion, run it and observe the intended failure, make the smallest implementation change, then rerun it.
- Do not add a YAML parsing dependency. The existing manifest contract tests intentionally inspect stable checked-in text and deployment-script ordering.
- Do not expose secret values in source, rendered manifests, tests, logs, commits, pull requests, or command output.
- Keep ClamAV refresh weekly at `10 19 * * 0` UTC, warn after 7 days, and fail closed only after 8 days.
- Keep the finite scanner at `2 CPU / 4 GiB`, without ingress, with one execution at a time and a read-only signature mount.
- Keep secret creation, secret-reference mapping, and secret-value rotation in `scripts/deploy-aca.sh`; the checked-in bot manifest contains active secret-reference placeholders but no `configuration.secrets` values.
- Preserve the deployment safety order: provision secrets, deploy SearXNG, deploy bot, verify bot, deploy refresh Job, bootstrap and await a successful refresh, then enable/update the scan Job.
- Do not perform DeepSeek or Azure embedding live calls for this milestone. R4.0 is a deterministic runtime/deployment contract correction.
- Do not merge or deploy until the user explicitly authorizes R4.0 implementation delivery. Once authorized, use a pull request because `main` is protected, wait for `PR CI`, enable auto-merge, then verify the post-merge Production Release.

---

## Task 1: Specify the ClamAV freshness policy as a pure contract

**Files:**

- Create: `src/attachments/clamav-signature-policy.ts`
- Modify: `src/attachments/scan-worker.ts`
- Modify: `src/__tests__/clamav-signature-refresh.test.ts`

- [ ] **Step 1: Add failing boundary tests for current, warning, stale, malformed, and future manifests**

In `src/__tests__/clamav-signature-refresh.test.ts`, replace the old “over-72-hour” table with direct tests for a new pure classifier:

```ts
import {
  CLAMAV_SIGNATURE_MAX_AGE_MS,
  CLAMAV_SIGNATURE_WARNING_AGE_MS,
  classifyClamAvSignatureManifest
} from "../attachments/clamav-signature-policy.js";
```

Cover these exact boundaries at a fixed `now`:

```ts
expect(classify(validAt(now), now)).toBe("current");
expect(classify(validAt(nowMinus(CLAMAV_SIGNATURE_WARNING_AGE_MS)), now)).toBe("warning");
expect(classify(validAt(nowMinus(CLAMAV_SIGNATURE_MAX_AGE_MS)), now)).toBe("warning");
expect(classify(validAt(nowMinus(CLAMAV_SIGNATURE_MAX_AGE_MS + 1)), now)).toBe("stale");
expect(classify(undefined, now)).toBe("stale");
expect(classify({ version: 2 }, now)).toBe("stale");
expect(classify(validAt(nowPlus(1)), now)).toBe("stale");
```

Retain validation of the optional immutable `sets/<signatureVersion>` database directory.

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run:

```bash
pnpm vitest run src/__tests__/clamav-signature-refresh.test.ts
```

Expected: FAIL because `clamav-signature-policy.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal pure policy module**

Create `src/attachments/clamav-signature-policy.ts` with these public types and constants:

```ts
export const CLAMAV_SIGNATURE_WARNING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLAMAV_SIGNATURE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

export interface ClamAvSignatureManifest {
  version: 1;
  signatureVersion: string;
  lastSuccessfulAt: string;
  databaseDirectory?: string;
}

export interface ClamAvSignatureAgePolicy {
  warningAgeMs: number;
  maxAgeMs: number;
}

export type ClamAvSignatureHealth = "current" | "warning" | "stale";

export function classifyClamAvSignatureManifest(
  value: unknown,
  now: Date,
  policy?: ClamAvSignatureAgePolicy
): ClamAvSignatureHealth;
```

The classifier must:

- return `stale` for missing/malformed manifests, invalid timestamps, future timestamps, invalid signature versions, or invalid database-directory references;
- return `current` when age is strictly below `warningAgeMs`;
- return `warning` from `warningAgeMs` through `maxAgeMs`, inclusive;
- return `stale` only when age exceeds `maxAgeMs`;
- reject invalid policy input where thresholds are non-positive or `warningAgeMs >= maxAgeMs`.

Move `ClamAvSignatureManifest` out of `scan-worker.ts`. Re-export `isCurrentClamAvSignatureManifest` from `scan-worker.ts` as a compatibility wrapper returning `classify(...) !== "stale"` until all callers are migrated.

- [ ] **Step 4: Run the focused policy test**

Run:

```bash
pnpm vitest run src/__tests__/clamav-signature-refresh.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the policy contract**

```bash
git add src/attachments/clamav-signature-policy.ts src/attachments/scan-worker.ts src/__tests__/clamav-signature-refresh.test.ts
git commit -m "feat: define weekly ClamAV signature policy"
```

---

## Task 2: Apply warning and fail-closed health throughout the scan worker

**Files:**

- Modify: `src/attachments/scan-worker.ts`
- Modify: `src/__tests__/scan-worker.test.ts`

- [ ] **Step 1: Add failing worker lifecycle tests**

In `src/__tests__/scan-worker.test.ts`, add or update tests proving:

- a manifest younger than 7 days publishes and returns `signatureHealth: "current"`;
- a manifest exactly 7 days old publishes and returns `signatureHealth: "warning"`;
- a manifest exactly 8 days old still publishes and returns `signatureHealth: "warning"`;
- a manifest older than 8 days fails with `signature_stale` and performs zero uploads;
- if the manifest crosses the 8-day boundary before publication, the worker fails and performs zero uploads;
- if the signature version or database directory changes during the scan, publication still fails closed.

Use injected `now()` values only; do not use wall-clock sleeps.

- [ ] **Step 2: Run the focused worker test and observe the old-result/72-hour failures**

Run:

```bash
pnpm vitest run src/__tests__/scan-worker.test.ts
```

Expected: FAIL because the worker still uses a 72-hour Boolean check and completed results have no `signatureHealth`.

- [ ] **Step 3: Update the worker result and both freshness checks**

Change the successful result branch to:

```ts
type CompletedAttachmentScanWorkerResult = {
  status: "completed";
  signatureHealth: Exclude<ClamAvSignatureHealth, "stale">;
};
```

Use `CompletedAttachmentScanWorkerResult` as the completed member of the
existing `AttachmentScanWorkerResult` union. Change
`AttachmentScanWorkerOptions` to accept:

```ts
signaturePolicy?: ClamAvSignatureAgePolicy;
```

Remove `signatureMaxAgeMs`. Classify the manifest before download and immediately before publication. A `stale` result must call `failWork(..., "signature_stale", true)`. Return the publication-time health with a completed result. Keep the existing equality checks for `signatureVersion` and `databaseDirectory`.

- [ ] **Step 4: Run focused scan tests**

Run:

```bash
pnpm vitest run src/__tests__/scan-worker.test.ts src/__tests__/clamav-signature-refresh.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit worker enforcement**

```bash
git add src/attachments/scan-worker.ts src/__tests__/scan-worker.test.ts
git commit -m "feat: enforce ClamAV warning and stale thresholds"
```

---

## Task 3: Make scan Job environment configuration explicit and observable

**Files:**

- Modify: `src/tools/run-attachment-scan-job.ts`
- Modify: `src/__tests__/attachment-scan-job.test.ts`
- Modify: `aca.attachment-scan-job.yaml`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

- [ ] **Step 1: Add failing environment and output tests**

Extend `src/__tests__/attachment-scan-job.test.ts` to require:

```ts
{
  signaturePolicy: {
    warningAgeMs: 168 * 60 * 60 * 1000,
    maxAgeMs: 192 * 60 * 60 * 1000
  }
}
```

Test defaults and explicit `CLAMAV_SIGNATURE_WARNING_AGE_HOURS` /
`CLAMAV_SIGNATURE_MAX_AGE_HOURS` values. Reject zero, non-integer, non-numeric,
and `warning >= max` configurations.

Add a test that a completed worker status is serialized only as:

```ts
{ status: "completed", signatureHealth: "warning" }
```

No manifest timestamp, signature version, paths, file names, or work IDs may be logged.
Test this through a new pure exported
`formatAttachmentScanJobStatus(result: AttachmentScanWorkerResult)` helper so
the unit test does not need Redis, PostgreSQL, LINE, Graph, or Azure Queue.

In `src/__tests__/profile-config-deployment-contract.test.ts`, assert that the scan Job manifest contains:

```yaml
- name: CLAMAV_SIGNATURE_WARNING_AGE_HOURS
  value: "168"
- name: CLAMAV_SIGNATURE_MAX_AGE_HOURS
  value: "192"
```

- [ ] **Step 2: Run focused tests and observe missing configuration**

Run:

```bash
pnpm vitest run src/__tests__/attachment-scan-job.test.ts src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: FAIL because the environment parser, sanitized status, and manifest values are absent.

- [ ] **Step 3: Parse and pass the explicit policy**

Update `AttachmentScanJobEnvironment` with:

```ts
signaturePolicy: ClamAvSignatureAgePolicy;
```

Parse positive integer hours, defaulting to 168 and 192, validate the ordering, convert once to milliseconds, and pass the resulting policy into `runAttachmentScanWorker`.

When a worker completes, keep the process exit code `0` and expose only `status` plus `signatureHealth` through `formatAttachmentScanJobStatus`. Existing ignored and failed status handling remains unchanged.

- [ ] **Step 4: Add the two fixed env values to the scan Job manifest**

Add the two environment variables immediately after `CLAMAV_SCAN_TIMEOUT_MS` in `aca.attachment-scan-job.yaml`. Do not add them to the always-on bot or catalog Job.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm vitest run src/__tests__/attachment-scan-job.test.ts src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Job configuration**

```bash
git add src/tools/run-attachment-scan-job.ts src/__tests__/attachment-scan-job.test.ts aca.attachment-scan-job.yaml src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "feat: configure ClamAV age policy in scan job"
```

---

## Task 4: Promote the bot ACA manifest to the deployment source of truth

**Files:**

- Modify: `aca.containerapp.yaml`
- Modify: `scripts/deploy-aca.sh`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

- [ ] **Step 1: Replace imperative-deployment expectations with manifest-contract expectations**

Update `src/__tests__/profile-config-deployment-contract.test.ts` so it requires:

- `aca.containerapp.yaml` retains Dapr, internal ingress, liveness/readiness probes, scale, resource limits, env names, and one explicit placeholder for each active `secretRef`;
- the manifest has no `configuration.secrets` block and no
  `PLACEHOLDER_SET_IN_AZURE_CONTAINER_APP_SECRETS`;
- the retired bot-only secret names
  `attachment-scan-queue-connection-string` and
  `clamav-signature-storage-key` do not appear in the bot manifest;
- the deployment script declares and cleans up a rendered bot manifest;
- the script fails before apply if any `PLACEHOLDER_` token remains;
- the bot is applied with `az containerapp update --yaml "${bot_manifest}"`;
- the script no longer builds `update_args`, invokes the imperative bot
  `az containerapp update "${update_args[@]}"`, or separately runs
  `az containerapp dapr enable`;
- deployment ordering is SearXNG, rendered bot manifest, bot health verification,
  refresh Job, refresh bootstrap, scan Job, catalog Job;
- the script refreshes bot env and secret metadata after the bot rollout before
  rendering dependent Jobs.

- [ ] **Step 2: Run the deployment contract test and observe the current dual-source failures**

Run:

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: FAIL because the bot manifest embeds placeholder secret values and the script updates the bot imperatively.

- [ ] **Step 3: Remove secret values from the bot manifest**

Delete `properties.configuration.secrets` from `aca.containerapp.yaml`. Retain
every active container secret consumer but replace its value with a distinct
renderer token such as `PLACEHOLDER_DEEPSEEK_API_KEY_SECRET_REF`. This prevents
the checked-in manifest from owning either secret values or environment-specific
secret-reference names.

Replace deployment-owned values with explicit renderer placeholders:

- Azure region and Container Apps environment resource ID;
- bot image;
- internal SearXNG URL;
- Azure embedding endpoint;
- Graph and Notion resource IDs currently copied from the deployed bot environment.
- every active ACA secret-reference name.

Keep stable operating values directly in YAML, including profile path, Dapr settings, probe paths, limits, timeouts, scale, and resource totals.

- [ ] **Step 4: Render and apply the bot manifest in the deployment script**

In `scripts/deploy-aca.sh`:

1. add `bot_manifest_template` and a `mktemp` output;
2. add the bot output to the existing `trap`;
3. validate that the template exists;
4. after SearXNG has a resolved internal FQDN and all secret values have been provisioned, render environment values and secret-reference names using a bounded Python substitution map;
5. source private non-secret Graph/Notion identifiers from the existing sanitized `bot_env_json`;
6. fail if a required source env is absent or if the rendered file still contains `PLACEHOLDER_`;
7. apply with:

```bash
az containerapp update \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CONTAINER_APP_NAME}" \
  --yaml "${bot_manifest}" \
  --only-show-errors \
  --output none
```

8. keep the existing revision-health wait;
9. assert live Dapr remains enabled with app ID `hhc-line-function-bot`, port `3000`, and protocol `http`;
10. refresh `bot_secrets_json` and `bot_env_json` for dependent Job rendering.

The renderer may place ACA secret names such as `deepseek-api-key`, but must
never read or place their secret values in the bot YAML.

- [ ] **Step 5: Run the deployment contract test**

Run:

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Validate shell syntax**

Run:

```bash
bash -n scripts/deploy-aca.sh
```

Expected: exit code `0`.

- [ ] **Step 7: Commit the deployment source-of-truth correction**

```bash
git add aca.containerapp.yaml scripts/deploy-aca.sh src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "refactor: deploy bot from checked-in ACA manifest"
```

---

## Task 5: Version the Kernel attachment-safety acceptance boundary

**Files:**

- Modify: `src/evals/kernel/contracts.ts`
- Modify: `src/evals/kernel/corpus.ts`
- Modify: `src/evals/kernel/cases/remote-runtime.ts`
- Modify: `src/__tests__/kernel-corpus.test.ts`

- [ ] **Step 1: Add failing Kernel expectations for warning and stale behavior**

Replace the old stale case ID with:

```text
kernel-v1/write/signature-stale-no-publish@2
```

and add:

```text
kernel-v1/write/signature-warning-publishes@1
```

The warning case uses a manifest age of `7 days + 1 ms` and passes only when:

- worker status is `completed`;
- `signatureHealth` is `warning`;
- exactly one upload occurred.

The stale case uses a manifest age of `8 days + 1 ms` and passes only when:

- failure code is `signature_stale`;
- zero uploads occurred.

Change `KernelAcceptanceCase.version` from the literal `1` to `number`. Update
`validateKernelCorpus` so it parses the positive integer after `@`, rejects
zero/non-integers, and rejects a case when the parsed ID version differs from
`entry.version`. Update the expected ID list. Existing `@1` cases retain
`version: 1`; the replaced stale case has `version: 2`.

- [ ] **Step 2: Run the Kernel corpus test and observe the old-boundary failure**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts
```

Expected: FAIL because the new versioned IDs and warning case are not yet present.

- [ ] **Step 3: Implement the two deterministic Kernel cases**

Use the existing in-memory scan fixture and fixed clock. Do not call Azure, LINE, DeepSeek, embedding, Redis, or PostgreSQL.

Keep both cases in the existing `write_safety_bypass` recurrence family and remote-runtime suite so `pnpm eval:kernel` exercises them.

- [ ] **Step 4: Run the Kernel gates**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts
pnpm eval:kernel
```

Expected: PASS with both new signature-policy cases reported as passed.

- [ ] **Step 5: Commit Kernel acceptance**

```bash
git add src/evals/kernel/contracts.ts src/evals/kernel/corpus.ts src/evals/kernel/cases/remote-runtime.ts src/__tests__/kernel-corpus.test.ts
git commit -m "test: version ClamAV freshness Kernel boundary"
```

---

## Task 6: Align active product and operations documentation

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `docs/runbooks/production-operations.md`
- Modify: `docs/superpowers/specs/2026-07-19-controlled-retrieval-product-roadmap-design.md`
- Modify: `src/__tests__/modular-monolith-docs.test.ts`

- [ ] **Step 1: Add failing documentation-contract assertions**

Extend `src/__tests__/modular-monolith-docs.test.ts` to require the active docs to agree on:

- weekly `10 19 * * 0` UTC refresh;
- warning after 7 days;
- fail closed after 8 days;
- scanner resources `2 CPU / 4 GiB`;
- manifest/deploy-script ownership split.

Assert that active docs no longer describe a 72-hour maximum or a `1 vCPU / 4 GiB` scanner.

- [ ] **Step 2: Run the documentation test and observe stale-contract failures**

Run:

```bash
pnpm vitest run src/__tests__/modular-monolith-docs.test.ts
```

Expected: FAIL on the old 72-hour and 1-vCPU text.

- [ ] **Step 3: Update active documentation**

Make these exact corrections:

- `AGENTS.md`: scanner is `2 CPU / 4 GiB`; refresh is weekly; warn after 7 days and fail closed after 8 days.
- `README.md`: explain sanitized `signatureHealth` output, the 7/8-day policy, and manifest-driven bot deployment.
- `docs/architecture-context.md`: describe the pure signature policy and both pre-scan/pre-publication checks.
- `docs/runbooks/production-operations.md`: document weekly schedule, alert threshold, hard-stop threshold, manifest verification, and the operator response when health is `warning`.
- `docs/superpowers/specs/2026-07-19-controlled-retrieval-product-roadmap-design.md`: mark its old 72-hour/two-day scanner text as superseded by the approved single-church R4.0 contract and link to `2026-07-26-single-church-optimization-roadmap-design.md`.

Do not rewrite historical completed implementation plans; they remain evidence of the earlier contract.

- [ ] **Step 4: Run documentation and deployment contract tests**

Run:

```bash
pnpm vitest run src/__tests__/modular-monolith-docs.test.ts src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit documentation alignment**

```bash
git add AGENTS.md README.md docs/architecture-context.md docs/runbooks/production-operations.md docs/superpowers/specs/2026-07-19-controlled-retrieval-product-roadmap-design.md src/__tests__/modular-monolith-docs.test.ts
git commit -m "docs: align R4 production operating contract"
```

---

## Task 7: Run the complete pre-PR verification boundary

**Files:**

- Verify all changed files
- Do not modify unrelated files to make gates pass

- [ ] **Step 1: Run all focused R4.0 tests together**

```bash
pnpm vitest run \
  src/__tests__/clamav-signature-refresh.test.ts \
  src/__tests__/scan-worker.test.ts \
  src/__tests__/attachment-scan-job.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts \
  src/__tests__/modular-monolith-docs.test.ts \
  src/__tests__/kernel-corpus.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:agent
pnpm eval:kernel
pnpm eval:kernel:integration
pnpm build
bash -n scripts/deploy-aca.sh
git diff --check
```

Expected: every command exits `0`. `eval:kernel:integration` must create and remove its disposable Redis/PostgreSQL Compose dependencies rather than skip them.

- [ ] **Step 3: Inspect scope and commit any mechanical formatting only**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

If a formatter made intended changes, inspect them and commit:

```bash
git add \
  AGENTS.md README.md aca.containerapp.yaml aca.attachment-scan-job.yaml \
  docs/architecture-context.md docs/runbooks/production-operations.md \
  docs/superpowers/specs/2026-07-19-controlled-retrieval-product-roadmap-design.md \
  scripts/deploy-aca.sh src/attachments/clamav-signature-policy.ts \
  src/attachments/scan-worker.ts src/tools/run-attachment-scan-job.ts \
  src/evals/kernel/contracts.ts src/evals/kernel/corpus.ts \
  src/evals/kernel/cases/remote-runtime.ts src/__tests__/attachment-scan-job.test.ts \
  src/__tests__/clamav-signature-refresh.test.ts src/__tests__/kernel-corpus.test.ts \
  src/__tests__/modular-monolith-docs.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts \
  src/__tests__/scan-worker.test.ts
git commit -m "style: format R4 production contract changes"
```

Expected: clean worktree and no unrelated files in the branch.

---

## Task 8: Pull request, protected merge, production release, and live verification

**Files:**

- No new source files expected
- Observe: `.github/workflows/ci.yml`
- Observe: `.github/workflows/release.yml`

- [ ] **Step 1: Rebase the task branch on the latest protected main**

```bash
git fetch origin
git rebase origin/main
```

Resolve only conflicts belonging to this task, rerun the full Task 7 gate after any conflict resolution, and never force-push `main`.

- [ ] **Step 2: Push the branch and open a pull request**

```bash
git push --set-upstream origin codex/single-church-roadmap-redesign
gh pr create \
  --base main \
  --head codex/single-church-roadmap-redesign \
  --title "R4.0: correct production runtime contracts" \
  --body "Corrects the approved weekly ClamAV freshness policy, makes the checked-in ACA manifest authoritative for the bot rollout, and adds deterministic Kernel coverage. Verification: full PR CI gate."
```

The PR body must summarize the 7/8-day signature policy, manifest ownership correction, Kernel coverage, and verification commands. It must not contain secret values or live configuration exports.

- [ ] **Step 3: Wait for required `PR CI` and enable auto-merge**

```bash
pr_number="$(gh pr view --json number --jq .number)"
gh pr checks "${pr_number}" --watch
gh pr merge "${pr_number}" --auto --squash
```

Expected: required `PR CI` passes and the protected ruleset squash-merges the PR.

- [ ] **Step 4: Monitor the post-merge Production Release**

Use GitHub Actions to identify the release triggered by the merge commit and wait for completion. Confirm:

- both application images build in ACR;
- SearXNG applies before the bot;
- the bot manifest applies without unresolved placeholders;
- the bot revision becomes healthy with Dapr enabled;
- refresh Job applies and one bootstrap refresh succeeds;
- scan Job applies only after that refresh;
- catalog Job applies;
- release completes successfully.

- [ ] **Step 5: Perform bounded live read-only verification**

Run Azure CLI queries that expose configuration metadata only. Do not print secret values.

Verify:

- bot has one healthy active revision;
- internal ingress, target port, and Dapr app ID/port/protocol match the manifest;
- public gateway path still reaches `/healthz` and the canonical LINE webhook route;
- scan Job has `2 CPU / 4 GiB`, max one execution, no ingress, read-only ClamAV storage, and 168/192-hour age variables;
- refresh Job has cron `10 19 * * 0`, max one execution, no ingress, and read/write ClamAV storage;
- latest bootstrap refresh execution succeeded;
- no bot secret named `attachment-scan-queue-connection-string` or `clamav-signature-storage-key` remains;
- application logs contain no unresolved placeholder or rollout error.

Do not trigger an attachment upload, DeepSeek call, or Azure embedding call for this verification.

- [ ] **Step 6: Record completion evidence**

Report the PR number, squash commit, `PR CI` run, Production Release run, healthy bot revision, successful refresh execution, scan/refresh Job contract values, and that no live AI-provider requests were consumed.

Only mark R4.0 complete after all of those items are verified. The next roadmap milestone is R5.1 operational hardening, not additional R4.0 scope.

# R5.0 Lean Release Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each production release provider-free, evidence-producing, and
recoverable, then add the low-frequency external dependency checks required
before Stable Maintenance.

**Architecture:** Keep the existing manifest-driven single-revision ACA
deployment. Add pure TypeScript assurance probes and report builders, two
finite ACA Jobs, and a small shell transaction library used by the existing
deployment and a weekly workflow. A recorded pre-deploy revision is copied to a
new verified rollback revision on required-gate failure.

**Tech Stack:** TypeScript 5, Node.js 24, Vitest, Bash, Azure CLI, Azure
Container Apps/Jobs, GitHub Actions, Microsoft Graph, Notion, Azure Queue
Storage, ClamAV.

## Global Constraints

- The roadmap ends at R5.0 and then enters Stable Maintenance.
- Do not add a database, SaaS/tenant/branch identity, another semantic provider,
  or an office-runtime dependency.
- Deploy-time assurance must issue exactly zero DeepSeek and zero embedding
  requests.
- The release webhook body is exactly `{"events":[]}` and must not create a LINE
  reply.
- Reports are allowlist-only and must never include secrets, FQDNs, response
  bodies, file names, content, LINE IDs, Graph/Notion IDs, or credential URLs.
- ClamAV signature age is warning-only after seven days; invalid/missing/future
  manifests fail.
- No retry loop may call an external data provider. ACA readiness/status polling
  remains bounded.

---

### Task 1: Add Versioned Assurance Reports And The Deploy-Time Probe

**Files:**
- Create: `src/assurance/report.ts`
- Create: `src/assurance/release-probe.ts`
- Create: `src/tools/run-release-probe.ts`
- Create: `src/__tests__/assurance-report.test.ts`
- Create: `src/__tests__/release-probe.test.ts`
- Modify: `src/__tests__/entrance.test.ts`

**Interfaces:**
- Produces:
  `buildAssuranceReport(input: AssuranceReportInput): AssuranceReport`
- Produces:
  `runReleaseProbe(input: ReleaseProbeInput,
  dependencies: ReleaseProbeDependencies): Promise<ReleaseProbeResult>`
- The CLI reads `BOT_BASE_URL`, `SEARXNG_BASE_URL`,
  `GATEWAY_WEBHOOK_URL`, `LINE_HELPER_CHANNEL_SECRET`, and
  `CLAMAV_SIGNATURE_MANIFEST_PATH`.

- [ ] **Step 1: Write report allowlist tests**

Test exact version/kind/status/check/rollback/provider-request fields; reject
unknown check names, non-zero provider counts, credential-shaped URLs, raw
body/content fields, and invalid timestamps.

- [ ] **Step 2: Run the report tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/assurance-report.test.ts
```

Expected: FAIL because `src/assurance/report.ts` does not exist.

- [ ] **Step 3: Implement the minimal report builder**

Use explicit TypeScript unions for report kind, release/periodic check names,
status, rollback status, and stable failure codes. Construct a new object field
by field; never spread arbitrary input into the serialized report.

- [ ] **Step 4: Write release-probe tests**

Inject `fetch`, `readFile`, and `now`. Cover:

- health 200 with minimal service body;
- readiness 200 with PostgreSQL/Redis `ok`;
- SearXNG root 200/redirect;
- HMAC-SHA256 empty-event webhook 200 with `ok=true`, `ignored=true`;
- usable current and warning ClamAV manifests;
- timeout, HTTP mismatch, malformed JSON, invalid/future manifest, and network
  failure;
- no request to a DeepSeek or embedding endpoint.

- [ ] **Step 5: Run release-probe tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/release-probe.test.ts
```

Expected: FAIL because the probe is absent.

- [ ] **Step 6: Implement the release probe and CLI**

Use one bounded fetch per endpoint with `AbortSignal.timeout`. Reuse
`signLineBody` and `assessClamAvSignatureManifest`. Return only named check
statuses and signature age health. The CLI prints exactly one serialized
allowlisted result and sets a failing exit code when any required check fails.

- [ ] **Step 7: Add the empty-event entrance regression**

Build a signed `{"events":[]}` request and assert HTTP 200/ignored while LINE
reply creation, the controlled router, text generation, and function execution
remain untouched.

- [ ] **Step 8: Run focused tests and commit**

```bash
pnpm vitest run \
  src/__tests__/assurance-report.test.ts \
  src/__tests__/release-probe.test.ts \
  src/__tests__/entrance.test.ts
git add src/assurance src/tools/run-release-probe.ts src/__tests__
git commit -m "feat: add provider-free release probe"
```

### Task 2: Add The Weekly External Dependency Probe

**Files:**
- Create: `src/assurance/periodic-probe.ts`
- Create: `src/tools/run-periodic-assurance.ts`
- Create: `src/__tests__/periodic-assurance.test.ts`
- Modify: `src/clients/graph.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces:
  `runPeriodicAssurance(input: PeriodicAssuranceInput,
  dependencies: PeriodicAssuranceDependencies):
  Promise<PeriodicAssuranceResult>`
- Adds optional
  `ensureFolder?(driveId, parentItemId, name): Promise<DriveItem>` to
  `GraphDriveClient`.
- Runtime env includes existing Graph/Notion configuration,
  `ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING`,
  `CLAMAV_SIGNATURE_MANIFEST_PATH`, and
  `GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover exactly one bounded Graph metadata read, a one-result Notion read,
queue depth/oldest age, clean-file acceptance, EICAR rejection, diagnostics
folder ensure, fixed diagnostic upload, and deletion in `finally`. Verify
cleanup failure and every dependency failure produce stable codes without
returning private adapter errors.

- [ ] **Step 2: Run focused RED**

```bash
pnpm vitest run src/__tests__/periodic-assurance.test.ts
```

- [ ] **Step 3: Implement the pure orchestration**

The pure function receives narrow injected adapters. Generate only a constant
diagnostic payload and file name. Cap every provider operation to one call and
always attempt deletion after a successful upload.

- [ ] **Step 4: Add the real adapters and CLI**

Reuse `createGraphDriveClient`, add idempotent conflict-safe diagnostics-folder
creation, use the Notion SDK with `page_size: 1`, use `QueueClient` for
properties plus one peek, and reuse `scanWithClamAvCli` for clean/EICAR files.
Resolve the active immutable ClamAV database directory from its validated
manifest. Remove temporary files in `finally`.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  src/__tests__/periodic-assurance.test.ts \
  src/__tests__/graph.test.ts \
  src/__tests__/notion-client.test.ts \
  src/__tests__/clamav-cli.test.ts
git add src/assurance src/tools/run-periodic-assurance.ts \
  src/clients/graph.ts src/types.ts src/__tests__
git commit -m "feat: add bounded periodic assurance"
```

### Task 3: Define Finite Assurance Jobs

**Files:**
- Create: `aca.release-probe-job.yaml`
- Create: `aca.periodic-assurance-job.yaml`
- Modify: `scripts/deploy-aca.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**
- Release Job name: `hhc-line-bot-release-probe`
- Periodic Job name: `hhc-line-bot-periodic-assurance`
- Both are Manual, one replica, retry limit zero, no ingress, 0.25 CPU /
  0.5 GiB, user-assigned ACR identity, immutable release image.

- [ ] **Step 1: Add failing manifest contract assertions**

Assert trigger/resources/retry/timeout, exact tool arguments, secret refs,
read-only signature mount, immutable image rendering, no ingress, and absence
of DeepSeek/Azure embedding configuration. Assert release workflow path
triggers include both manifests.

- [ ] **Step 2: Run the deployment contract test and verify RED**

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

- [ ] **Step 3: Create the two manifests**

The release job receives only release-probe inputs and the LINE channel secret.
The periodic job uses the scan image, Graph/Notion/queue secrets, bounded normal
env values, and the read-only signature mount. Neither job has a schedule in
ACA; GitHub owns the weekly trigger.

- [ ] **Step 4: Extend rendering/deployment**

Add the two job names as required deployment environment variables. Extend the
existing strict manifest renderer with explicit base URL/Gateway placeholders.
Deploy both Jobs before assurance. Do not print secret-bearing rendered YAML.

- [ ] **Step 5: Wire immutable artifact upload**

Set `RELEASE_REPORT_PATH` and upload `artifacts/release-assurance/**` with
`if: always()` after deployment. Keep Production Release free of pnpm/provider
evals.

- [ ] **Step 6: Run focused tests and commit**

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
bash -n scripts/deploy-aca.sh
git add aca.*assurance-job.yaml aca.release-probe-job.yaml \
  scripts/deploy-aca.sh .github/workflows/release.yml \
  src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "deploy: define finite assurance jobs"
```

### Task 4: Make Deployment A Recoverable Release Transaction

**Files:**
- Create: `scripts/release-assurance.sh`
- Create: `src/__tests__/release-assurance-script.test.ts`
- Modify: `scripts/deploy-aca.sh`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**
- `capture_known_good_state`
- `mark_release_mutated`
- `run_release_gates`
- `restore_known_good_revision`
- `write_release_report`
- Stable shell failure codes are mapped to the TypeScript report vocabulary.

- [ ] **Step 1: Build a fake-Azure shell harness**

The test creates temporary `az` and command shims plus fixture state. Cover:

- successful snapshot/gates/report;
- failure before mutation without rollback;
- target/image/traffic/ingress/Dapr mismatch;
- release probe failure;
- SearXNG definition failure;
- catalog definition or no recent success;
- refresh/scan definition failure;
- deliberate gate failure followed by
  `revision copy --from-revision <recorded>`;
- restored image verification;
- rollback failure;
- report field allowlist and absence of fixture secrets/FQDN/body;
- no chat-completion, embedding, catalog-start, or non-empty webhook call.

- [ ] **Step 2: Run shell behavior tests and verify RED**

```bash
pnpm vitest run src/__tests__/release-assurance-script.test.ts
```

- [ ] **Step 3: Implement bounded transaction helpers**

Snapshot the ready revision/image and deployed job images before bot mutation.
Use exact JSON queries. Write reports through a fixed Python/Node serializer,
not shell interpolation of arbitrary responses.

On failure after mutation, copy the known-good bot revision, wait a maximum of
30 attempts, verify the new rollback revision carries the recorded image, and
restore only Jobs whose image was changed by this release. Preserve the
original failure code if rollback also fails.

- [ ] **Step 4: Add all required live gates**

Validate bot revision/image/traffic/internal ingress/Dapr; SearXNG
ready/internal/resources; current release probe execution; current ClamAV
bootstrap success; scan/catalog/live job definitions; and a successful catalog
execution no older than 30 minutes. Never manually start catalog sync.

- [ ] **Step 5: Integrate the EXIT trap**

Install the trap before the first bot mutation, mark mutation immediately before
the bot apply, clear rollback only after the report is durably written, and
preserve the original non-zero exit status.

- [ ] **Step 6: Run focused tests and commit**

```bash
pnpm vitest run \
  src/__tests__/release-assurance-script.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts
bash -n scripts/release-assurance.sh
bash -n scripts/deploy-aca.sh
git add scripts src/__tests__
git commit -m "deploy: make releases recoverable"
```

### Task 5: Automate Weekly Assurance

**Files:**
- Create: `.github/workflows/periodic-assurance.yml`
- Create: `scripts/run-periodic-assurance.sh`
- Create: `src/__tests__/periodic-assurance-script.test.ts`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**
- Cron: `30 20 * * 1`
- Manual dispatch supported.
- Output:
  `artifacts/release-assurance/periodic-report.json`

- [ ] **Step 1: Write workflow/shell contract tests**

Use fake Azure state to verify one job start, bounded execution polling, recent
scan-execution observation, passed/failed allowlisted report, no traffic
mutation, no retry of the job, OIDC-only auth, and artifact upload on failure.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run \
  src/__tests__/periodic-assurance-script.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts
```

- [ ] **Step 3: Implement the periodic runner and workflow**

The shell script starts the already deployed immutable Manual Job, polls its
single execution, observes recent attachment-scan control-plane state, and
writes a fixed report. The workflow uses the existing Azure OIDC variables and
uploads the report with `if: always()`.

- [ ] **Step 4: Run focused tests and commit**

```bash
pnpm vitest run \
  src/__tests__/periodic-assurance-script.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts
bash -n scripts/run-periodic-assurance.sh
git add .github/workflows/periodic-assurance.yml \
  scripts/run-periodic-assurance.sh src/__tests__
git commit -m "ops: schedule weekly production assurance"
```

### Task 6: Align Operations And Close The Roadmap

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture-context.md`
- Modify: `docs/runbooks/production-operations.md`
- Modify:
  `docs/superpowers/specs/2026-07-26-single-church-optimization-roadmap-design.md`
- Modify: `src/__tests__/modular-monolith-docs.test.ts`

**Interfaces:**
- Documents name R5.0 as the final milestone.
- Documentation distinguishes deterministic rollback proof, production release
  acceptance, weekly dependency assurance, and natural LINE delivery evidence.

- [ ] **Step 1: Add failing documentation assertions**

Require:

- R4.1 production verification complete;
- R5.0 implementation/acceptance language;
- Stable Maintenance as the only successor;
- exact release/periodic job names and report paths;
- copy-based rollback wording for single revision mode;
- zero provider release smoke;
- signed empty-event limitation;
- no R5.1/R5.2/SaaS/local-model follow-up.

- [ ] **Step 2: Update the documents**

Replace the manual image-only rollback procedure with the automated transaction
and a bounded emergency fallback. Document report fields, failure codes,
operator actions, periodic checks, and the fact that release smoke does not
prove LINE delivery/reply-token behavior.

- [ ] **Step 3: Run docs tests and commit**

```bash
pnpm vitest run src/__tests__/modular-monolith-docs.test.ts
git add README.md AGENTS.md docs src/__tests__/modular-monolith-docs.test.ts
git commit -m "docs: enter stable maintenance after R5"
```

### Task 7: Complete Review, Delivery, And Production Acceptance

**Files:**
- Modify only files required by review findings.

- [ ] **Step 1: Run all local gates**

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm test
pnpm config:validate
pnpm eval:agent
pnpm eval:admin
pnpm eval:retrieval-product
pnpm eval:kernel
KERNEL_DOCKER_COMMAND=docker.exe pnpm eval:kernel:integration
pnpm build
bash -n scripts/deploy-aca.sh
bash -n scripts/release-assurance.sh
bash -n scripts/run-periodic-assurance.sh
git diff --check
```

Expected: every gate passes, integration owns and removes its dependencies, and
no live provider suite runs.

- [ ] **Step 2: Review the full branch**

Review security/privacy, rollback completeness, job image consistency,
single-revision semantics, allowlisted reports, provider-free release behavior,
bounded polling, and docs. Fix every Critical/Important finding and rerun the
affected plus full gates.

- [ ] **Step 3: Open PR and wait for required CI**

Push the `codex/r5-lean-release-assurance` branch, open a PR to protected
`main`, monitor `PR CI`, and enable squash auto-merge because the user
explicitly authorized deployment through R5.0.

- [ ] **Step 4: Monitor Production Release**

Require a successful immutable build/deployment, passed release report artifact,
and zero provider request counts. If it fails, verify the report proves
known-good retention/restoration before fixing through a new reviewed PR.

- [ ] **Step 5: Run first periodic production acceptance**

Manually dispatch `Periodic Assurance` once. Require a successful job execution
and passed artifact. Do not retry the provider operations; diagnose and fix a
real failure through reviewed code/config.

- [ ] **Step 6: Independently verify live state**

Read current Azure state and verify the target revision/image, 100 percent
traffic, internal ingress, Dapr, signed empty webhook, SearXNG resources,
catalog recent success, ClamAV refresh/manifest, scan definition, and both
assurance Jobs. Query sanitized Log Analytics for startup/migration failures.

- [ ] **Step 7: Final closure**

Fast-forward local `main`, remove the clean R5 worktree and local branch, and
confirm local/remote `main` alignment. Report that R5.0 is complete and the
roadmap is now Stable Maintenance; do not propose R5.1 or R5.2.

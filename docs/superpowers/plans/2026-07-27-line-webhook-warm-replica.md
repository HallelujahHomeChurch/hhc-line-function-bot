# LINE Webhook Warm Replica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one production LINE webhook bot replica warm so the first message after inactivity does not hit ACA scale-from-zero latency.

**Architecture:** The bot remains the same internal-ingress Dapr-enabled ACA Container App, but its manifest minimum changes from zero to one replica. Deployment-contract and documentation-contract tests make that latency requirement durable; SearXNG and finite ClamAV jobs remain unchanged.

**Tech Stack:** Azure Container Apps YAML, TypeScript, Vitest, pnpm, GitHub Actions

## Global Constraints

- Bot scale must be exactly `minReplicas: 1` and `maxReplicas: 10`.
- Bot resources remain exactly `0.5 CPU / 1 GiB`.
- SearXNG remains `minReplicas: 1`, `maxReplicas: 1`, `0.25 CPU / 0.5 GiB`.
- Attachment scanning and ClamAV refresh remain finite ACA Jobs.
- No DeepSeek or Azure embedding request may be used by release acceptance.
- Production deployment must use a reviewed pull request and GitHub Actions.

---

### Task 1: Enforce And Implement The Warm Bot Replica

**Files:**

- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`
- Modify: `aca.containerapp.yaml`

**Interfaces:**

- Consumes: the checked-in ACA bot manifest contract.
- Produces: a manifest whose bot scale block is exactly one minimum and ten maximum replicas.

- [ ] **Step 1: Write the failing deployment-contract assertion**

Replace the broad minimum/maximum checks with:

```ts
expect(manifest).toContain("scale:\n      minReplicas: 1\n      maxReplicas: 10");
```

Keep the existing Dapr, ingress, probe, resource, secret-reference, and rendered
manifest assertions unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: FAIL because `aca.containerapp.yaml` still contains
`minReplicas: 0`.

- [ ] **Step 3: Implement the minimal manifest change**

Change only the bot scale block:

```yaml
scale:
  minReplicas: 1
  maxReplicas: 10
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit the deployment contract**

```bash
git add aca.containerapp.yaml src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "Keep LINE webhook replica warm"
```

### Task 2: Record The Operational Contract

**Files:**

- Modify: `src/__tests__/modular-monolith-docs.test.ts`
- Modify: `docs/runbooks/production-operations.md`
- Modify: `docs/superpowers/specs/2026-07-27-line-webhook-warm-replica-design.md`

**Interfaces:**

- Consumes: the manifest contract from Task 1.
- Produces: operator guidance that distinguishes the always-warm webhook service from finite jobs.

- [ ] **Step 1: Write the failing documentation assertion**

In the R5.0 documentation test, add:

```ts
expect(operations).toContain("The LINE webhook Container App keeps `minReplicas: 1`");
expect(operations).toContain("Attachment scanning and ClamAV refresh remain finite ACA Jobs");
```

- [ ] **Step 2: Run the focused documentation test and verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/modular-monolith-docs.test.ts
```

Expected: FAIL because the operations runbook does not yet contain the warm
replica contract.

- [ ] **Step 3: Update the runbook and accepted spec status**

Add this paragraph to the production deployment section:

```markdown
The LINE webhook Container App keeps `minReplicas: 1` because LINE delivery is
latency-sensitive and must not wait for ACA scale-from-zero. It retains
`maxReplicas: 10` and `0.5 CPU / 1 GiB` per replica. Attachment scanning and
ClamAV refresh remain finite ACA Jobs because they are asynchronous and are not
part of the synchronous reply-token path.
```

Change the design status to:

```markdown
The user approved this specification on 2026-07-27. Implementation is
authorized.
```

- [ ] **Step 4: Run the focused documentation test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/__tests__/modular-monolith-docs.test.ts
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit the operational contract**

```bash
git add docs/runbooks/production-operations.md docs/superpowers/specs/2026-07-27-line-webhook-warm-replica-design.md src/__tests__/modular-monolith-docs.test.ts
git commit -m "Document warm LINE webhook capacity"
```

### Task 3: Validate, Review, Merge, And Verify Production

**Files:**

- Verify: all files changed by Tasks 1 and 2.
- No additional production file is expected.

**Interfaces:**

- Consumes: Tasks 1 and 2.
- Produces: a merged and deployed production contract with live evidence.

- [ ] **Step 1: Run all required local gates**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm test
pnpm build
pnpm config:validate
pnpm eval:agent
pnpm eval:kernel
git diff --check
```

Expected: every command exits zero; the complete Vitest suite has zero failed
tests.

- [ ] **Step 2: Review the final diff**

Verify:

```bash
git status --short
git diff origin/main...HEAD --check
git diff origin/main...HEAD -- aca.containerapp.yaml src/__tests__/profile-config-deployment-contract.test.ts src/__tests__/modular-monolith-docs.test.ts docs/runbooks/production-operations.md docs/superpowers/specs/2026-07-27-line-webhook-warm-replica-design.md
```

Expected: only the approved manifest, tests, runbook, spec, and this plan are
changed.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin codex/bot-warm-replica
```

Open a pull request into `main` titled `Keep LINE webhook replica warm`. Wait
for the required `PR CI` workflow to succeed.

- [ ] **Step 4: Squash merge and monitor Production Release**

After required CI succeeds, squash merge the pull request. Monitor the
post-merge `Production Release` workflow until it completes and download
`artifacts/release-assurance/report.json`.

Expected: release status `passed`, 15 checks passed, rollback
`not_required`, and:

```json
{
  "providerRequests": {
    "deepseek": 0,
    "embedding": 0
  }
}
```

- [ ] **Step 5: Verify the live ACA contract**

Run:

```bash
az containerapp show -g alive -n hhc-line-function-bot \
  --query '{minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName}' \
  -o json

az containerapp revision list -g alive -n hhc-line-function-bot \
  --query '[].{name:name,active:properties.active,health:properties.healthState,traffic:properties.trafficWeight}' \
  -o json

latest_revision=$(az containerapp show -g alive -n hhc-line-function-bot \
  --query properties.latestReadyRevisionName -o tsv)

az containerapp replica list -g alive -n hhc-line-function-bot \
  --revision "$latest_revision" \
  --query '[].{name:name,containers:properties.containers[].{name:name,running:runningState,restarts:restartCount}}' \
  -o json
```

Expected: minimum one, maximum ten, latest equals ready, the active revision is
healthy with 100 percent traffic, and at least one bot container is running.

- [ ] **Step 6: Verify a real LINE delivery observation**

After deployment, inspect sanitized Gateway and bot telemetry for the next
naturally occurring LINE webhook. Expected: Gateway HTTP 200 and a sanitized
route/completion event. Do not inspect raw messages and do not claim this step
from the signed empty release probe alone.

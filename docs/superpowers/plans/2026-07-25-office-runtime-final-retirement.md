# Office Runtime Final Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-size the Azure SearXNG service, schedule weekly ClamAV signature refreshes, conditionally remove the unused Hermes proxy, and remove only the retired HHC Docker, Ollama-model, and startup assets from the office workstation.

**Architecture:** The GitHub repository remains the source of truth for repeatable ACA configuration, so cloud resource changes go through PR CI and the main-branch production release before local fallbacks are removed. `hermes-line-proxy` has a fail-closed dependency gate: any active reference stops deletion and returns control to the user. Workstation cleanup resolves every exact Docker, Ollama, and Startup target immediately before deletion and preserves Docker Desktop auto-start plus the Ollama installation.

**Tech Stack:** TypeScript/Vitest deployment-contract tests, YAML Azure Container Apps manifests, Bash deployment scripts, GitHub Actions, Azure CLI, Docker Desktop CLI, Ollama CLI, Windows PowerShell.

## Global Constraints

- `hhc-searxng` must use exactly `0.25` CPU and `0.5Gi` memory, keep one replica, and remain internal-only.
- `hhc-line-bot-clamav-refresh` must run every Monday at 03:10 Asia/Taipei using UTC cron `10 19 * * 0`.
- Production semantic lanes remain DeepSeek-only; embeddings remain Azure OpenAI `text-embedding-3-small`.
- Production must not contain an Office-network address or an Ollama runtime dependency.
- Do not delete `hermes-line-proxy` if any live dependency is found; report the evidence and recommendation to the user first.
- Preserve Docker Desktop, its Windows Run auto-start entry, and the installed Ollama application.
- Never use Docker-wide prune commands or broad filesystem deletion.
- Delete only the exact containers, images, volumes, models, and Startup shortcuts named in the approved design.
- Never print Azure keys, connection strings, tokens, or secret values.
- `main` is protected: use a `codex/*` branch, pull request, required PR CI, merge, and GitHub Actions Production Release.

---

### Task 1: Encode The ACA Resource And Schedule Contract

**Files:**
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`
- Modify: `aca.searxng.containerapp.yaml`
- Modify: `aca.clamav-signature-refresh-job.yaml`
- Modify: `README.md`
- Modify: `docs/runbooks/production-operations.md`

**Interfaces:**
- Consumes: the existing release workflow, which renders and applies both ACA manifests.
- Produces: a repository contract that always deploys SearXNG at `0.25` CPU/`0.5Gi` and ClamAV refresh at `10 19 * * 0`.

- [ ] **Step 1: Change the deployment-contract assertions first**

In the SearXNG contract test, add exact resource assertions after the replica assertions:

```ts
expect(searxng).toContain("resources:");
expect(searxng).toContain("cpu: 0.25");
expect(searxng).toContain("memory: 0.5Gi");
```

In the ClamAV refresh contract test, replace:

```ts
expect(refreshJob).toContain('cronExpression: "10 19 */2 * *"');
```

with:

```ts
expect(refreshJob).toContain('cronExpression: "10 19 * * 0"');
```

- [ ] **Step 2: Run the focused test and confirm the new contract fails**

Run:

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: FAIL because the SearXNG manifest has no requested resource block and the ClamAV manifest still contains `10 19 */2 * *`.

- [ ] **Step 3: Apply the minimum manifest changes**

Add this block under the SearXNG container's existing environment block:

```yaml
        resources:
          cpu: 0.25
          memory: 0.5Gi
```

Change the ClamAV schedule to:

```yaml
    scheduleTriggerConfig:
      cronExpression: "10 19 * * 0"
      parallelism: 1
      replicaCompletionCount: 1
```

Do not change replica counts, ingress, images, identities, storage mounts, or scan-job resources.

- [ ] **Step 4: Update operator-facing schedule and resource documentation**

Change the ClamAV schedule statement in `README.md` from every two days to:

```markdown
`aca.clamav-signature-refresh-job.yaml` runs every Monday at `10 19 * * 0` UTC, which is 03:10 Monday in Asia/Taipei.
```

Add the same weekly schedule and the SearXNG `0.25` CPU/`0.5Gi` production allocation to the relevant SearXNG/ClamAV section of `docs/runbooks/production-operations.md`.

- [ ] **Step 5: Run the focused test and formatting check**

Run:

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
pnpm format:check
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit the configuration contract**

```bash
git add src/__tests__/profile-config-deployment-contract.test.ts \
  aca.searxng.containerapp.yaml \
  aca.clamav-signature-refresh-job.yaml \
  README.md \
  docs/runbooks/production-operations.md
git commit -m "ops: right-size SearXNG and schedule weekly ClamAV refresh"
```

---

### Task 2: Verify, Publish, And Deploy The Repository Changes

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `.github/workflows/release.yml`
- Verify: `scripts/deploy-aca.sh`
- Verify: all files changed on `codex/retire-office-local-runtime`

**Interfaces:**
- Consumes: Task 1's manifest and deployment-contract changes.
- Produces: a merged `main` commit and a successful Production Release that applies the requested ACA configuration.

- [ ] **Step 1: Run the complete local verification boundary**

Run each command separately and retain its exit status:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm eval:kernel
```

Expected: every command exits `0`. If any command fails, diagnose the first failure before continuing.

- [ ] **Step 2: Confirm the branch contains only approved files**

Run:

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the design, implementation plan, two ACA manifests, deployment-contract test, README, and runbook are present.

- [ ] **Step 3: Commit the implementation plan if it is not already committed**

```bash
git add docs/superpowers/plans/2026-07-25-office-runtime-final-retirement.md
git commit -m "docs: add office runtime retirement implementation plan"
```

Expected: one plan-only commit, or a clean no-op if the plan was committed before execution.

- [ ] **Step 4: Push the branch and create the pull request**

```bash
git push -u origin codex/retire-office-local-runtime
gh pr create \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  --base main \
  --head codex/retire-office-local-runtime \
  --title "Right-size cloud runtime and finish office retirement" \
  --body "Sets SearXNG to 0.25 CPU/0.5Gi, schedules weekly ClamAV refresh at Monday 03:10 Asia/Taipei, and documents the guarded office-runtime cleanup."
```

Expected: an open PR targeting `main`.

- [ ] **Step 5: Wait for required PR CI**

Run:

```bash
gh pr checks \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  codex/retire-office-local-runtime \
  --watch
```

Expected: required `PR CI` concludes `SUCCESS`.

- [ ] **Step 6: Merge through the protected branch and wait for production release**

Because the user explicitly approved deployment, run:

```bash
gh pr merge \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  codex/retire-office-local-runtime \
  --squash \
  --auto
```

After GitHub reports the PR merged, locate the Production Release whose `headSha` equals the merge commit:

```bash
merge_sha="$(gh pr view \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  codex/retire-office-local-runtime \
  --json mergeCommit \
  --jq '.mergeCommit.oid')"
release_run_id="$(gh run list \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  --workflow "Production Release" \
  --limit 10 \
  --json databaseId,headSha \
  --jq ".[] | select(.headSha == \"${merge_sha}\") | .databaseId" |
  head -n 1)"
test -n "${release_run_id}"
```

Wait on the resolved exact run:

```bash
gh run watch "${release_run_id}" \
  --repo HallelujahHomeChurch/hhc-line-function-bot \
  --exit-status
```

Expected: Production Release concludes `success`.

---

### Task 3: Verify Cloud State And Apply The Hermes Dependency Gate

**Files:**
- Inspect: active repository files and GitHub workflows
- Inspect: Azure resource group `alive`
- Delete conditionally: `alive/Microsoft.App/containerApps/hermes-line-proxy`

**Interfaces:**
- Consumes: Task 2's successful production release.
- Produces: verified ACA runtime state and either a safely deleted Hermes proxy or a user-visible dependency report with no deletion.

- [ ] **Step 1: Verify the deployed SearXNG and ClamAV configuration**

Run Azure CLI read-only queries and report only non-secret fields:

```bash
az containerapp show \
  --resource-group alive \
  --name hhc-searxng \
  --query '{provisioning:properties.provisioningState,running:properties.runningStatus,external:properties.configuration.ingress.external,cpu:properties.template.containers[0].resources.cpu,memory:properties.template.containers[0].resources.memory,minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,revision:properties.latestReadyRevisionName}' \
  --output json

az containerapp job show \
  --resource-group alive \
  --name hhc-line-bot-clamav-refresh \
  --query '{provisioning:properties.provisioningState,trigger:properties.configuration.triggerType,cron:properties.configuration.scheduleTriggerConfig.cronExpression}' \
  --output json
```

Expected: SearXNG is `Succeeded`/`Running`, `external=false`, CPU `0.25`, memory `0.5Gi`, and one replica; ClamAV is `Succeeded`, `Schedule`, and `10 19 * * 0`.

- [ ] **Step 2: Verify the bot has no Office or Ollama dependency**

Fetch the Container App JSON, inspect only environment names and non-secret values, and assert:

- no environment name starts with `OLLAMA_`;
- no non-secret value contains `172.16.65.5`;
- `SEARXNG_BASE_URL` points to the internal `hhc-searxng` FQDN;
- `EMBEDDING_PROVIDER=azure_openai`;
- every helper profile lane in `config/profiles.json` is DeepSeek-only.

Also verify:

```bash
az containerapp show \
  --resource-group alive \
  --name hhc-line-function-bot \
  --query '{external:properties.configuration.ingress.external,dapr:properties.configuration.dapr,revision:properties.latestReadyRevisionName,image:properties.template.containers[0].image}' \
  --output json
```

Expected: internal ingress and Dapr `enabled=true`, `appId=hhc-line-function-bot`, `appPort=3000`, `appProtocol=http`.

- [ ] **Step 3: Search active source and workflow dependencies on Hermes**

Run:

```bash
rg -n -i 'hermes-line-proxy|hermes.*proxy' \
  AGENTS.md README.md config infra scripts src .github aca*.yaml Dockerfile package.json
```

Expected: no active application, deployment, workflow, or gateway reference. Historical design documents are not executable dependencies.

- [ ] **Step 4: Search Azure Container Apps environment and Dapr references**

Retrieve every Container App in `alive` as JSON. Inspect only:

- app names;
- environment variable names and non-secret values;
- ingress FQDNs;
- Dapr app IDs;
- image names.

Search those allowlisted fields case-insensitively for:

```text
hermes-line-proxy
hermes-line-proxy.gentleriver-81abd7bc.eastasia.azurecontainerapps.io
```

List Dapr components for the managed environment and inspect component names plus non-secret app scopes for the same identifiers. Do not print secret metadata values.

Expected: no references outside the target app itself.

- [ ] **Step 5: Inspect the deployed API Gateway routing configuration**

Enter the currently ready `api-gateway` replica with Azure Container Apps exec and search `/etc/nginx` for `hermes`, `hermes-line-proxy`, and its FQDN:

```bash
az containerapp exec \
  --resource-group alive \
  --name api-gateway \
  --command "sh -lc 'grep -RniE \"hermes|hermes-line-proxy\" /etc/nginx 2>/dev/null || true'"
```

Expected: no matching route or upstream.

- [ ] **Step 6: Enforce the dependency decision**

If Steps 3–5 produce any live reference:

1. Do not run a delete command.
2. Report the exact dependency location without secret values.
3. Explain whether it should be migrated, removed, or retained.
4. Ask the user for a decision and pause this task.

If no live reference exists, resolve the exact target once more:

```bash
az containerapp show \
  --resource-group alive \
  --name hermes-line-proxy \
  --query '{id:id,name:name,type:type,provisioning:properties.provisioningState}' \
  --output json
```

Proceed only when the ID equals:

```text
/subscriptions/3765a72c-2c30-492c-8b88-7a26522903f8/resourceGroups/alive/providers/Microsoft.App/containerapps/hermes-line-proxy
```

- [ ] **Step 7: Delete only the approved Hermes Container App and verify absence**

```bash
az containerapp delete \
  --resource-group alive \
  --name hermes-line-proxy \
  --yes

az containerapp show \
  --resource-group alive \
  --name hermes-line-proxy \
  --output none
```

Expected: delete succeeds, then `show` returns a resource-not-found error. Re-query `api-gateway`, `hhc-line-function-bot`, and `hhc-searxng`; each must remain `Succeeded` and `Running`.

---

### Task 4: Remove The Exact Office Docker And Ollama Assets

**Files:**
- Remove to Windows Recycle Bin: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HHC Line Bot Local Services.lnk`
- Remove to Windows Recycle Bin: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Ollama.lnk`
- Preserve: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Docker Desktop`
- Preserve: `%LOCALAPPDATA%\Programs\Ollama`

**Interfaces:**
- Consumes: Task 3's known-good Azure replacement services.
- Produces: an office workstation with no retired HHC containers, images, volumes, models, or startup shortcuts.

- [ ] **Step 1: Resolve the exact Docker objects immediately before deletion**

Using `C:\Program Files\Docker\Docker\resources\bin\docker.exe`, inspect:

```text
container: hhc-searxng
container: hhc-clamav
image: searxng/searxng:latest
image: clamav/clamav:stable
volume: local-services_searxng-cache
volume: local-services_clamav-db
```

For each image, list all containers that use its image ID. Continue only when the list contains no container other than its approved HHC container. Record names, IDs, and status, but no environment values.

- [ ] **Step 2: Remove the two exact containers**

Run:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' container rm --force hhc-searxng
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' container rm --force hhc-clamav
```

Expected: each command returns only the deleted container name.

- [ ] **Step 3: Remove the two exact volumes**

Run:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' volume rm local-services_searxng-cache
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' volume rm local-services_clamav-db
```

Expected: each command returns only the deleted volume name.

- [ ] **Step 4: Remove the two exact images**

Run:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' image rm searxng/searxng:latest
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' image rm clamav/clamav:stable
```

Expected: both named tags and their now-unused image layers are removed. Do not add `--force`; an unexpected reference must fail closed.

- [ ] **Step 5: Resolve and remove only the two Ollama models**

Run:

```powershell
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" list
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" rm bge-m3:latest
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" rm qwen3:4b-instruct
```

Expected: the first command shows exactly the two approved model names in scope; each removal reports success. Do not remove the Ollama application directory.

- [ ] **Step 6: Move only the two startup shortcuts to the Recycle Bin**

Use PowerShell's recoverable Recycle Bin operation:

```powershell
Add-Type -AssemblyName Microsoft.VisualBasic
$startup = [Environment]::GetFolderPath('Startup')
foreach ($name in @('HHC Line Bot Local Services.lnk', 'Ollama.lnk')) {
  $path = Join-Path $startup $name
  if (Test-Path -LiteralPath $path) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
      $path,
      'OnlyErrorDialogs',
      'SendToRecycleBin'
    )
  }
}
```

Expected: only the two named shortcuts leave the Startup folder and remain recoverable from the Recycle Bin.

- [ ] **Step 7: Verify the preserved local software and auto-start**

Verify:

```powershell
Test-Path 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
  Select-Object -ExpandProperty 'Docker Desktop'
```

Expected: both executables exist and the Docker Desktop Run entry still resolves to Docker Desktop.

---

### Task 5: Run The Final Cross-Boundary Verification

**Files:**
- Verify: repository and GitHub Actions state
- Verify: Azure resource group `alive`
- Verify: office Docker, Ollama, Startup, and Run state

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: fresh evidence that the cloud runtime is healthy and the office runtime is retired without unrelated deletion.

- [ ] **Step 1: Verify local retired assets are absent**

Query exact names:

```powershell
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' ps -a --format '{{.Names}}'
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' images --format '{{.Repository}}:{{.Tag}}'
& 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' volume ls --format '{{.Name}}'
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" list
Get-ChildItem ([Environment]::GetFolderPath('Startup')) | Select-Object -ExpandProperty Name
```

Expected: none of the two retired container names, image tags, volume names, model names, or shortcut names appears.

- [ ] **Step 2: Verify local preserved assets remain**

Re-run the executable and Docker Desktop Run-entry checks from Task 4 Step 7.

Expected: Docker Desktop, its auto-start entry, and Ollama remain installed.

- [ ] **Step 3: Verify Azure workloads and the Hermes outcome**

Freshly query:

- `hhc-line-function-bot`;
- `hhc-searxng`;
- `hhc-line-bot-clamav-refresh`;
- `hhc-line-bot-attachment-scan`;
- `hhc-line-bot-catalog-sync`.

Expected: every retained resource is provisioned successfully; running apps are `Running`; SearXNG has the requested allocation; ClamAV has the weekly cron. If the dependency gate passed, `hermes-line-proxy` is absent. If it was blocked, its unchanged presence is reported together with the pending user decision.

- [ ] **Step 4: Verify the Azure embedding API without exposing its key**

Read the existing Azure account key into a shell variable, call:

```text
https://bible-text-embedding-resource.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21
```

Send one synthetic verification string. Print only HTTP status, returned model, vector count, and vector dimension; unset the key immediately.

Expected: HTTP `200`, model `text-embedding-3-small`, one vector, dimension `1536`.

- [ ] **Step 5: Verify the public webhook path**

Resolve the `api-gateway` FQDN and POST unsigned JSON `{}` to:

```text
/api/line/webhook/helper
```

Expected: HTTP `400` with the exact body:

```json
{"ok":false,"error":"missing_line_signature"}
```

- [ ] **Step 6: Report the completed and preserved scope**

Report:

- PR and Production Release links;
- deployed SearXNG allocation and ClamAV schedule;
- Hermes deleted or dependency-blocked outcome;
- exact local HHC assets removed;
- Docker Desktop auto-start and Ollama installation preserved;
- embedding and webhook probe results;
- confirmation that no secrets were printed or committed.

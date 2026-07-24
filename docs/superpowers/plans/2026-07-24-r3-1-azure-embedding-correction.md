# R3.1 Azure Embedding Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the direct OpenAI embedding connection with the existing
Azure AI Services `text-embedding-3-small` deployment, then complete PR CI and
the R3.1 production release.

**Architecture:** A focused Azure OpenAI embedding adapter owns the
deployment-specific REST route and `api-key` authentication. Runtime
configuration exposes only the fixed Azure provider contract. The release
script verifies the existing Bible Azure AI resource, copies an account key
directly into workload-scoped Container App secrets, updates both the bot and
catalog-sync job, and fails before traffic movement when preflight fails.

**Tech Stack:** TypeScript 5.9, Node.js 24, Fastify, Vitest, Azure CLI, Azure
AI Services, Azure Container Apps, GitHub Actions, PostgreSQL/pgvector.

## Global Constraints

- Reuse resource group `alive`, account `bible-text-embedding-resource`, and
  deployment `text-embedding-3-small` in Japan East.
- Use Azure OpenAI REST API version `2024-10-21`, the Azure `api-key` header,
  and native 1536-dimensional vectors.
- Never call `api.openai.com`, rotate either shared Azure account key, print a
  key, write a key to disk, or commit a key.
- Keep the current 1536-dimensional pgvector migration and snapshot identity
  rules; do not add another dimension migration or model fallback.
- Preserve the queue-SAS fix already present in PR #17.
- Keep `main` protected: merge only through PR #17 after required PR CI passes.
- Merging is a production deployment action and is authorized by the user's
  request to complete R3.1 including deployment.

---

### Task 1: Azure OpenAI Embedding Adapter and Configuration

**Files:**

- Create: `src/clients/azure-openai-embedding.ts`
- Create: `src/__tests__/azure-openai-embedding.test.ts`
- Delete: `src/clients/openai-embedding.ts`
- Delete: `src/__tests__/openai-embedding.test.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/tools/rebuild-knowledge-embeddings.ts`
- Modify: `src/tools/sync-catalog.ts`
- Modify: `src/__tests__/config.test.ts`

**Interfaces:**

- Produces:
  `createAzureOpenAiEmbeddingClient(options: AzureOpenAiEmbeddingOptions): EmbeddingClient`.
- `AzureOpenAiEmbeddingOptions` contains `apiKey`, `endpoint`, `deployment`,
  `apiVersion`, `model`, `dimensions`, `timeoutMs`, and optional `fetchImpl`.
- `KnowledgeConfig.embedding.provider` becomes the literal `azure_openai`.
- Runtime environment consumes `EMBEDDING_PROVIDER`,
  `AZURE_OPENAI_EMBEDDING_ENDPOINT`,
  `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`,
  `AZURE_OPENAI_EMBEDDING_API_VERSION`,
  `AZURE_OPENAI_EMBEDDING_API_KEY`, and `EMBEDDING_MODEL`.

- [ ] **Step 1: Write failing adapter tests**

Create `src/__tests__/azure-openai-embedding.test.ts` by retaining the existing
response ordering, dimension, status, timeout, malformed-response, and
non-finite-number cases, then change the construction and request assertion to:

```ts
const options = (fetchImpl?: typeof fetch) => ({
  apiKey: "azure-test-key",
  endpoint: "https://bible-text-embedding-resource.cognitiveservices.azure.com/",
  deployment: "text-embedding-3-small",
  apiVersion: "2024-10-21",
  model: "text-embedding-3-small",
  dimensions: 1536 as const,
  timeoutMs: 1000,
  ...(fetchImpl ? { fetchImpl } : {})
});

expect(fetchImpl).toHaveBeenCalledWith(
  "https://bible-text-embedding-resource.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21",
  expect.objectContaining({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": "azure-test-key"
    },
    body: JSON.stringify({
      input: ["first", "second"],
      encoding_format: "float"
    })
  })
);
```

Add construction cases that reject a missing key, `https://api.openai.com/v1`,
an HTTP endpoint, an unsupported deployment, an unsupported API version, an
unsupported model, and a dimension other than 1536.

- [ ] **Step 2: Run the adapter test and verify the missing module failure**

Run:

```bash
pnpm test -- src/__tests__/azure-openai-embedding.test.ts
```

Expected: FAIL because `../clients/azure-openai-embedding.js` does not exist.

- [ ] **Step 3: Implement the Azure adapter**

Move the response validation logic from `openai-embedding.ts` into
`azure-openai-embedding.ts`. Export these fixed constants:

```ts
export const AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "text-embedding-3-small";
export const AZURE_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const AZURE_OPENAI_EMBEDDING_API_VERSION = "2024-10-21";
export const AZURE_OPENAI_EMBEDDING_DIMENSIONS = 1536;
```

Normalize the endpoint with `new URL`, require HTTPS, and accept only hosts
ending in `.cognitiveservices.azure.com` or `.openai.azure.com`. Construct the
route with `encodeURIComponent(options.deployment)` and
`URLSearchParams({ "api-version": options.apiVersion })`. Send `api-key`
instead of `Authorization`, omit the body-level model because the Azure
deployment selects it, and preserve bounded errors:
`embedding_missing_api_key`, `embedding_endpoint_unsupported`,
`embedding_deployment_unsupported`, `embedding_api_version_unsupported`,
`embedding_model_unsupported`, `embedding_dimension_unsupported`,
`embedding_http_<status>`, `embedding_response_invalid`,
`embedding_dimension_mismatch`, and `embedding_timeout`.

- [ ] **Step 4: Run the adapter test and verify it passes**

Run:

```bash
pnpm test -- src/__tests__/azure-openai-embedding.test.ts
```

Expected: all Azure adapter cases PASS.

- [ ] **Step 5: Write failing configuration tests**

Replace the direct-OpenAI configuration cases in `src/__tests__/config.test.ts`
with the exact environment:

```ts
{
  EMBEDDING_PROVIDER: "azure_openai",
  AZURE_OPENAI_EMBEDDING_API_KEY: "azure-secret",
  AZURE_OPENAI_EMBEDDING_ENDPOINT:
    "https://bible-text-embedding-resource.cognitiveservices.azure.com/",
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
  AZURE_OPENAI_EMBEDDING_API_VERSION: "2024-10-21",
  EMBEDDING_MODEL: "text-embedding-3-small"
}
```

Assert the parsed configuration has provider `azure_openai`, the normalized
endpoint, deployment, API version, fixed model, 1536 dimensions, batch size 16,
and timeout 30000. Add rejection cases for a missing Azure key, any provider
other than `azure_openai`, `api.openai.com`, an unsupported deployment/API
version/model, `EMBEDDING_DIMENSIONS`, and every retired `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, or `OPENAI_EMBEDDING_MODEL` value.

- [ ] **Step 6: Run configuration tests and verify they fail**

Run:

```bash
pnpm test -- src/__tests__/config.test.ts
```

Expected: FAIL because configuration still reads the direct OpenAI variables.

- [ ] **Step 7: Implement configuration and wire every entry point**

Update `KnowledgeConfig` to:

```ts
embedding: {
  provider: "azure_openai";
  apiKey: string;
  endpoint: string;
  deployment: "text-embedding-3-small";
  apiVersion: "2024-10-21";
  model: "text-embedding-3-small";
  dimensions: 1536;
  batchSize: number;
  timeoutMs: number;
}
```

Make `readKnowledgeEmbeddingConfig` reject retired direct-OpenAI variables and
require the exact Azure provider/deployment/version/model contract whenever
`NOTION_TOKEN` enables knowledge. Replace
`createOpenAiEmbeddingClient` imports and calls in `src/index.ts`,
`src/tools/rebuild-knowledge-embeddings.ts`, and `src/tools/sync-catalog.ts`
with `createAzureOpenAiEmbeddingClient`, passing `endpoint`, `deployment`, and
`apiVersion`.

- [ ] **Step 8: Run focused tests, typecheck, and commit**

Run:

```bash
pnpm test -- src/__tests__/azure-openai-embedding.test.ts src/__tests__/config.test.ts
pnpm typecheck
```

Expected: both test files PASS and TypeScript exits zero.

Commit:

```bash
git add src/clients src/config.ts src/types.ts src/index.ts src/tools \
  src/__tests__/azure-openai-embedding.test.ts src/__tests__/config.test.ts
git commit -m "feat: use Azure OpenAI embeddings"
```

### Task 2: Azure Resource Preflight and Container App Secret Wiring

**Files:**

- Modify: `scripts/deploy-aca.sh`
- Modify: `aca.containerapp.yaml`
- Modify: `aca.catalog-sync-job.yaml`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**

- Consumes the Task 1 environment contract.
- Produces workload secret `azure-openai-embedding-key`.
- Uses resource `bible-text-embedding-resource`, deployment
  `text-embedding-3-small`, and endpoint resolved from Azure.

- [ ] **Step 1: Write failing deployment-contract assertions**

Require `scripts/deploy-aca.sh` to contain:

```ts
expect(deployment).toContain("AZURE_OPENAI_EMBEDDING_RESOURCE_NAME:=bible-text-embedding-resource");
expect(deployment).toContain("az cognitiveservices account deployment list");
expect(deployment).toContain("az cognitiveservices account keys list");
expect(deployment).toContain('"azure-openai-embedding-key=${azure_openai_embedding_key}"');
expect(deployment).toContain(
  '"AZURE_OPENAI_EMBEDDING_API_KEY=secretref:azure-openai-embedding-key"'
);
expect(deployment).not.toContain("https://api.openai.com");
expect(deployment).toContain("legacy_openai_embedding_secret");
```

Require both ACA manifests to use the Task 1 Azure settings and prohibit
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, and
`openai-api-key`. Require the catalog job to copy
`azure-openai-embedding-key` from the bot secret set.

- [ ] **Step 2: Run the deployment-contract test and verify it fails**

Run:

```bash
pnpm test -- src/__tests__/profile-config-deployment-contract.test.ts
```

Expected: FAIL on missing Azure resource preflight and Azure secret wiring.

- [ ] **Step 3: Implement safe Azure preflight and secret installation**

Add fixed defaults near the release script inputs:

```bash
: "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME:=bible-text-embedding-resource}"
: "${AZURE_OPENAI_EMBEDDING_DEPLOYMENT:=text-embedding-3-small}"
: "${AZURE_OPENAI_EMBEDDING_API_VERSION:=2024-10-21}"
```

Before the required bot-secret check, resolve the account endpoint with
`az cognitiveservices account show`, verify the deployment's model and
provisioning state with `az cognitiveservices account deployment list`, and
capture one key with:

```bash
azure_openai_embedding_key="$(az cognitiveservices account keys list \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AZURE_OPENAI_EMBEDDING_RESOURCE_NAME}" \
  --query key1 \
  --output tsv \
  --only-show-errors)"
```

Fail on an empty endpoint/key or a deployment result other than
`text-embedding-3-small` plus `Succeeded`. Install the bot secret with
`az containerapp secret set --secrets
"azure-openai-embedding-key=${azure_openai_embedding_key}"`, then immediately
`unset azure_openai_embedding_key`.

Set the Task 1 environment variables in `update_args`, add the three retired
direct-OpenAI variable names to `retired_exact`, and remove any legacy
`openai-api-key` Container App secret only after the new revision and job
manifests no longer reference it.

- [ ] **Step 4: Update both ACA manifests**

Rename the bot and catalog-job secret entry to
`azure-openai-embedding-key`. Replace the three direct-OpenAI environment
entries with:

```yaml
- name: EMBEDDING_PROVIDER
  value: azure_openai
- name: AZURE_OPENAI_EMBEDDING_API_KEY
  secretRef: azure-openai-embedding-key
- name: AZURE_OPENAI_EMBEDDING_ENDPOINT
  value: https://bible-text-embedding-resource.cognitiveservices.azure.com/
- name: AZURE_OPENAI_EMBEDDING_DEPLOYMENT
  value: text-embedding-3-small
- name: AZURE_OPENAI_EMBEDDING_API_VERSION
  value: "2024-10-21"
- name: EMBEDDING_MODEL
  value: text-embedding-3-small
```

Keep the existing batch-size and timeout entries.

- [ ] **Step 5: Run deployment tests and shell syntax checks**

Run:

```bash
pnpm test -- src/__tests__/profile-config-deployment-contract.test.ts
bash -n scripts/deploy-aca.sh
```

Expected: deployment-contract tests PASS and shell syntax exits zero.

- [ ] **Step 6: Commit deployment wiring**

```bash
git add scripts/deploy-aca.sh aca.containerapp.yaml \
  aca.catalog-sync-job.yaml \
  src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "fix: provision Azure embedding credentials"
```

### Task 3: Provider Identity Fixtures and Operator Documentation

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/runbooks/production-operations.md`
- Modify: `docs/superpowers/specs/2026-07-24-remote-provider-local-runtime-retirement-design.md`
- Modify: `src/__tests__/knowledge-postgres-store.test.ts`
- Modify: `src/__tests__/knowledge-store.test.ts`
- Modify: `src/__tests__/knowledge-sync.test.ts`
- Modify: `src/__tests__/query-knowledge.test.ts`

**Interfaces:**

- Documentation and fixtures use `azure_openai` as the only embedding provider
  identity.
- Historical implementation plans remain historical records; the correction
  design is their explicit superseding decision.

- [ ] **Step 1: Change provider-identity fixtures**

Replace embedding provider fixture values `"openai"` with `"azure_openai"` in
the four listed test files. Do not change DeepSeek's OpenAI-compatible chat
protocol or unrelated prose.

- [ ] **Step 2: Replace operator configuration documentation**

Document the exact Task 1 variables in `.env.example`, `README.md`, and the
production runbook. Replace the runtime secret list entry `OPENAI_API_KEY` with
`AZURE_OPENAI_EMBEDDING_API_KEY`, state that production reuses the Bible Azure
AI Services resource, and state that deployment copies the account key without
printing or rotating it.

Correct `AGENTS.md` and the original R3.1 design so their active-product
description says Azure-hosted `text-embedding-3-small`, not direct OpenAI or
private Ollama. Link the original design to the correction design.

- [ ] **Step 3: Scan for forbidden active configuration and run focused tests**

Run:

```bash
rg -n "OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_EMBEDDING_MODEL|api\\.openai\\.com|provider: \"openai\"" \
  .env.example README.md AGENTS.md docs/runbooks src aca.containerapp.yaml \
  aca.catalog-sync-job.yaml scripts/deploy-aca.sh
pnpm test -- src/__tests__/knowledge-postgres-store.test.ts \
  src/__tests__/knowledge-store.test.ts \
  src/__tests__/knowledge-sync.test.ts \
  src/__tests__/query-knowledge.test.ts
```

Expected: the scan returns no active runtime/configuration occurrences outside
explicit historical correction context; all focused tests PASS.

- [ ] **Step 4: Commit documentation and fixture alignment**

```bash
git add .env.example README.md AGENTS.md docs src/__tests__
git commit -m "docs: align R3.1 with Azure embeddings"
```

### Task 4: Full Verification, PR Integration, and Production Release

**Files:**

- No planned source changes; failures are fixed in the owning task and committed
  separately.

**Interfaces:**

- Consumes Tasks 1–3 and the existing queue-SAS commit in PR #17.
- Produces a merged PR, successful release, healthy production revision, and
  verified gateway-to-Dapr webhook path.

- [ ] **Step 1: Run all repository gates**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm eval:agent
pnpm eval:kernel
```

Expected: every command exits zero. Do not run `eval:agent:live` unless a live
planner check is separately needed; embedding correctness is covered by the
Azure adapter and deployment tests.

- [ ] **Step 2: Review the complete PR diff**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree; only queue-SAS completion, Azure embedding correction,
tests, and aligned documentation are present.

- [ ] **Step 3: Push PR #17 and wait for required PR CI**

Push the branch, confirm PR #17 still targets `main`, and wait until the `PR CI`
check concludes `success`. If CI fails, inspect the failing step, reproduce it
locally, fix the owning contract, commit, push, and wait again.

- [ ] **Step 4: Merge through the protected branch**

Enable squash auto-merge on PR #17 only after CI passes. Confirm the PR becomes
`MERGED` and record the resulting `main` commit. Never push directly to `main`.

- [ ] **Step 5: Wait for the production release**

Follow `.github/workflows/release.yml` for the merge commit until it completes.
Confirm the release used resource `bible-text-embedding-resource`, did not emit
the key, created the workload secret, built the expected ACR image, updated the
catalog job, and made the new bot revision healthy.

- [ ] **Step 6: Verify production without exposing secrets**

Run read-only Azure checks that confirm:

- the latest and latest-ready revisions match;
- the bot is `Running` on the merge image;
- Dapr remains enabled with app ID `hhc-line-function-bot`, port 3000, HTTP;
- ingress remains internal;
- the environment contains the Azure embedding variable names and secret
  reference, but no direct-OpenAI variables;
- the catalog-sync job has the same provider identity and secret reference;
- public `/readyz` succeeds through the gateway-supported path;
- an unsigned POST to
  `/api/line/webhook/helper` through the public API Gateway returns exactly
  `400 {"ok":false,"error":"missing_line_signature"}`.

Do not print or request secret values during verification.

- [ ] **Step 7: Report the deployed outcome**

Report the PR URL, merge commit, release run, production revision, Azure
embedding resource/deployment identity, and smoke-test results. State any
remaining operational work only if a verification command proves it remains.

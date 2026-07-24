# R3.1 Remote Runtime Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every office-hosted runtime dependency by using DeepSeek for
all LLM lanes, OpenAI `text-embedding-3-small` at 1536 dimensions, an internal
always-on ACA SearXNG app, and ACA Jobs for ClamAV signature refresh and
attachment scanning.

**Architecture:** Preserve the controlled-routing and function boundaries.
Make LLM fallback optional so DeepSeek failures reach existing deterministic
validation instead of a second model. Replace the generic Ollama embedding
client with an OpenAI embedding adapter, clear only derived knowledge vectors
and snapshots, and re-index atomically. Keep the attachment workflow in the
bot, but queue an opaque work ID after final confirmation; a finite ACA Job
claims that work, scans it locally with the mounted signature database, and
uses the existing resource binary publisher for the only upload/catalog path.

**Tech Stack:** TypeScript/Node 24, Fastify, Zod, Vitest, PostgreSQL/pgvector,
Redis, Azure Container Apps, Azure Storage Queue, Azure Files, Azure Container
Registry, OpenAI Embeddings API, DeepSeek API, ClamAV.

## Global Constraints

- Do not retain, configure, or connect to Ollama, an office SearXNG endpoint,
  or an office ClamAV endpoint.
- DeepSeek is the only LLM provider; a provider failure may use deterministic
  routing recovery only and must never invoke another semantic model.
- Use `text-embedding-3-small` at exactly 1536 dimensions. Preserve explicit
  memory text and source/access/lifecycle/audit metadata; derived knowledge
  snapshots may be cleared and rebuilt.
- SearXNG has internal ingress only, minimum replica count one, and remains a
  requester-consented sheet-music fallback only.
- The Azure Queue message contains only an opaque scan-work ID. No raw message,
  filename, URL, byte content, credential, or scan result is queued or traced.
- The signature-refresh job runs every two days. A signature set older than 72
  hours, missing, invalid, or unreadable prevents publication.
- Attachment download occurs only after the existing final confirmation, and a
  non-clean or unavailable scan must produce no OneDrive item or catalog row.
- Keep public health/readiness behavior unchanged; do not expose workload or
  provider diagnostics through public endpoints.
- Update AGENTS.md and README whenever user-facing configuration or runtime
  behavior changes. Never commit secrets or production identifiers.

---

## Delivery order

1. Remote LLM and embedding migration, including the 1536 pgvector rebuild.
2. Internal ACA SearXNG replacement.
3. Event-driven ClamAV scan/publish job and scheduled signature job.
4. One remote-only integration/Kernal gate and deployment-contract review.

The first delivery can be deployed and observed before the attachment worker is
introduced. The second and third deliveries remove the final office routes
without changing the user-facing search consent or attachment confirmation
contracts.

### Task 1: Make semantic fallback explicitly optional and DeepSeek-only

**Files:**

- Modify: `src/types.ts`, `src/config.ts`, `src/llm/provider-policy.ts`,
  `src/llm/provider-runtime.ts`, `src/agent/planner.ts`,
  `src/admin-action-router.ts`, `src/wikipedia/summarizer.ts`,
  `src/search/sheet-music-external-summarizer.ts`, `src/index.ts`
- Delete: `src/clients/ollama.ts`, `src/llm/llm-diagnostics.ts`
- Modify tests: `src/__tests__/config.test.ts`,
  `src/__tests__/provider-runtime.test.ts`,
  `src/__tests__/agent-planner.test.ts`,
  `src/__tests__/agent-planner-live-eval.test.ts`, and the affected admin,
  summarizer, diagnostics, and profile contract tests.

**Interfaces:**

- Replace `MODEL_PROVIDER_NAMES = ["ollama", "deepseek"]` with
  `MODEL_PROVIDER_NAMES = ["deepseek"]`.
- Change planner construction to
  `createAgentPlanner({ primary: ChatProvider, fallback?: ChatProvider,
timeoutMs?: number }): AgentPlanner`.
- Give every lane a `ProviderLanePolicy` with `primary: "deepseek"` and no
  `fallback`; make `createProfileAwareProvider` throw
  `provider_not_configured` only for an absent primary.

- [ ] **Step 1: Write the failing configuration and planner tests.**

  Assert that a profile containing `allowedProviders: ["ollama"]`, a lane
  fallback, `OLLAMA_*`, or `LLM_FALLBACK_PROVIDER` is rejected; assert that a
  sole failing primary returns `providers_unavailable` with exactly one
  diagnostic attempt and never calls a fallback mock.

  ```ts
  const planner = createAgentPlanner({ primary: unavailableProvider("deepseek") });
  await expect(planner.propose(input)).resolves.toMatchObject({
    status: "no_plan",
    reasonCode: "providers_unavailable",
    attempts: [{ provider: "deepseek" }]
  });
  ```

- [ ] **Step 2: Run the focused tests and verify they fail because Ollama is
      still accepted and planner fallback is required.**

  Run: `pnpm vitest run src/__tests__/config.test.ts src/__tests__/agent-planner.test.ts src/__tests__/provider-runtime.test.ts`

- [ ] **Step 3: Remove the Ollama provider family and make fallback optional.**

  Remove Ollama defaults, types, profile policy normalization, client
  construction, diagnostics, and all provider registry entries. Make each
  consumer accept `fallback?: ChatProvider`; only call it when supplied and its
  profile provider name differs from primary. Configure all helper lanes as
  DeepSeek-only and retain the existing validator's no-plan deterministic
  recovery.

- [ ] **Step 4: Update profile/config fixtures and documentation references.**

  Change `config/profiles.json`, `.env.example`, README routing/configuration,
  `docs/architecture-context.md`, and AGENTS.md to show only DeepSeek and no
  local provider commands, endpoint, keep-alive, or diagnostics.

- [ ] **Step 5: Run the focused suite and commit.**

  Run: `pnpm format:check && pnpm typecheck && pnpm lint && pnpm vitest run src/__tests__/config.test.ts src/__tests__/provider-runtime.test.ts src/__tests__/agent-planner.test.ts`

  Commit: `refactor: make DeepSeek the sole LLM provider`

### Task 2: Add a provider-neutral OpenAI embedding adapter and 1536 config

**Files:**

- Create: `src/clients/embedding.ts`, `src/clients/openai-embedding.ts`,
  `src/__tests__/openai-embedding.test.ts`
- Delete: `src/clients/ollama-embedding.ts`,
  `src/__tests__/ollama-embedding.test.ts`
- Modify: `src/types.ts`, `src/config.ts`, `src/index.ts`,
  `src/tools/sync-catalog.ts`, `src/functions/registry.ts`,
  `src/functions/query-knowledge.ts`, `src/actions/admin-registry.ts`,
  `src/knowledge/sync-service.ts`, `src/knowledge/scheduled-sync.ts`,
  `src/agent/text-memory-embedding-backfill.ts`, and their tests.

**Interfaces:**

- Move the shared contract to `src/clients/embedding.ts`:

  ```ts
  export interface EmbeddingClient {
    readonly provider: string;
    readonly model: string;
    readonly dimensions: number;
    embed(input: readonly string[]): Promise<number[][]>;
  }
  ```

- Implement
  `createOpenAiEmbeddingClient({ apiKey, baseUrl, model, dimensions, timeoutMs, fetchImpl? })`.
  It POSTs `{ model, input, encoding_format: "float" }` to `/embeddings`,
  accepts response data ordered by `index`, and rejects missing API key,
  HTTP failure, timeout, non-finite values, count mismatch, or a vector whose
  length differs from 1536.
- Replace `KnowledgeConfig.embedding` with an `openai` provider configuration:
  `OPENAI_API_KEY`, `OPENAI_BASE_URL=https://api.openai.com/v1`,
  `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIMENSIONS=1536`,
  `EMBEDDING_BATCH_SIZE`, and `EMBEDDING_TIMEOUT_MS`.

- [ ] **Step 1: Write failing adapter tests.**

  Cover authorization/header/body, response index ordering, empty input,
  401/429/5xx, abort timeout, count mismatch, and 1535/1537-dimensional
  vectors. The success expectation is:

  ```ts
  await expect(client.embed(["a", "b"])).resolves.toEqual([
    Array(1536).fill(0.1),
    Array(1536).fill(0.2)
  ]);
  ```

- [ ] **Step 2: Implement the adapter and rewire all embedding consumers to
      the shared interface.**

  Do not duplicate HTTP parsing in the catalog sync tool. Build the adapter in
  `src/index.ts` and `src/tools/sync-catalog.ts` from the same validated
  config. Preserve batch limits and all current unavailable outcomes.

- [ ] **Step 3: Add config validation tests.**

  Require `OPENAI_API_KEY` whenever knowledge embeddings are configured;
  reject any Ollama embedding variable and reject a dimension other than 1536.
  Make no secret visible in thrown errors, traces, or `/diag` replies.

- [ ] **Step 4: Run focused tests and commit.**

  Run: `pnpm vitest run src/__tests__/openai-embedding.test.ts src/__tests__/config.test.ts src/__tests__/agent-memory.test.ts src/__tests__/knowledge-sync.test.ts`

  Commit: `feat: use OpenAI embeddings for knowledge retrieval`

### Task 3: Rebuild pgvector-derived state at 1536 dimensions

**Files:**

- Modify: `src/knowledge/migrations.ts`, `src/agent/migrations.ts`,
  `src/knowledge/postgres-store.ts`, `src/knowledge/store.ts`,
  `src/functions/query-knowledge.ts`, `src/knowledge/sync-service.ts`
- Create: `src/tools/rebuild-knowledge-embeddings.ts`
- Modify tests: `src/__tests__/knowledge-migrations.test.ts`,
  `src/__tests__/agent-migrations.test.ts`,
  `src/__tests__/knowledge-postgres-store.test.ts`,
  `src/__tests__/knowledge-sync.test.ts`,
  `src/__tests__/query-knowledge.test.ts`.

**Interfaces:**

- Add `embeddingDimensions: number` to `KnowledgeSearchInput`; bind it in both
  SQL joins instead of the literal `e.dimensions=1024`.
- Add migration statements in this order: delete `knowledge_embeddings`,
  `knowledge_chunks`, and `knowledge_documents`; drop the embedding index and
  1024 check; alter `knowledge_embeddings.embedding` to `vector(1536)`; add
  `check (dimensions = 1536)`; recreate the HNSW index. Preserve
  `knowledge_sources` and its lifecycle fields.
- Preserve `agent_text_memories` rows but set their `embedding` values to null,
  recreate its HNSW index as `vector(1536)`, and let the bounded backfill
  restore vectors. Do not delete text memory content.

- [ ] **Step 1: Write migration and search contract tests.**

  Assert the migration SQL clears derived knowledge rows, never deletes
  `knowledge_sources`, changes both vector columns to 1536, and that SQL search
  binds `input.embeddingDimensions` rather than a hard-coded 1024.

- [ ] **Step 2: Implement migration-safe schema changes and store filtering.**

  Ensure each Postgres statement is idempotent for a fresh database and for a
  database already at 1536. A source remains non-routable until its rebuilt
  snapshot is atomically published; queries cannot compare a different model or
  dimension.

- [ ] **Step 3: Implement the bounded rebuild CLI.**

  `src/tools/rebuild-knowledge-embeddings.ts` loads normal config, lists enabled
  sources, runs the existing scheduled sync service in batches, logs only source
  count/status/chunk count, and exits non-zero if any requested source fails.
  It must not print titles, URLs, chunks, API keys, or embeddings.

- [ ] **Step 4: Run migration/retrieval tests and commit.**

  Run: `pnpm vitest run src/__tests__/knowledge-migrations.test.ts src/__tests__/agent-migrations.test.ts src/__tests__/knowledge-postgres-store.test.ts src/__tests__/knowledge-sync.test.ts src/__tests__/query-knowledge.test.ts`

  Commit: `feat: rebuild knowledge vectors at 1536 dimensions`

### Task 4: Deploy SearXNG as an internal, always-on ACA app

**Files:**

- Create: `aca.searxng.containerapp.yaml`, `infra/searxng/settings.yml`
- Modify: `aca.containerapp.yaml`, `scripts/deploy-aca.sh`,
  `.github/workflows/release.yml`, `.env.example`,
  `src/__tests__/profile-config-deployment-contract.test.ts`, README, AGENTS.md.

**Interfaces:**

- The bot configuration remains `SEARXNG_BASE_URL`, but production supplies the
  ACA internal FQDN rather than an address in the office network.
- `aca.searxng.containerapp.yaml` uses internal ingress, target port 8080,
  `minReplicas: 1`, the pinned SearXNG image, read-only configuration mount, and
  a persistent cache mount only if the ACA environment storage is provisioned.
- Keep the existing `createSearxngClient` timeout and consent gate unchanged.

- [ ] **Step 1: Write failing deployment-contract tests.**

  Assert that no deployment manifest or shell script contains `172.16.65.5`,
  that the SearXNG manifest has `external: false` and `minReplicas: 1`, and that
  the bot does not expose a public SearXNG route.

- [ ] **Step 2: Add the SearXNG ACA manifest and deploy-script lifecycle.**

  Provision/update the internal app before the bot revision, resolve its
  internal FQDN in the script, and set the bot's `SEARXNG_BASE_URL` to that
  value. Do not add a general-search function, browser route, result cache, or
  automatic import behavior.

- [ ] **Step 3: Delete office SearXNG runtime assumptions.**

  Remove its host configuration from `infra/local-services` and all deployment
  examples. Retain local unit tests with a fake HTTP fetch only.

- [ ] **Step 4: Run deployment and consent tests and commit.**

  Run: `pnpm vitest run src/__tests__/searxng.test.ts src/__tests__/sheet-music.test.ts src/__tests__/profile-config-deployment-contract.test.ts`

  Commit: `feat: host sheet music SearXNG in ACA`

### Task 5: Create durable opaque attachment-scan work and queue handoff

**Files:**

- Add dependency: `@azure/storage-queue`
- Create: `src/attachments/scan-work-store.ts`, `src/attachments/scan-queue.ts`,
  `src/__tests__/scan-work-store.test.ts`, `src/__tests__/scan-queue.test.ts`
- Modify: `src/redis.ts`, `src/types.ts`, `src/config.ts`, `src/index.ts`,
  `src/state/session-store.ts`, `src/functions/pending-attachment.ts`,
  `src/functions/pending-function.ts`, `src/agent/jobs.ts`, and attachment
  workflow tests.

**Interfaces:**

```ts
export interface AttachmentScanWorkStore {
  create(input: AttachmentScanWorkInput): Promise<AttachmentScanWork>;
  claim(id: string): Promise<AttachmentScanWork | undefined>;
  complete(id: string, result: FunctionExecutionResult): Promise<void>;
  fail(id: string, code: AttachmentScanFailureCode): Promise<void>;
}

export interface AttachmentScanQueue {
  enqueue(workId: string): Promise<void>;
}
```

`AttachmentScanWork` stores only the server-side LINE message ID, authorized
scope, declared purpose/title, expiry, and terminal state. The queue message is
`{ "workId": "<UUID>" }`. `claim` is an atomic Redis compare-and-set/Lua
transition from `confirmed` to `claimed`; it refuses expired, foreign,
completed, or already-claimed work.

- [ ] **Step 1: Write failing state/queue tests.**

  Test that two parallel `claim` calls yield one work record, queue serialization
  contains only `workId`, final confirmation creates a requester-scoped pending
  job plus work record, and no LINE content client is called before confirmation.

- [ ] **Step 2: Implement Redis-backed work state and Azure Queue adapter.**

  Extend the Redis protocol with the atomic operation required by `claim`.
  Validate `ATTACHMENT_SCAN_QUEUE_URL` at startup when `save_resource` is
  enabled in production. The queue adapter must have no logging of payload
  beyond a hashed/opaque work identifier.

- [ ] **Step 3: Change the final attachment confirmation path.**

  Replace in-process download/publish with: create long-running job, persist
  confirmed work, enqueue opaque ID, return the existing `查看結果` postback.
  If persistence or enqueue fails, mark the job failed and publish nothing.

- [ ] **Step 4: Run attachment state tests and commit.**

  Run: `pnpm vitest run src/__tests__/attachment-save.test.ts src/__tests__/pending-function.test.ts src/__tests__/scan-work-store.test.ts src/__tests__/scan-queue.test.ts src/__tests__/agent-jobs.test.ts`

  Commit: `feat: queue confirmed attachment scans`

### Task 6: Run ClamAV scan and publication inside a finite worker job

**Files:**

- Create: `src/tools/run-attachment-scan-job.ts`, `src/attachments/clamav-cli.ts`,
  `src/attachments/scan-worker.ts`, `src/__tests__/clamav-cli.test.ts`,
  `src/__tests__/scan-worker.test.ts`
- Modify: `src/functions/resource-binary-publisher.ts`, `src/index.ts`,
  `Dockerfile`, `package.json`, `src/clients/clamav.ts`,
  `src/clients/virus-scan.ts`, and resource-publisher tests.
- Delete: `src/clients/clamav.ts`, `src/clients/virus-scan.ts` after all
  callers use the worker-only scanner.

**Interfaces:**

- Split `ResourceBinaryPublisher` into a shared validation/preparation function
  and `publishVerifiedResource(input)`; only the worker may pass a successful
  `scan: { status: "clean", signatureVersion: string }` proof. The method still
  performs source gate, duplicate detection, Graph upload, catalog upsert, and
  upload compensation.
- `scanWithClamAvCli({ filePath, databaseDirectory, timeoutMs, execFile })`
  maps exit 0 to clean, 1 to infected, and every other/timeout/error to
  unavailable without leaking the scanner output.
- `runAttachmentScanWorker(workId)` claims work, downloads the LINE bytes after
  claim, validates/prepares, writes an ephemeral file, scans it, publishes only
  if clean/current, completes the scoped job, and always deletes the ephemeral
  file.

- [ ] **Step 1: Write failing worker tests.**

  Use fake LINE/Graph/scanner clients. Cover clean publish, infected, timeout,
  unavailable scanner, stale signature, duplicate work, Graph failure, and
  catalog failure. Every non-clean assertion must include
  `expect(graph.uploadFile).not.toHaveBeenCalled()`.

- [ ] **Step 2: Refactor publisher without changing its valid input rules.**

  Keep magic-byte, extension, safe filename, SHA-256, permitted target,
  duplicate, OneDrive, and catalog semantics. Remove any network ClamAV/HTTP
  scanner option so the bot API process cannot scan or publish an attachment.

- [ ] **Step 3: Implement the worker executable and ClamAV CLI wrapper.**

  The executable reads one opaque `WORK_ID`, validates its environment and
  signature manifest, and emits only sanitized structured status. It exits
  non-zero for infrastructure failure after marking the work/job failed.

- [ ] **Step 4: Build a dedicated worker image target and run tests.**

  Add a Debian Node runtime target that installs a pinned ClamAV package and
  runs `dist/tools/run-attachment-scan-job.js`; retain the distroless web-image
  target. Do not put ClamAV in the always-on bot container.

  Run: `pnpm vitest run src/__tests__/resource-binary-publisher.test.ts src/__tests__/clamav-cli.test.ts src/__tests__/scan-worker.test.ts && pnpm build`

  Commit: `feat: scan attachments in a ClamAV worker job`

### Task 7: Provision the scan and signature-refresh ACA Jobs

**Files:**

- Create: `aca.attachment-scan-job.yaml`, `aca.clamav-signature-refresh-job.yaml`,
  `src/tools/refresh-clamav-signatures.ts`,
  `src/__tests__/clamav-signature-refresh.test.ts`
- Modify: `scripts/deploy-aca.sh`, `.github/workflows/release.yml`,
  `aca.containerapp.yaml`, `aca.catalog-sync-job.yaml`, `.env.example`,
  `src/__tests__/profile-config-deployment-contract.test.ts`, README, AGENTS.md.

**Interfaces:**

- Scan job: event trigger over the attachment queue, one work item per
  execution, `minExecutions: 0`, `parallelism: 1`, 1 vCPU/4 GiB, read-only
  `/var/lib/clamav` Azure Files mount, bounded timeout, and no ingress.
- Refresh job: schedule trigger `10 19 */2 * *` (UTC), same Azure Files share
  mounted read/write, runs `freshclam` through the refresh CLI, validates a
  complete set in a staging directory, atomically promotes a manifest with
  `lastSuccessfulAt`, and exits non-zero without replacing the prior set.
- The deployment script resolves/copies only ACA secrets and storage/queue
  references; it removes all `OLLAMA_*`, `CLAMAV_HOST`, `CLAMAV_PORT`,
  `VIRUS_SCAN_*`, and office IP configuration.

- [ ] **Step 1: Write failing signature and deployment-contract tests.**

  Assert a two-day UTC cron, Azure Files read-only/write modes as appropriate,
  queue event trigger, no ingress, 1 vCPU/4 GiB scanner limits, and rejection
  of a missing, malformed, or over-72-hour manifest.

- [ ] **Step 2: Implement safe signature refresh.**

  Invoke `freshclam` only in the scheduled job, verify database files with the
  ClamAV tooling, write a sanitized manifest last, and retain the previous
  active directory on any failure. Never log signature database paths or
  scanner output as user-facing diagnostics.

- [ ] **Step 3: Add ACA manifests and release deployment steps.**

  Build/push both image targets, create/update the Azure Files environment
  storage definition and queue-auth configuration, deploy SearXNG before the
  bot, then refresh and scan jobs. Keep the bot ingress internal and Dapr app
  settings unchanged.

- [ ] **Step 4: Run deployment contracts and commit.**

  Run: `pnpm vitest run src/__tests__/clamav-signature-refresh.test.ts src/__tests__/profile-config-deployment-contract.test.ts`

  Commit: `infra: run ClamAV scans as ACA jobs`

### Task 8: Remove the office runtime and prove the remote-only boundary

**Files:**

- Delete: `infra/local-services/docker-compose.yml` and only the scripts/docs
  that exist exclusively to start Ollama, SearXNG, or ClamAV locally.
- Modify: `README.md`, `docs/architecture-context.md`, `AGENTS.md`,
  `.env.example`, deployment/profile contract tests, and all remaining renamed
  test fixtures.
- Modify: `src/evals/kernel/cases/security-and-state.ts` and add a dedicated
  R3.1 provider/attachment case file if the existing case grouping becomes
  unclear.

- [ ] **Step 1: Add Kernel cases before removing the final references.**

  Add deterministic cases for DeepSeek unavailable with an explicit candidate
  (deterministic collect/execute only), DeepSeek unavailable with ambiguous
  evidence (clarify/unavailable), missing/stale ClamAV signatures (no publish),
  infected attachment (no publish), and a clean requester-scoped job result.

- [ ] **Step 2: Remove remaining local-runtime code and documentation.**

  `rg -n -i 'ollama|172\\.16\\.65\\.5|CLAMAV_HOST|VIRUS_SCAN_ENDPOINT' .`
  must return only historical changelog/spec references that explicitly describe
  retirement; remove any runtime/configuration match.

- [ ] **Step 3: Run the complete offline gate.**

  Run:

  ```bash
  pnpm format:check
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm eval:agent
  pnpm eval:retrieval-product
  pnpm eval:kernel
  pnpm build
  ```

  Expected: all commands exit 0; Kernel report has no failed boundary ID.

- [ ] **Step 4: Run manual remote/ACA verification after secrets and resources
      are provisioned.**

  Run `pnpm eval:agent:live` with DeepSeek only; run one clean and one EICAR
  attachment through the deployed job; verify SearXNG can be reached only from
  ACA internal networking; post an unsigned body through the public gateway and
  expect `400 {"ok":false,"error":"missing_line_signature"}` from the bot.

- [ ] **Step 5: Commit the final removal.**

  Commit: `refactor: retire office runtime dependencies`

## Plan self-review

- Spec coverage: Tasks 1–3 cover DeepSeek-only behavior, the OpenAI 1536
  embedding adapter, vector/schema rebuild, atomic snapshots, and retained
  source/access/audit metadata. Task 4 covers internal, always-on SearXNG and
  its existing consent-only boundary. Tasks 5–7 cover opaque queue handoff,
  atomic claim, delayed download, ClamAV scanning, Azure Files signatures every
  two days, 72-hour fail-closed policy, ACA Job sizing, and requester-scoped
  result retrieval. Task 8 covers Kernel, remote-only verification, and removal.
- Placeholder scan: no deferred requirements or unnamed implementation choices
  remain; Azure resource names and IDs are intentionally deployment secrets /
  environment inputs rather than repository values.
- Type consistency: `EmbeddingClient` is the shared abstraction; scan work uses
  `AttachmentScanWorkStore` and `AttachmentScanQueue`; the worker only calls
  `publishVerifiedResource` after a clean scan.

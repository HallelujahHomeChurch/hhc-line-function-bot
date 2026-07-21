# Kernel v1 Integration Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required, real-dependency Kernel v1 gate proving Redis cross-replica workflow semantics, application restart recovery, PostgreSQL migration compatibility, and atomic catalog/knowledge publication.

**Architecture:** Keep deterministic `eval:kernel` unchanged and add an isolated Vitest integration suite that connects to disposable Redis and pgvector-enabled PostgreSQL containers. The suite constructs two independent production store clients to represent replicas, reconnects them to represent application-process restart, and restarts its AOF-enabled Redis container to prove server-restart durability. One checked-in Compose stack is owned by the integration command in both CI and local development, so missing dependencies cannot be silently skipped.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Redis 7, PostgreSQL 16 with pgvector, pnpm 11, Docker Compose, GitHub Actions.

## Global Constraints

- Do not use production Redis keys, PostgreSQL databases, LINE IDs, OneDrive folders, Notion pages, people, filenames, URLs, tokens, prompts, or provider payloads.
- The integration command owns a uniquely named disposable Compose project and must fail if Docker, Redis, PostgreSQL, pgvector, restart, or cleanup is unavailable; the gate must never report a skipped dependency as passed.
- Use a random per-run Redis key prefix and a transaction-owned or uniquely named PostgreSQL schema, then clean both in `afterAll` even after assertion failures.
- Two replicas mean two independently connected Redis clients and independently constructed production stores, not two wrappers over one fake client.
- Application restart means disconnecting a client, constructing a new client/store, and reading the prior state through Redis/PostgreSQL.
- Redis-server restart means restarting the harness-owned AOF-enabled container and reconnecting before checking the declared durable subset.
- No-Redis behavior remains single-process/local-only and lost on application restart; it must never be described as multi-replica safe.
- Fix failures at the reusable state/store contract. Do not add function-name or phrase-specific branches.
- Use first-person `我` for any new LINE-facing copy; this slice should not add LINE copy.

---

## File Structure

- Create `src/evals/kernel/integration/environment.ts`: strict environment parsing, real Redis/PostgreSQL connections, per-run namespace setup, cleanup, and readiness checks.
- Create `src/evals/kernel/integration/redis-matrix.ts`: reusable real-Redis cross-replica and restart scenario runner returning allowlisted case IDs/statuses.
- Create `src/evals/kernel/integration/postgres-matrix.ts`: real migration, catalog snapshot, and knowledge snapshot scenario runner.
- Create `src/evals/kernel/integration/report.ts`: redacted console/report projection containing only stable case IDs, boundaries, and pass/fail status.
- Create `src/tools/eval-kernel-integration.ts`: strict integration CLI and exit code.
- Create `compose.kernel-integration.yml`: private disposable Redis AOF and pgvector PostgreSQL services with health checks.
- Create `src/__tests__/kernel-redis-integration.test.ts`: real Redis contract tests.
- Create `src/__tests__/kernel-postgres-integration.test.ts`: real PostgreSQL/pgvector contract tests.
- Modify `src/actions/confirmation-store.ts`: actor-safe atomic Redis confirmation consumption exposed by the integration test.
- Modify `src/state/redis-session-store.ts`: requester/source-indexed atomic interactive-session replacement.
- Modify `src/redis.ts`: include the exact Redis command capability required by the atomic confirmation store.
- Modify `src/agent/migrations.ts`: align the PostgreSQL resource-type constraint with all supported TypeScript resource kinds.
- Modify `src/functions/validated-sharing-link.ts` and `src/types.ts`: make Graph item validation mandatory before link generation.
- Modify `package.json`: add `eval:kernel:integration`.
- Modify `.github/workflows/ci.yml`: add healthy Redis and pgvector PostgreSQL services and run the gate.
- Modify `README.md`, `AGENTS.md`, `docs/operations/controlled-agent-support.md`, and `docs/kernel-v1/acceptance-baseline.md`: commands, guarantees, limitations, and slice status.
- Modify `src/__tests__/confirmation.test.ts`, `src/__tests__/kernel-docs.test.ts`, and `src/__tests__/profile-config-deployment-contract.test.ts`: regression and CI/document contracts.
- Create `src/__tests__/validated-sharing-link.test.ts`: missing/deleted item validation fails closed.

---

### Task 1: Strict Real-Dependency Harness and Redis Cross-Replica Gate

**Files:**

- Create: `src/evals/kernel/integration/environment.ts`
- Create: `src/evals/kernel/integration/redis-matrix.ts`
- Create: `src/__tests__/kernel-redis-integration.test.ts`
- Modify: `src/actions/confirmation-store.ts`
- Modify: `src/redis.ts`
- Modify: `src/state/redis-session-store.ts`
- Modify: `src/__tests__/confirmation.test.ts`

**Interfaces:**

- Consumes: `KERNEL_REDIS_URL`, production `RedisSessionStore`, `RedisConversationWindowStore`, `RedisAgentJobStore`, `RedisWebhookEventStore`, `RedisInFlightStore`, `RedisCacheStore`, and `RedisConfirmationStore`.
- Produces: `createKernelRedisEnvironment(): Promise<KernelRedisEnvironment>` and `runRedisIntegrationMatrix(environment): Promise<KernelIntegrationCaseResult[]>`.
- `KernelRedisEnvironment` owns two connected Redis clients, a random `keyPrefix`, `reconnectReplica(index)`, and `cleanup()`.
- `KernelIntegrationCaseResult` contains only `{ caseId: string; boundary: KernelBoundary; passed: boolean; failureCode?: string }`.

- [ ] **Step 1: Write a failing strict-environment test**

Add a test proving the harness throws `kernel_integration_redis_url_required` when the URL is absent and uses a random `kernel-v1:<uuid>` prefix when present. Run:

```bash
pnpm vitest run src/__tests__/kernel-redis-integration.test.ts
```

Expected: FAIL because `environment.ts` does not exist.

- [ ] **Step 2: Implement strict Redis environment ownership**

Use `createClient({ url })` twice, attach bounded error listeners, connect both clients, verify `PING`, and clean only `${keyPrefix}:*` keys. Never call `FLUSHDB`. `reconnectReplica(index)` must quit the selected client, construct a fresh client, connect, and return it.

- [ ] **Step 3: Write failing cross-replica workflow tests**

Use production stores and synthetic scopes to prove:

1. replica A writes a selection and exactly one of concurrent A/B `take` calls succeeds;
2. A records a task frame, B reads it, B cannot read it for another requester, and a reconnected A still reads it;
3. A creates/completes a job, B reads it only for the same profile/source/requester after A reconnects;
4. A starts a webhook event and B receives `duplicate`;
5. A acquires an in-flight lock, B receives `busy`, B releases it, and A can reacquire;
6. A writes cache state, B reads it, B invalidates it, and A observes the invalidation;
7. A creates a confirmation; a wrong actor on B receives `null` without consuming it; the correct actor on A consumes it exactly once;
8. another group requester cannot find or consume the first requester's pending resolution/upload state.
9. two replicas concurrently replace the same requester/source interactive workflow and exactly one latest indexed session remains discoverable.

Expected: the confirmation isolation case fails against the current `GETDEL`-before-validation implementation.

- [ ] **Step 4: Add the unit regression for actor-safe confirmation consumption**

Extend the Redis confirmation test double with the atomic primitive chosen in Step 5. Assert wrong actor, wrong profile, malformed payload, expired payload, and concurrent correct consumption. Run the targeted unit and integration tests and retain the failing evidence before implementation.

- [ ] **Step 5: Implement atomic compare-and-delete confirmation consumption**

Extend `RedisConfirmationClient` with a bounded `eval` operation and execute one Lua script that:

1. reads the confirmation key;
2. decodes JSON with `pcall(cjson.decode, value)`;
3. returns `nil` without deleting when profile or actor does not match;
4. deletes and returns the exact JSON only when both match.

Expiry remains enforced by Redis TTL and the existing application timestamp check. Do not use `GETDEL` before authorization.

- [ ] **Step 6: Implement requester/source-indexed atomic interactive replacement**

Add one Redis index key per `profile/source/requester` interactive workflow. A bounded Lua operation reads the old indexed session ID, deletes that old session, writes the new session with TTL, and updates the index with the same TTL as one atomic operation. Lookup must use the index for the active interactive session instead of `KEYS`; one-shot consumption must clear the index only when it still points at the consumed ID. Add concurrent A/B replacement and consumption assertions.

- [ ] **Step 7: Run Redis tests until green**

Run:

```bash
pnpm vitest run src/__tests__/confirmation.test.ts src/__tests__/kernel-redis-integration.test.ts
```

Expected: PASS with real Redis and no leaked keys after cleanup.

- [ ] **Step 8: Commit the independently reviewable Redis slice**

Stage only Task 1 files and commit `test: add kernel redis replica gate`.

---

### Task 2: PostgreSQL Migration and Atomic Publication Gate

**Files:**

- Create: `src/evals/kernel/integration/postgres-matrix.ts`
- Create: `src/__tests__/kernel-postgres-integration.test.ts`
- Reuse: `src/evals/kernel/integration/environment.ts`
- Modify: `src/agent/migrations.ts`
- Modify when the real CAS test fails: `src/catalog/postgres-store.ts`

**Interfaces:**

- Consumes: `KERNEL_POSTGRES_URL`, `runScheduleMigrations`, `runCatalogMigrations`, `runAgentMemoryMigrations`, `runKnowledgeMigrations`, `PostgresCatalogStore`, and `PostgresKnowledgeStore`.
- Produces: `runPostgresIntegrationMatrix(environment): Promise<KernelIntegrationCaseResult[]>`.
- The PostgreSQL environment exposes two independent `pg.Pool` instances with `search_path` pinned to a unique quoted schema and `cleanup()` that drops only that schema.

- [ ] **Step 1: Write failing PostgreSQL environment and pgvector readiness tests**

Assert absence of the URL throws `kernel_integration_postgres_url_required`; assert `select extversion from pg_extension where extname='vector'` returns one row; assert two pools share the same isolated schema. Run:

```bash
pnpm vitest run src/__tests__/kernel-postgres-integration.test.ts
```

Expected: FAIL before PostgreSQL environment support exists.

- [ ] **Step 2: Implement isolated PostgreSQL ownership**

Create a random schema, set each pool's `search_path` using a safe server-side identifier, verify pgvector, and drop the schema in cleanup. The URL must point to an ephemeral database. Never drop or truncate `public`.

- [ ] **Step 3: Write failing supported-previous-schema migration cases**

Build explicit legacy fixtures for the last supported schedule/catalog/agent-resource shapes:

- schedule rows with `external_id` but no `external_key`;
- catalog sources/items before revision/health/expiry columns.
- agent resources with the prior `ppt_slide|sheet_music` constraint while runtime types support `general_resource`.

Run current migrations twice and assert legacy rows are preserved, schedule `external_key` is backfilled, catalog revision/health/count are promoted, the resource constraint accepts every current `AgentResourceType` including `general_resource`, required indexes exist, and a new store instance reads the migrated rows. Also run access, agent-memory, and knowledge migrations twice from empty isolated schemas to prove startup idempotency with pgvector. The RED run must demonstrate the current `general_resource` constraint failure before changing migrations.

- [ ] **Step 4: Write catalog atomicity/concurrency cases**

Create one source and publish a good snapshot. Then:

1. submit two publications with the same expected revision through different pools and assert exactly one promotes;
2. assert search observes one complete winning snapshot, never mixed items;
3. submit an invalid/wrong-source publication and assert the prior snapshot remains searchable;
4. mark failure with a stale revision and assert it cannot overwrite newer ready health;
5. publish a newly added item and assert it is immediately searchable rather than hidden by a stale negative cache.

If the current CTE materializes eligibility before acquiring the source-row lock, the RED run may allow two same-revision publishers. Fix both full and delta publication by acquiring the matching `(sourceId, expectedRevision)` row with `FOR UPDATE` before any item upsert/tombstone, so a losing publisher performs zero catalog mutations. A final source-only CAS after item mutation is insufficient.

- [ ] **Step 5: Write knowledge rollback and stale-invocation cases**

Publish one ready knowledge snapshot with synthetic opaque identifiers. Force a second publication to fail inside its database transaction by supplying an invalid embedding dimension, then assert the first document/chunk remains active and searchable. Promote a later staging revision, submit `markSourceSyncFailed` with the old revision, and assert it returns `stale` without replacing the ready snapshot's health or routing metadata.

- [ ] **Step 6: Run PostgreSQL tests until green**

Run:

```bash
pnpm vitest run src/__tests__/kernel-postgres-integration.test.ts
```

Expected: PASS from a clean schema, PASS again, and cleanup leaves no test schema.

- [ ] **Step 7: Commit the independently reviewable PostgreSQL slice**

Stage only Task 2 files and commit `test: add kernel postgres publication gate`.

---

### Task 3: Fail-Closed Graph Reference Validation

**Files:**

- Create: `src/__tests__/validated-sharing-link.test.ts`
- Modify: `src/functions/validated-sharing-link.ts`
- Modify: `src/types.ts`
- Modify callers only when required by the stricter type.

**Interfaces:**

- Consumes: Graph drive/item metadata and `createValidatedSharingLink`.
- Produces: a reference-validation boundary that returns unavailable/failure and never calls `createSharingLink` when current-item validation is absent or reports the item missing.

- [ ] **Step 1: Write failing boundary tests**

Cover a client without item validation, a deleted/missing item, a validator error, and a valid current item. Assert the first three never call `createSharingLink`; only the valid case does.

- [ ] **Step 2: Run the test and verify RED**

Run `pnpm vitest run src/__tests__/validated-sharing-link.test.ts` and confirm the missing-validator case currently fails because a link is generated.

- [ ] **Step 3: Make validation mandatory**

Remove the optional validation bypass from the Graph capability contract, or explicitly fail unavailable at `createValidatedSharingLink` when a legacy test double omits it. Update affected production/test clients without weakening the boundary.

- [ ] **Step 4: Run targeted and relevant handler tests**

Run `pnpm vitest run src/__tests__/validated-sharing-link.test.ts src/__tests__/functions.test.ts src/__tests__/sheet-music.test.ts` and expect PASS.

- [ ] **Step 5: Commit the fail-closed boundary slice**

Stage only Task 3 files and commit `fix: require graph item validation`.

---

### Task 4: Stable CLI, Owned Compose Gate, Reports, and Durability Contract

**Files:**

- Create: `src/evals/kernel/integration/report.ts`
- Create: `src/tools/eval-kernel-integration.ts`
- Create: `compose.kernel-integration.yml`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/operations/controlled-agent-support.md`
- Modify: `docs/kernel-v1/acceptance-baseline.md`
- Modify: `src/__tests__/kernel-docs.test.ts`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**

- Consumes: both matrix runners.
- Produces: `pnpm eval:kernel:integration`, exit code `0` only when every case passed, and `artifacts/kernel-v1/integration-report.json` containing allowlisted case results only.

- [ ] **Step 1: Write failing CLI/report privacy tests**

Assert the report schema contains only schema version, generated time, dependency versions, stable case IDs, boundaries, pass/fail, and bounded failure codes. Assert serialization rejects unexpected fields and never includes URLs, Redis keys, database/schema names, queries, titles, people, filenames, or payloads.

- [ ] **Step 2: Implement the strict integration CLI and owned Compose lifecycle**

The CLI creates a unique Compose project name, chooses non-conflicting loopback ports, starts `compose.kernel-integration.yml`, waits for both health checks, passes private test URLs only to the child matrix process, and cleans containers plus volumes in `finally`. The Redis service runs `redis-server --appendonly yes --appendfsync always`; PostgreSQL uses `pgvector/pgvector:pg16`. The runner executes pre-restart Redis cases, restarts the actual Redis service, reconnects both clients, verifies the durable subset, then runs PostgreSQL cases. It writes the ignored report, prints a concise summary, and exits non-zero for Docker absence, dependency/readiness failure, restart failure, cleanup failure, or any failed case.

- [ ] **Step 3: Add the package command and CI execution**

Add:

```json
"eval:kernel:integration": "tsx src/tools/eval-kernel-integration.ts"
```

Run `pnpm eval:kernel:integration` after deterministic `pnpm eval:kernel` and before build in the existing required `PR CI` job. It uses the hosted runner's Docker/Compose installation and the same checked-in stack as local development; do not duplicate a different GitHub service-container topology.

- [ ] **Step 4: Add CI contract tests**

Assert the Compose file pins both service images, enables Redis AOF, exposes only loopback ports, declares health checks and disposable volumes, and `.github/workflows/ci.yml` runs `pnpm eval:kernel:integration` before `pnpm build`.

- [ ] **Step 5: Document exact local and production guarantees**

Document disposable local container commands, required URLs, report location, and these distinctions:

- Redis configured: app-process restart and cross-replica workflow state are supported until TTL;
- Redis unavailable at startup: configured production startup fails;
- Redis absent: only single-process local development is supported and state is lost on restart;
- Redis server data-loss/restart recovery depends on infrastructure persistence and is not claimed by this app-process gate;
- PostgreSQL configured: catalog, schedules, knowledge, access, and explicit memory survive app restart;
- PostgreSQL absent: in-memory catalog/memory are development-only and lost on restart.

Update the acceptance baseline to mark only the integration slice complete; live-provider and production observation remain pending.

- [ ] **Step 6: Run targeted and full gates**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm config:validate
pnpm eval:agent
pnpm eval:retrieval-product
pnpm eval:kernel
pnpm eval:kernel:integration
pnpm build
```

Expected: every command exits `0`; `eval:kernel:integration` reports all stable case IDs passed.

- [ ] **Step 7: Run privacy and repository checks**

Run:

```bash
git diff --check
git ls-files artifacts
rg -n "KERNEL_(REDIS|POSTGRES)_URL=.*(@|redis://[^$])|LINE_CHANNEL|DEEPSEEK_API_KEY" . ':!pnpm-lock.yaml'
```

Expected: no tracked artifacts, real credentials, production IDs, or URLs.

- [ ] **Step 8: Commit the CI/docs slice**

Stage Task 4 files and commit `ci: require kernel integration matrix`.

---

### Task 5: Review, PR, Release, and Roadmap Handoff

**Files:**

- Modify only files required by review findings.

**Interfaces:**

- Consumes: completed Tasks 1-3 and clean full verification.
- Produces: reviewed PR, merged `main`, successful Production Release, healthy ACA revision, Gateway/Dapr smoke evidence, and the next live-provider/production-observation plan status.

- [ ] **Step 1: Request spec and code-quality review**

Use a fresh reviewer to inspect real-dependency ownership, Redis atomicity, group/requester isolation, PostgreSQL transaction semantics, migration fidelity, cleanup safety, CI reliability, and privacy. Fix Critical/Important findings with a regression test first.

- [ ] **Step 2: Re-run the complete verification from a clean checkout**

Repeat Task 3 Step 6 and confirm `git status --short` contains only intentional files.

- [ ] **Step 3: Push and create a ready PR**

Push `codex/kernel-v1-integration`, create a ready PR titled `Kernel v1: add Redis and PostgreSQL integration gate`, and enable squash auto-merge after required `PR CI` passes.

- [ ] **Step 4: Monitor merge and Production Release**

Confirm the squash commit reaches `main`, monitor Production Release, verify the latest ACA revision is healthy with 100% traffic and Dapr `appId=hhc-line-function-bot`, then send the unsigned public Gateway request and expect `400 {"ok":false,"error":"missing_line_signature"}`.

- [ ] **Step 5: Return to the roadmap**

Update the execution ledger: integration gate complete, then begin the separate manual `eval:kernel:live` slice followed by privacy-safe production observation and final Kernel v1 acceptance. Do not start R4 until all Kernel v1 exit criteria are met.

---

## Plan Self-Review Result

- **Spec coverage:** Application restart, actual AOF Redis-server restart, two-replica state, requester isolation, atomic interactive replacement, PostgreSQL migration and resource-type compatibility, catalog/knowledge atomicity, Graph fail-closed validation, freshness visibility, no-Redis limitations, CI, privacy, and release observation each have an explicit task.
- **Architecture boundary:** Runtime fixes are allowed only when a real integration case exposes a reusable store-contract defect. No function or phrase-specific routing changes are included.
- **Failure honesty:** Missing dependencies, cleanup errors, incomplete migrations, and unavailable pgvector fail the gate rather than skipping.
- **Type consistency:** Both runners return the same allowlisted `KernelIntegrationCaseResult`; the CLI is the only report writer.
- **Privacy:** Test fixtures and reports use synthetic opaque identifiers. URLs and database/key namespaces remain runtime-only and never enter reports.
- **Delivery:** The slice is independently reviewable and ends in the existing protected-main PR/release workflow before roadmap progression.

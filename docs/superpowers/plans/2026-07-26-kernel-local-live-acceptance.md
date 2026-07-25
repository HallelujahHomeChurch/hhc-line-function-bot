# Kernel v1 Local Live Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run one bounded, disposable local Compose acceptance suite that sends signed synthetic LINE webhooks through the real controlled runtime while using real DeepSeek routing and Azure `text-embedding-3-small`, then records enough sanitized evidence to close Kernel v1 before R4.

**Architecture:** Add an acceptance-only composition under `src/testing/kernel-local-live` and a driver under `src/evals/kernel/local-live`. Both run from a dedicated Dockerfile target with local pgvector PostgreSQL and Redis on an internal Compose network; only the app also joins an unexposed provider-egress network. A host shell owns Azure secret retrieval into `/dev/shm`, static provider-budget validation, the ten-minute deadline, leak checks, and unconditional cleanup; production startup and production profile configuration remain unchanged.

**Tech Stack:** TypeScript 5.9, Node 24, Fastify 5, Vitest 4, Redis 7.4, PostgreSQL 16 with pgvector 0.8.1, Docker Compose, Bash, Azure CLI, DeepSeek Chat Completions, Azure OpenAI Embeddings.

## Global Constraints

- Production PostgreSQL, Redis, LINE, Graph, OneDrive, Notion, queues, and ClamAV publication are never called.
- DeepSeek is the sole semantic provider; Azure `text-embedding-3-small` uses exactly 1536 dimensions.
- The default suite has a hard ceiling of 10 DeepSeek requests and 3 embedding batches, provider concurrency exactly 1, no automatic retries, and a ten-minute full-run deadline.
- The host retrieves only ACA secrets `deepseek-api-key` and `azure-openai-embedding-key` from resource group `alive`, Container App `hhc-line-function-bot`.
- Secret bytes exist only in random mode-`0700` `/dev/shm` storage as mode-`0600` files, mounted read-only at `/run/secrets`; they never enter command arguments, environment variables, Docker `Config.Env`, logs, reports, Git, or `.env` files.
- Reports and console output contain allowlisted enums and counters only; they never contain raw messages, prompts, payloads, names, URLs, source identifiers, provider responses, or credentials.
- The local suite remains manual. Do not add it to PR CI, release CI, cron, watch mode, or an automatic retry path.
- Production layers must not import `src/testing`; do not add an acceptance mode, production test route, second router, or fallback provider.
- A complete run executes at most once per operator invocation. A single failed case may be rerun manually once only with its explicit case ID.
- Use synthetic fixtures only. No production LINE IDs, people, records, source IDs, URLs, or content may be copied into the suite.

---

### Task 1: Define immutable cases and provider-budget authority

**Files:**

- Create: `src/evals/kernel/local-live/contracts.ts`
- Create: `src/evals/kernel/local-live/cases.ts`
- Create: `src/evals/kernel/local-live/budget.ts`
- Create: `src/__tests__/kernel-local-live-budget.test.ts`

**Interfaces:**

- Produces: `KERNEL_LOCAL_LIVE_CASES: readonly KernelLocalLiveCase[]`.
- Produces: `selectKernelLocalLiveCases(caseId?: string): readonly KernelLocalLiveCase[]`.
- Produces: `validateKernelLocalLiveCost(cases): KernelLocalLiveCost`.
- Produces: `createProviderBudget(limits, caseContext): ProviderBudget`, whose `runDeepSeek` and `runEmbedding` increment before dispatch and serialize calls.
- `KernelLocalLiveCase` exposes `id`, `version`, `deepSeekMax`, `embeddingBatchMax`, and a bounded `journey` enum; it contains no message text or secret data.

- [ ] **Step 1: Write failing case-cost and budget tests.**

  Cover the eight exact IDs, the exact default totals `10` and `3`, unknown case rejection, single-case selection, increment-before-dispatch, rejection at request 11/batch 4, serial execution, zero retry after a thrown provider call, and sanitized observations:

  ```ts
  expect(validateKernelLocalLiveCost(KERNEL_LOCAL_LIVE_CASES)).toEqual({
    deepSeekMax: 10,
    embeddingBatchMax: 3
  });
  await expect(budget.runDeepSeek("schedule-explicit", failingCall)).rejects.toThrow(
    "provider_call_failed"
  );
  expect(budget.snapshot()).toMatchObject({ deepSeekRequests: 1 });
  ```

- [ ] **Step 2: Run the focused test and verify it fails because the modules do not exist.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-budget.test.ts
  ```

  Expected: FAIL with unresolved imports from `src/evals/kernel/local-live`.

- [ ] **Step 3: Implement the contracts and static suite.**

  Define these exact cost entries:

  ```ts
  [
    ["schedule-explicit", 1, 0],
    ["schedule-refinement", 2, 0],
    ["schedule-ambiguity", 1, 0],
    ["capability-switch", 2, 0],
    ["knowledge-follow-up", 2, 3],
    ["group-requester-isolation", 1, 0],
    ["provider-unavailable", 0, 0],
    ["write-preview-confirm", 1, 0]
  ];
  ```

  Freeze every case and reject duplicate IDs, non-integers, negative values, totals over the global limits, and an unknown selected ID.

- [ ] **Step 4: Implement the serialized budget wrapper.**

  Use a one-promise mutex, an acceptance-only `AsyncLocalStorage` case context
  set from the bounded event-ID prefix, and increment counters immediately
  before invoking the callback:

  ```ts
  export interface ProviderBudget {
    runDeepSeek<T>(caseId: KernelLocalLiveCaseId, call: () => Promise<T>): Promise<T>;
    runEmbedding<T>(caseId: KernelLocalLiveCaseId, call: () => Promise<T>): Promise<T>;
    snapshot(): KernelLocalLiveBudgetSnapshot;
  }
  ```

  Record only provider, case ID, ordinal, and `success | failed | budget_exhausted`. Never record request inputs, outputs, errors, URLs, or headers.

- [ ] **Step 5: Run the focused test and commit.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-budget.test.ts
  pnpm typecheck
  git diff --check
  ```

  Commit:

  ```bash
  git add src/evals/kernel/local-live src/__tests__/kernel-local-live-budget.test.ts
  git commit -m "test: bound Kernel local live provider calls"
  ```

### Task 2: Add allowlisted reports and Redis capture channels

**Files:**

- Create: `src/evals/kernel/local-live/report.ts`
- Create: `src/testing/kernel-local-live/redis-channel.ts`
- Create: `src/testing/kernel-local-live/capture-line-client.ts`
- Create: `src/__tests__/kernel-local-live-report.test.ts`
- Create: `src/__tests__/kernel-local-live-capture.test.ts`

**Interfaces:**

- Produces: `createKernelLocalLiveReport(input): KernelLocalLiveReport`.
- Produces: `writeKernelLocalLiveReport(report, rootDir): Promise<void>`.
- Produces: `assertNoSecretBytes(buffers, secretBytes): void`.
- Produces: `RedisKernelLocalLiveChannel` methods `writeReply`, `readReply`, `appendObservation`, `readObservations`, and `cleanup`.
- Produces: `createCaptureLineReplyClient(channel): LineReplyClient`.

- [ ] **Step 1: Write failing report-schema tests.**

  Assert stable key order, rejection of unknown properties, exact bounded failure-code enums, no raw `text`, `prompt`, `message`, `url`, `sourceId`, or provider payload fields, JSON/Markdown output under `artifacts/kernel-v1`, and secret-byte rejection without reflecting the secret:

  ```ts
  expect(() =>
    createKernelLocalLiveReport({ ...validInput, rawMessage: "synthetic text" } as never)
  ).toThrow("kernel_local_live_report_unknown_key");
  expect(() =>
    assertNoSecretBytes([Buffer.from("prefix-secret")], [Buffer.from("secret")])
  ).toThrow("kernel_local_live_secret_leak_detected");
  ```

- [ ] **Step 2: Write failing Redis reply-capture tests.**

  Use a narrow fake Redis client to prove reply tokens are one-shot, requester/run prefixes isolate values, quick-reply labels are captured without reply text, observations reject unknown keys, and `cleanup()` removes only the run prefix.

- [ ] **Step 3: Run both focused tests and verify missing-module failures.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-report.test.ts src/__tests__/kernel-local-live-capture.test.ts
  ```

- [ ] **Step 4: Implement the report and capture channel.**

  The report root must be:

  ```ts
  {
    schemaVersion: 1,
    caseSetVersion: 1,
    startedAt,
    completedAt,
    commit,
    selectedCaseIds,
    passed,
    cases,
    providers: { deepSeekRequests, embeddingBatches },
    cleanup: { namespace, compose, secretFiles, passed }
  }
  ```

  Case entries contain only `caseId`, `passed`, optional bounded `failureCode`, and allowlisted `disposition`, `capability`, `validatorReason`, `resultClass`, and `lifecycleOutcome` values. `createCaptureLineReplyClient` stores reply-token correlation plus quick-reply labels and a hash of reply text; it does not store reply text.

- [ ] **Step 5: Run focused tests and commit.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-report.test.ts src/__tests__/kernel-local-live-capture.test.ts
  pnpm typecheck
  git diff --check
  ```

  Commit:

  ```bash
  git add src/evals/kernel/local-live/report.ts \
    src/testing/kernel-local-live/redis-channel.ts \
    src/testing/kernel-local-live/capture-line-client.ts \
    src/__tests__/kernel-local-live-report.test.ts \
    src/__tests__/kernel-local-live-capture.test.ts
  git commit -m "test: sanitize Kernel local live evidence"
  ```

### Task 3: Compose the acceptance-only application with local persistence

**Files:**

- Create: `src/testing/kernel-local-live/config.ts`
- Create: `src/testing/kernel-local-live/provider-clients.ts`
- Create: `src/testing/kernel-local-live/fixtures.ts`
- Create: `src/testing/kernel-local-live/create-app.ts`
- Create: `src/testing/kernel-local-live/app-main.ts`
- Create: `src/__tests__/kernel-local-live-app.test.ts`
- Modify: `src/architecture/dependency-rules.ts`
- Modify: `src/__tests__/dependency-rules.test.ts`

**Interfaces:**

- Produces: `readKernelLocalLiveSecrets("/run/secrets"): KernelLocalLiveSecrets`.
- Produces: `createBudgetedProviderClients(config, budget)`.
- Produces: `seedKernelLocalLiveFixtures(stores, embedding): Promise<void>`.
- Produces: `createKernelLocalLiveApp(options): Promise<ApplicationRuntime>`.
- Consumes the production DeepSeek/Azure clients, controlled router, planner, validator, function definitions/modules, Fastify transport, PostgreSQL stores, Redis stores, and the capture client.

- [ ] **Step 1: Write failing secret/config tests.**

  Assert exactly two regular non-symlink files are accepted, both must be mode `0600`, empty values fail, the returned object cannot be serialized, and these production settings are rejected: LINE credentials, non-loopback database/Redis hosts, Graph, Notion, queues, and SearXNG.

- [ ] **Step 2: Write failing composition tests.**

  With fake pg/Redis/provider clients, assert the profile is exactly `acceptance`, webhook path is `/api/line/webhook/acceptance`, direct and group access use synthetic principals, enabled functions are limited to `query_schedule`, `query_knowledge`, and `save_resource`, replies use the capture client, and no LINE SDK/Graph/Notion/OneDrive/real queue client is constructed.

- [ ] **Step 3: Extend the dependency test before implementation.**

  Assert that `src/bootstrap`, `src/transport`, `src/application`, `src/capabilities`, and infrastructure files still cannot import `src/testing/kernel-local-live`. The new acceptance files remain classified as `testing`.

- [ ] **Step 4: Run the focused tests and verify they fail.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-app.test.ts src/__tests__/dependency-rules.test.ts
  ```

- [ ] **Step 5: Implement the acceptance composition.**

  Construct only the stores and modules required by the cases:

  - PostgreSQL: access, agent memory, schedule, and knowledge stores with real migrations.
  - Redis: sessions, conversation windows/active tasks, webhook idempotency, invite/confirmation state, rate limiting, trace metadata, and reply capture under a run prefix.
  - In-memory local fakes: catalog, cache, attachment/queue/line content, identity, jobs, and external writes.
  - Real clients: budget-wrapped DeepSeek routing/text generation and Azure embedding.

  Use `createFunctionRegistries` with the existing query-schedule vertical module plus the `query_knowledge` and `save_resource` modules. Construct the normal controlled planner/router and normal turn runtime, then pass them to the real webhook transport. Add an acceptance-only Fastify request hook that derives a declared case ID from the synthetic event ID and enters the provider `AsyncLocalStorage` context; it must reject undeclared prefixes. `app-main.ts` listens on port `3000`, writes only `kernel_local_live_app_ready`, and closes app/Redis/PostgreSQL on `SIGTERM` or `SIGINT`.

- [ ] **Step 6: Seed deterministic fixtures.**

  Seed one administrator, two direct users, one group/two requesters, one schedule domain and small schedule, one promoted knowledge source/document/two chunks, and one user `save_resource` grant. Generate the knowledge seed embeddings through one budgeted batch; do not store fixture prose in Redis observations or reports.

- [ ] **Step 7: Run focused tests, architecture check, and commit.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-app.test.ts src/__tests__/dependency-rules.test.ts
  pnpm architecture:check
  pnpm typecheck
  git diff --check
  ```

  Commit:

  ```bash
  git add src/testing/kernel-local-live src/architecture/dependency-rules.ts \
    src/__tests__/kernel-local-live-app.test.ts src/__tests__/dependency-rules.test.ts
  git commit -m "test: compose disposable Kernel acceptance app"
  ```

### Task 4: Drive signed webhook journeys with bounded assertions

**Files:**

- Create: `src/evals/kernel/local-live/webhook.ts`
- Create: `src/evals/kernel/local-live/journeys.ts`
- Create: `src/evals/kernel/local-live/driver.ts`
- Create: `src/tools/eval-kernel-local-live.ts`
- Create: `src/__tests__/kernel-local-live-webhook.test.ts`
- Create: `src/__tests__/kernel-local-live-journeys.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `createSignedLineWebhook(turn, channelSecret): SignedWebhookRequest`.
- Produces: `runKernelLocalLiveJourneys(options): Promise<KernelLocalLiveReportInput>`.
- Produces: `runKernelLocalLiveDriver(): Promise<0 | 1 | 2>`.
- The driver receives only non-secret app/Redis URLs, run ID, selected case ID, deadline, and commit. It never receives provider secret files.

- [ ] **Step 1: Write failing webhook construction tests.**

  Assert canonical LINE text/postback payloads, exact HMAC-SHA256 signature, invalid-signature request rejection, stable opaque event IDs, and duplicate event acknowledgement without a second reply/provider observation.

- [ ] **Step 2: Write failing journey-contract tests.**

  Assert the exact eight journeys, their bounded turn counts, case-to-requester/source mapping, no loops, no dynamic generation, one manual case selection, and these outcomes:

  ```ts
  {
    "schedule-explicit": "execute",
    "schedule-refinement": "active_task_continuation",
    "schedule-ambiguity": "clarify",
    "capability-switch": "explicit_switch",
    "knowledge-follow-up": "grounded_follow_up",
    "group-requester-isolation": "requester_isolated",
    "provider-unavailable": "providers_unavailable",
    "write-preview-confirm": "confirmed_local_write"
  }
  ```

- [ ] **Step 3: Run the tests and verify they fail.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-webhook.test.ts src/__tests__/kernel-local-live-journeys.test.ts
  ```

- [ ] **Step 4: Implement signed entrance and the eight journeys.**

  Send turns sequentially to `/api/line/webhook/acceptance`, wait for the one-shot capture record, and assert only reply hash presence, quick-reply labels, result/trace enums, store state, audit/outbox counts, and provider counters. For `group-requester-isolation`, seed requester A through `RedisConversationWindowStore.recordActiveTask` and send requester B's continuation through the webhook. For `provider-unavailable`, inject the local failing provider before outbound dispatch and assert the live DeepSeek count is unchanged. For `write-preview-confirm`, route one explicit attachment-save activation through DeepSeek, send a synthetic attachment event, purpose/title/preview turns, and final confirmation; all continuation turns consume no provider call, and the fake scan-work store plus fake queue must contain exactly one opaque work ID.

- [ ] **Step 5: Add the manual package command.**

  Add only:

  ```json
  "eval:kernel:local-live": "bash scripts/run-kernel-local-live.sh"
  ```

  Do not change `.github/workflows/ci.yml` or `.github/workflows/release.yml`.

- [ ] **Step 6: Run focused tests and commit.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-webhook.test.ts src/__tests__/kernel-local-live-journeys.test.ts
  pnpm typecheck
  git diff --check
  ```

  Commit:

  ```bash
  git add src/evals/kernel/local-live src/tools/eval-kernel-local-live.ts \
    src/__tests__/kernel-local-live-webhook.test.ts \
    src/__tests__/kernel-local-live-journeys.test.ts package.json
  git commit -m "test: drive bounded Kernel live journeys"
  ```

### Task 5: Add disposable Docker and secret lifecycle

**Files:**

- Create: `compose.kernel-local-live.yml`
- Create: `infra/kernel-local-live/init.sql`
- Create: `scripts/run-kernel-local-live.sh`
- Create: `src/__tests__/kernel-local-live-runner.test.ts`
- Modify: `Dockerfile`

**Interfaces:**

- Produces Docker target `kernel-local-live`, containing production dependencies and compiled acceptance tooling but no secrets.
- Produces one host command: `pnpm eval:kernel:local-live [-- --case CASE_ID]`.
- The Compose project has exactly `acceptance-app`, `acceptance-driver`, `postgres`, and `redis`.

- [ ] **Step 1: Write failing static runner/Compose tests.**

  Read the shell, Dockerfile, and Compose YAML as text and assert:

  - exact accepted CLI shape: no argument or `--case` plus one known ID;
  - `set +x` precedes secret retrieval;
  - an EXIT/INT/TERM trap is installed before `docker compose up`;
  - `mktemp -d /dev/shm/kernel-local-live.XXXXXXXX` plus `chmod 0700/0600`;
  - only the two approved secret names occur in the Azure query allowlist;
  - no secret value is used as a command argument, Compose variable, or environment entry;
  - secret files mount read-only at `/run/secrets`;
  - PostgreSQL, Redis, and driver attach only to `acceptance-internal`; only the app also attaches to `provider-egress`, database/Redis are disposable, and no service publishes a non-loopback port;
  - driver depends on healthy app/PostgreSQL/Redis;
  - `timeout --signal=TERM --kill-after=15s 10m`;
  - cleanup runs `down --volumes --remove-orphans` and removes the exact temporary directory;
  - no loop, cron, watch, restart-on-failure, or retry setting exists.

- [ ] **Step 2: Run the runner test and verify it fails.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-runner.test.ts
  ```

- [ ] **Step 3: Add the dedicated image target and Compose project.**

  The Docker target is based on `node:24-bookworm-slim`, copies `prod-deps` plus compiled `dist`, runs as `node`, and has no secret-related `ARG` or `ENV`. PostgreSQL uses `pgvector/pgvector:0.8.1-pg16`; Redis uses `redis:7.4.2-alpine`. The app mounts only the two files and joins `acceptance-internal` plus `provider-egress`; every other service joins only `acceptance-internal`. The driver mounts `artifacts/kernel-v1` for report output and never mounts `/run/secrets`.

- [ ] **Step 4: Implement the fail-closed host runner.**

  Before reading secrets, run static case-cost validation in a secretless container and print selected case IDs plus maximum counts. Require `az account show`, Docker, Compose, `/dev/shm`, clean tracked/untracked secret paths, and one invocation marker per case rerun. Query:

  ```bash
  az containerapp secret list \
    --resource-group alive \
    --name hhc-line-function-bot \
    --query "[?name=='deepseek-api-key' || name=='azure-openai-embedding-key']"
  ```

  Parse values without stdout, write exact files through file descriptors with tracing disabled, start Compose under the ten-minute timeout, capture sanitized output in the memory-backed directory, run byte-for-byte leak checks against output/Compose config/report/Git diff, then clean namespaces and Compose resources. Preserve the driver exit class, but make any leak or cleanup failure return `2`.

- [ ] **Step 5: Add cleanup-path tests.**

  Execute the shell with fake `az`, `docker`, and `timeout` binaries to cover success, Azure failure before Compose, app failure, timeout, INT, TERM, cleanup failure, secret-leak detection, and rejection of production DB/Redis/LINE secret settings. Each test asserts the fake compose log ends with the exact `down --volumes --remove-orphans` call and the temporary directory is absent.

- [ ] **Step 6: Run runner tests, render Compose config without secrets, and commit.**

  Run:

  ```bash
  pnpm vitest run src/__tests__/kernel-local-live-runner.test.ts
  docker compose -f compose.kernel-local-live.yml config --no-interpolate
  pnpm typecheck
  git diff --check
  ```

  Commit:

  ```bash
  git add Dockerfile compose.kernel-local-live.yml infra/kernel-local-live \
    scripts/run-kernel-local-live.sh src/__tests__/kernel-local-live-runner.test.ts
  git commit -m "test: run Kernel acceptance in disposable Compose"
  ```

### Task 6: Complete deterministic verification and run the bounded live suite once

**Files:**

- Modify only if verification exposes a defect in Task 1-5 files.
- Generated and ignored: `artifacts/kernel-v1/local-live-report.json`
- Generated and ignored: `artifacts/kernel-v1/local-live-report.md`

**Interfaces:**

- Consumes the manual `eval:kernel:local-live` command.
- Produces one sanitized report tied to the exact implementation commit.

- [ ] **Step 1: Run every focused local-live test.**

  Run:

  ```bash
  pnpm vitest run \
    src/__tests__/kernel-local-live-budget.test.ts \
    src/__tests__/kernel-local-live-report.test.ts \
    src/__tests__/kernel-local-live-capture.test.ts \
    src/__tests__/kernel-local-live-app.test.ts \
    src/__tests__/kernel-local-live-webhook.test.ts \
    src/__tests__/kernel-local-live-journeys.test.ts \
    src/__tests__/kernel-local-live-runner.test.ts
  ```

  Expected: all tests pass with zero live provider calls.

- [ ] **Step 2: Run the deterministic repository gates before obtaining secrets.**

  Run:

  ```bash
  pnpm format:check
  pnpm typecheck
  pnpm lint
  pnpm architecture:check
  pnpm test
  pnpm config:validate
  pnpm eval:agent
  pnpm eval:kernel
  pnpm eval:kernel:integration
  pnpm build
  ```

  Expected: every command exits `0`; integration owns and removes its disposable dependencies.

- [ ] **Step 3: Commit any deterministic corrections and require a clean worktree.**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Commit only scoped corrections, then record `git rev-parse HEAD` as the commit under live acceptance.

- [ ] **Step 4: Run the complete live suite exactly once.**

  Run:

  ```bash
  pnpm eval:kernel:local-live
  ```

  Expected sanitized terminal summary:

  ```text
  Kernel v1 local live: PASS cases=8 deepseek<=10 embedding<=3 cleanup=PASS
  ```

  Do not automatically rerun on failure. Diagnose from the bounded failure code. A single-case rerun is allowed once only with `pnpm eval:kernel:local-live -- --case CASE_ID`.

- [ ] **Step 5: Inspect evidence and cleanup without printing secrets or raw text.**

  Verify JSON schema/version, eight pass results, exact commit, provider counters within limits, cleanup all true, no external-write count, no containers/networks/volumes with the run project name, no `/dev/shm/kernel-local-live.*` directory, and a clean Git secret scan.

### Task 7: Record the Kernel handoff, review, and open the protected PR

**Files:**

- Modify: `docs/kernel-v1/acceptance-baseline.md`
- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `docs/runbooks/production-operations.md`

**Interfaces:**

- Produces a current Kernel v1 acceptance baseline that permits R4 Product Experience.
- Produces an operator runbook for the manual local live command and its limitations.
- Does not change production runtime, manifests, workflows, or cloud resources.

- [ ] **Step 1: Update the acceptance baseline from the successful report.**

  Record report schema/case-set version, exact tested commit, date, case count, actual DeepSeek and embedding counts, cleanup/leak-scan outcome, and the four proven properties: real DeepSeek routing, real Azure embedding, real webhook signing/controlled runtime, and local PostgreSQL/Redis lifecycle/requester isolation.

- [ ] **Step 2: Record the explicit limitations and R4 decision.**

  State that local simulation does not prove LINE platform delivery/reply-token behavior, production latency, production PostgreSQL/Redis failover, or Graph/Notion/OneDrive/queue/ClamAV availability. Assign those operational checks to R5 and mark Kernel v1 accepted for R4 entry.

- [ ] **Step 3: Document the operator command and safety contract.**

  In README/architecture/runbook, document prerequisites, the default and single-case commands, hard provider limits, no-retry rule, two-secret scope, `/dev/shm` lifecycle, ignored report paths, and the fact that the command is manual and absent from CI.

- [ ] **Step 4: Run final verification after documentation changes.**

  Run:

  ```bash
  pnpm format:check
  pnpm typecheck
  pnpm lint
  pnpm architecture:check
  pnpm test
  pnpm config:validate
  pnpm eval:agent
  pnpm eval:kernel
  pnpm eval:kernel:integration
  pnpm build
  git diff --check
  ```

- [ ] **Step 5: Commit the accepted baseline.**

  Commit:

  ```bash
  git add docs/kernel-v1/acceptance-baseline.md README.md \
    docs/architecture-context.md docs/runbooks/production-operations.md
  git commit -m "docs: accept Kernel v1 local live gate"
  ```

- [ ] **Step 6: Perform completion review and protected-branch delivery.**

  Use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. Resolve every valid finding and rerun affected/full gates. Push `codex/kernel-local-live-acceptance`, open a PR to `main`, confirm the diff contains no secrets/artifacts, and wait for required `PR CI`.

- [ ] **Step 7: Stop before production deployment.**

  Do not enable auto-merge because these code/tool changes trigger `.github/workflows/release.yml` after merge. Report the green PR as safe to merge and deploy only after the user gives explicit deployment approval.

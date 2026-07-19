# R0 Observable Decision Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every controlled-agent turn supportable without storing user content by exposing a stable support ID, bounded execution-path diagnostics, persistent recent route records, and deterministic offline product regressions.

**Architecture:** Keep the existing controlled router authoritative and add a privacy boundary around operational diagnostics. Derive opaque identifiers with HMAC-SHA256, allowlist every diagnostic enum, carry ephemeral handler diagnostics only as far as trace/telemetry, and persist already-sanitized recent routes in Redis when configured. Product events remain structured logs so Azure Monitor can aggregate them without adding a second analytics database.

**Tech Stack:** TypeScript, Fastify, Vitest, Redis, Node `crypto`, structured JSON logs, pnpm.

## Global Constraints

- Never store raw LINE user/group/room IDs, user text, file names, titles, URLs, invite codes, secrets, provider payloads, or generated links in traces.
- `requestId` remains internal; diagnostic output uses only an opaque `supportId`.
- The controlled router, validator, and task state machine remain authoritative; observability must not influence routing.
- Handler diagnostics are response-only and must never enter LINE replies, active-task state, resource memory, or catalog rows.
- LINE bot self-reference remains first-person `我`.
- All new telemetry values are closed allowlists or bounded numeric buckets.

---

### Task 1: Privacy-safe support and actor identifiers

**Files:**
- Create: `src/observability/opaque-identifiers.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `src/__tests__/opaque-identifiers.test.ts`
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `createSupportId(requestId: string): string` and `createActorFingerprint(input, key): string | undefined`.
- Produces: `AppConfig.observability.hmacKey?: string` loaded from `OBSERVABILITY_HMAC_KEY`.

- [ ] **Step 1: Write failing tests** proving support IDs are stable, domain-separated, match `^[a-f0-9]{16}$`, reveal no input fragment, and actor fingerprints change across profile/source/requester. Add config tests proving the key is optional outside production and required in production.
- [ ] **Step 2: Run tests to verify failure** with `pnpm test -- src/__tests__/opaque-identifiers.test.ts src/__tests__/config.test.ts`; expect missing module/config assertions.
- [ ] **Step 3: Implement opaque identifiers** with `createHmac("sha256", key)` for actor scope and `createHash("sha256")` for per-request support ID, both domain-separated and truncated to 16 lowercase hex characters. Reject keys shorter than 32 characters in production config.
- [ ] **Step 4: Run the focused tests** and expect all passing.
- [ ] **Step 5: Commit** with `git commit -m "feat: add privacy-safe observability identifiers"`.

### Task 2: Replace redacted request markers with stable support IDs

**Files:**
- Modify: `src/observability/action-telemetry.ts`
- Modify: `src/observability/last-route-store.ts`
- Modify: `src/observability/last-error-store.ts`
- Modify: `src/agent/trace-store.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/server.ts`
- Test: `src/__tests__/agent-trace-store.test.ts`
- Test: `src/__tests__/entrance.test.ts`

**Interfaces:**
- Consumes: `createSupportId(requestId)` from Task 1.
- Produces: records and admin diagnostic output containing `supportId`, never raw `requestId`.

- [ ] **Step 1: Change tests first** so trace, route, and error records expect the same 16-character support ID for the same internal request ID; assert raw UUIDs and sensitive payloads are absent.
- [ ] **Step 2: Run focused tests** and confirm they fail because existing sanitizers emit `requestId=present`.
- [ ] **Step 3: Add `supportId` to allowlisted telemetry** and compute it only at the request boundary. Remove `requestId` from public diagnostic record interfaces and formatters while retaining it inside runtime inputs and state keys.
- [ ] **Step 4: Add support code to failure replies** as `發生錯誤，請稍後再試。（支援碼：<id>）`; successful replies remain unchanged.
- [ ] **Step 5: Run focused tests** and expect passing with no raw IDs or content.
- [ ] **Step 6: Commit** with `git commit -m "feat: correlate agent diagnostics with support ids"`.

### Task 3: Bounded execution-path diagnostics

**Files:**
- Create: `src/observability/retrieval-diagnostics.ts`
- Modify: `src/types.ts`
- Modify: `src/observability/action-telemetry.ts`
- Modify: `src/agent/trace-store.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/functions/find-ppt-slides.ts`
- Test: `src/__tests__/action-telemetry.test.ts`
- Test: `src/__tests__/agent-runtime.test.ts`
- Test: `src/__tests__/find-ppt-slides.test.ts`
- Test: `src/__tests__/controlled-agent-turn-runtime.test.ts`

**Interfaces:**
- Produces: `FunctionExecutionResult.diagnostics?: RetrievalDiagnostics`, documented as ephemeral and non-persistent.
- Produces: execution modes `fresh_search`, `explicit_task_replay`, `alias_recall`, `resource_memory_candidate`, `catalog_snapshot_read`, `provider_fallback`.
- Produces: age buckets `under_1m`, `under_10m`, `under_1h`, `under_1d`, `under_30d`, `unknown`; freshness `fresh`, `stale_allowed`, `stale_rejected`, `unknown`.

- [ ] **Step 1: Add failing sanitizer tests** showing only the declared execution mode, state-age bucket, freshness status, revision marker, query fingerprint, and reference fingerprint survive; arbitrary strings disappear.
- [ ] **Step 2: Add failing behavior tests** for alias replay, resource-memory exact hit, catalog hit, Graph fallback, and active-task continuation, each expecting its execution mode and no raw query/title/reference in traces.
- [ ] **Step 3: Implement the diagnostics contract** in a focused module with enum guards and HMAC fingerprint helpers. Mark `FunctionExecutionResult.diagnostics` response-only and explicitly omit it from active-task/result envelopes.
- [ ] **Step 4: Instrument the existing paths** without changing routing or retrieval results. Compute active-task age from `createdAt`; attach diagnostics at alias, remembered resource, catalog, and provider paths; copy only sanitized fields into agent trace steps and structured route events.
- [ ] **Step 5: Run focused tests** and verify every path is distinguishable and privacy assertions pass.
- [ ] **Step 6: Commit** with `git commit -m "feat: trace bounded retrieval execution paths"`.

### Task 4: Redis-backed recent route diagnostics

**Files:**
- Create: `src/observability/create-last-route-store.ts`
- Modify: `src/observability/last-route-store.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/last-route-store.test.ts`
- Test: `src/__tests__/startup-wiring.test.ts`

**Interfaces:**
- Produces: `RedisLastRouteStore` using `${keyPrefix}:last-routes:v2` and storing sanitized records only.
- Produces: `createLastRouteStore({ redis, maxEntries })` returning Redis or in-memory implementation.

- [ ] **Step 1: Add failing parity tests** for record/list/clear, bounded retention, corrupt-entry skipping, and proof that Redis JSON contains no raw request ID or query.
- [ ] **Step 2: Run focused tests** and confirm the factory/store are missing.
- [ ] **Step 3: Implement Redis persistence** following the existing last-error/agent-trace patterns, sanitizing before `JSON.stringify` and bounding entries to 1–100.
- [ ] **Step 4: Wire the factory in `src/index.ts`** so multi-replica production diagnostics share recent routes while local development remains in-memory.
- [ ] **Step 5: Run focused tests** and expect passing.
- [ ] **Step 6: Commit** with `git commit -m "feat: persist sanitized route diagnostics in redis"`.

### Task 5: Product events and deterministic retrieval regression corpus

**Files:**
- Create: `src/observability/product-events.ts`
- Create: `src/evals/fixtures/retrieval-product-cases.ts`
- Create: `src/tools/run-retrieval-product-evals.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Test: `src/__tests__/product-events.test.ts`
- Test: `src/__tests__/retrieval-product-evals.test.ts`

**Interfaces:**
- Produces: `emitProductEvent(observer, event)` with event names `registration_completed`, `clarification_requested`, `function_completed`, `write_previewed`, `write_committed`, and `retry_observed`.
- Produces: `pnpm eval:retrieval-product`, deterministic and offline.

- [ ] **Step 1: Add failing product-event tests** that require actor fingerprint, support ID, function, result class, clarification count bucket, latency bucket, and retry marker while rejecting all content fields.
- [ ] **Step 2: Add failing regression cases** covering two sequential PPT queries, alias recall visibility, active-task follow-up, schedule-domain ambiguity, explicit schedule domain, not-found, unavailable, and write preview/commit precedence.
- [ ] **Step 3: Implement product event sanitization/emission** using the existing route observer. Do not store aggregation state; first-success is derived downstream by earliest successful `function_completed` per actor fingerprint.
- [ ] **Step 4: Implement the offline runner** using deterministic stubs and fail the process when expected action, result class, execution mode, or clarification behavior differs.
- [ ] **Step 5: Run** `pnpm test -- src/__tests__/product-events.test.ts src/__tests__/retrieval-product-evals.test.ts` and `pnpm eval:retrieval-product`; expect all passing.
- [ ] **Step 6: Commit** with `git commit -m "test: add retrieval product telemetry and regressions"`.

### Task 6: R0 operations contract, full verification, and delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `AGENTS.md`
- Create: `docs/operations/controlled-agent-support.md`

**Interfaces:**
- Documents: support-code lookup, execution-mode interpretation, Azure Monitor queries, secret configuration, regression command, and the R0 baseline checklist.

- [ ] **Step 1: Document the support workflow**: locate support ID in `/last-agent-turns`, `/last-routes`, and `/last-errors`; map execution modes; verify second-query behavior; rotate `OBSERVABILITY_HMAC_KEY` only with an accepted actor-series break.
- [ ] **Step 2: Add Azure Monitor query examples** that compute first successful function, result-class rates, clarification rate, p50/p95 latency, retry rate, and execution-mode distribution without user content.
- [ ] **Step 3: Run complete verification**: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm eval:agent`, and `pnpm eval:retrieval-product`; all must exit 0.
- [ ] **Step 4: Review the diff for privacy** with `rg -n "messageText|replyText|fileName|displayName|accessToken|channelSecret" src/observability src/agent/trace-store.ts` and confirm no diagnostic serializer accepts these values.
- [ ] **Step 5: Commit documentation** with `git commit -m "docs: define controlled agent support baseline"`.
- [ ] **Step 6: Push branch, open PR, wait for CI, merge, and verify production deployment** according to repository policy before beginning R1.

## Self-review result

- Spec coverage: support correlation, execution mode, state age, source freshness/revision markers, product events, persistent diagnostics, and offline regressions each map to a task.
- Privacy: no raw content or principal identifiers cross the diagnostic boundary; product identity is keyed and opaque.
- Type consistency: `supportId`, `RetrievalDiagnostics`, product events, and Redis store interfaces have one producing task and explicit consumers.
- Scope: R0 observes stale catalog and cache paths but does not alter their lifecycle; lifecycle changes remain R1 and publication freshness remains R3.

# Contract-Driven Agent Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every enabled LINE function participate in one contract-driven, requester-scoped planning, continuation, ambiguity, and focused-response lifecycle.

**Architecture:** Extend function contracts with safe planner summaries, response projections, retrieval-evidence declarations, and write-to-read handoffs. Replace same-function active tasks with typed task frames, put pending capability resolution and required-slot collection ahead of new planning, and keep DeepSeek/Ollama advisory behind deterministic validation. Stored content can nominate a function through bounded opaque evidence providers, but model output never grants authority.

**Tech Stack:** TypeScript 5, Fastify, Vitest, Zod, PostgreSQL, pgvector, Redis, LINE Messaging API, DeepSeek, Ollama `bge-m3`, GitHub Actions, Azure Container Apps with Dapr.

## Global Constraints

- The bot is a restricted church helper, not an open-ended chat bot.
- Controlled routing remains authoritative; do not add runtime switches, shadow routing, or a second router.
- DeepSeek remains primary `function_routing`; Ollama remains fallback.
- Group state is always profile/source/requester scoped and never consumes raw whole-group chat.
- Model input must not contain raw stored content, people, URLs, temporary links, file names, secrets, or provider payloads.
- Write functions remain admin or explicit-user-grant only and retain preview plus explicit confirmation.
- Binary publication remains exclusively in the existing `save_resource` publisher.
- Conversational self-reference uses `我`, not third-person `小哈`.
- Default successful read replies contain only the field requested; full content requires explicit intent or a follow-up action.
- Task-frame TTL is 600 seconds and is independent from `generalAgent.conversationWindowSeconds`.
- Existing `bge-m3` and 1024-dimensional pgvector storage are reused; no second embedding model is added.
- Every task follows red-green-refactor and ends with independently passing targeted tests.

## Execution Record

- Implemented Tasks 1-9 on `codex/contract-agent-kernel` with targeted red/green tests and task-scoped commits.
- Full local gate on 2026-07-16: formatting, typecheck, lint, 89 test files / 806 tests, production profile validation, deterministic agent eval 19/19, and build all passed.
- Live planner eval was attempted but the isolated worktree does not contain the uncommitted `LINE_HELPER_CHANNEL_SECRET` environment reference; no CI or runtime policy was weakened to bypass it.
- Task 10 PR, required `PR CI`, squash merge, GitHub release, ACA revision check, and production smoke test remain the final release steps after this execution record is committed.

---

### Task 1: Extend Capability and Result Contracts

**Files:**

- Modify: `src/functions/definitions.ts`
- Modify: `src/agent/result-envelope.ts`
- Modify: `src/types.ts`
- Test: `src/__tests__/agent-capability-contracts.test.ts`
- Test: `src/__tests__/function-contracts.test.ts`

**Interfaces:**

- Produces: `AgentOperation`, `AgentResponseProjection`, `AgentCapabilityHandoff`, `AgentReplyData`, and extended `AgentCapabilityContract` / `AgentResultEnvelope`.
- Consumes: existing `FunctionName`, `JsonRecord`, `QuickReplyItem`, and Zod argument schemas.

- [ ] **Step 1: Write failing contract tests**

Add assertions equivalent to:

```ts
for (const definition of enabledReadDefinitions) {
  expect(definition.agentCapability?.semanticDescription).toBeTruthy();
  expect(definition.agentCapability?.responseProjection?.defaultMode).toMatch(/focused|full/);
}

expect(getFunctionDefinition("save_schedule")?.agentCapability?.handoffs).toContainEqual(
  expect.objectContaining({ to: "query_schedule" })
);
```

- [ ] **Step 2: Run tests and verify contract failures**

Run: `pnpm vitest run src/__tests__/agent-capability-contracts.test.ts src/__tests__/function-contracts.test.ts`

Expected: FAIL because semantic descriptions, projections, and handoffs do not exist.

- [ ] **Step 3: Add shared contract types**

Implement these exact public shapes:

```ts
export type AgentOperation = "continue" | "refine" | "advance" | "select" | "view_full";

export interface AgentResponseField {
  label: string;
  aliases: string[];
}

export interface AgentResponseProjection {
  defaultMode: "focused" | "full";
  fields: Record<string, AgentResponseField>;
}

export interface AgentCapabilityHandoff {
  on: "success";
  to: FunctionName;
  map: Record<string, string>;
  when?: Record<string, string>;
}

export interface AgentReplyData {
  kind: string;
  fields: JsonRecord;
  records?: JsonRecord[];
}
```

Extend `AgentCapabilityContract` with `semanticDescription`, `responseProjection`, and `handoffs`. Extend `AgentResultEnvelope` with optional `replyData` and `projectionHint`.

- [ ] **Step 4: Populate every function definition**

Give every read capability a bounded semantic description, declared output fields, and meaningful operations. Add declarative handoffs:

```ts
handoffs: [{ on: "success", to: "query_schedule", map: { scheduleType: "scheduleType" } }];
```

For `save_resource`, use three handoffs with `when: { resourceKind: ... }`. Do not add branching in the router.

- [ ] **Step 5: Run targeted tests and commit**

Run: `pnpm vitest run src/__tests__/agent-capability-contracts.test.ts src/__tests__/function-contracts.test.ts`

Expected: PASS.

Commit: `git commit -am "feat: extend agent capability contracts"`

### Task 2: Replace Active Task Version 1 with Task Frame Version 2

**Files:**

- Create: `src/agent/task-frame.ts`
- Create: `src/agent/task-frame-codec.ts`
- Modify: `src/agent/active-task-transition.ts`
- Modify: `src/agent/context-manager.ts`
- Modify: `src/config.ts`
- Modify: `config/profiles.json`
- Modify: `src/agent/turn-runtime.ts`
- Delete: `src/agent/active-task.ts`
- Delete: `src/agent/active-task-codec.ts`
- Test: `src/__tests__/active-task.test.ts`
- Test: `src/__tests__/context-manager.test.ts`
- Test: `src/__tests__/config.test.ts`

**Interfaces:**

- Produces: `AgentTaskFrame`, `taskFrameFromResult()`, `prepareTaskFrameForStorage()`, and `agentTaskFrameSeconds` profile config.
- Consumes: Task 1 `AgentOperation`, `AgentResultEnvelope`, `FunctionName`, and existing requester-scoped `ConversationWindowStore`.

- [ ] **Step 1: Convert tests to version-2 expectations**

Cover independent TTL, allowed handoff capabilities, expired frame rejection, unsupported operation rejection, and content sanitization:

```ts
expect(frame).toMatchObject({
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
  responseContext: { defaultProjection: "focused" }
});
expect(frame.expiresAt).toBe("2026-07-16T10:10:00.000Z");
```

- [ ] **Step 2: Verify tests fail against version 1**

Run: `pnpm vitest run src/__tests__/active-task.test.ts src/__tests__/context-manager.test.ts src/__tests__/config.test.ts`

Expected: FAIL on version, TTL, and handoff fields.

- [ ] **Step 3: Implement the task-frame type and codec**

Use this exact core interface:

```ts
export interface AgentTaskFrame {
  version: 2;
  currentCapability: FunctionName;
  allowedCapabilities: FunctionName[];
  anchors: JsonRecord;
  entities: AgentEntity[];
  references?: JsonRecord;
  supportedOperations: AgentOperation[];
  responseContext?: {
    availableFields: string[];
    defaultProjection: "focused" | "full";
  };
  createdAt: string;
  expiresAt: string;
}
```

The codec must bound arrays/keys/strings, allow only declared entity types and operations, and reject version 1 rather than silently widening it.

- [ ] **Step 4: Add independent profile TTL**

Add `agentRuntime.taskFrameSeconds` with schema range 60..3600 and default 600. Set helper production config to 600. Replace `activeTaskTtlMs()` with `taskFrameTtlMs()` and never read `generalAgent.conversationWindowSeconds` there.

- [ ] **Step 5: Migrate stores and runtime naming**

Rename store methods to `taskFrame`, `recordTaskFrame`, and `clearTaskFrame`; update Redis/in-memory keys with a `v2` suffix so stale version-1 values cannot be interpreted. Update runtime and trace lifecycle terms from active task to task frame.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run src/__tests__/active-task.test.ts src/__tests__/context-manager.test.ts src/__tests__/config.test.ts src/__tests__/agent-turn-runtime.test.ts`

Expected: PASS.

Commit: `git add src config && git commit -m "feat: add typed agent task frames"`

### Task 3: Make Planner Summaries Contract-Complete but Content-Free

**Files:**

- Modify: `src/agent/planner.ts`
- Modify: `src/agent/plan-validator.ts`
- Modify: `src/agent/capability-candidates.ts`
- Test: `src/__tests__/agent-planner.test.ts`
- Test: `src/__tests__/plan-validator.test.ts`
- Test: `src/__tests__/capability-candidates.test.ts`

**Interfaces:**

- Produces: bounded `CandidateSummary` containing semantic description, required slot names, output field names, and operations.
- Consumes: Task 1 contracts and Task 2 `AgentTaskFrame`.

- [ ] **Step 1: Add failing planner redaction and completeness tests**

Assert that the prompt contains `semanticDescription`, `requiredSlots`, and declared field names, but excludes entity labels, stored values, source titles, URLs, people, and file names.

- [ ] **Step 2: Run targeted tests to see the missing summaries**

Run: `pnpm vitest run src/__tests__/agent-planner.test.ts src/__tests__/plan-validator.test.ts src/__tests__/capability-candidates.test.ts`

Expected: FAIL because the current summary contains only entity/refinement/operation metadata.

- [ ] **Step 3: Build safe candidate summaries**

Implement:

```ts
interface CandidateSummary {
  capability: FunctionName;
  reason: CapabilityCandidateReason;
  score: number;
  semanticDescription: string;
  requiredSlots: string[];
  responseFields: string[];
  operations: AgentOperation[];
}
```

Populate required slots from definitions outside model output. Limit descriptions to 300 characters, slots/fields to 20, and field names to 80 characters.

- [ ] **Step 4: Revalidate task-frame continuation**

The validator must require current effective-function access, source permission, unexpired frame, selected capability in `allowedCapabilities`, operation intersection, and current-message elliptical/entity/field evidence. A frame never overrides explicit capability switch evidence.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run src/__tests__/agent-planner.test.ts src/__tests__/plan-validator.test.ts src/__tests__/capability-candidates.test.ts`

Expected: PASS.

Commit: `git commit -am "feat: enrich safe planner capability summaries"`

### Task 4: Add Catalog, Schedule, and Memory Evidence Providers

**Files:**

- Create: `src/agent/evidence/types.ts`
- Create: `src/agent/evidence/registry.ts`
- Create: `src/agent/evidence/catalog-provider.ts`
- Create: `src/agent/evidence/schedule-provider.ts`
- Create: `src/agent/evidence/memory-provider.ts`
- Move: `src/knowledge/retrieval-evidence.ts` -> `src/agent/evidence/knowledge-provider.ts`
- Modify: `src/agent/controlled-agent-router.ts`
- Modify: `src/agent/capability-candidates.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/plan-evidence.test.ts`
- Test: `src/__tests__/capability-candidates.test.ts`
- Create: `src/__tests__/evidence-providers.test.ts`

**Interfaces:**

- Produces: `CapabilityEvidenceProvider`, `CapabilityEvidenceProbe`, `createCapabilityEvidenceRegistry()`.
- Consumes: catalog, schedule, agent-memory stores and the existing knowledge evidence behavior.

- [ ] **Step 1: Write failing bounded-provider tests**

Use this contract:

```ts
export interface CapabilityEvidenceProbe {
  matched: boolean;
  confidence: "low" | "medium" | "high";
  opaqueIds?: string[];
}

export interface CapabilityEvidenceProvider {
  probe(input: {
    profileName: string;
    source: FunctionAllowedSource;
    requesterUserId?: string;
    sourceId: string;
    text: string;
    maxResults: number;
  }): Promise<CapabilityEvidenceProbe>;
}
```

Test maximum result counts, no raw content return, expired-memory exclusion, resource-kind separation, and provider-failure fail-closed behavior.

- [ ] **Step 2: Run tests and verify providers do not exist**

Run: `pnpm vitest run src/__tests__/evidence-providers.test.ts src/__tests__/plan-evidence.test.ts src/__tests__/capability-candidates.test.ts`

Expected: FAIL on missing modules and content-only candidates.

- [ ] **Step 3: Implement provider registry and adapters**

The registry groups requested providers by name, calls each provider at most once per turn, clamps `maxResults` to 20, catches errors, and returns only matched capability names to candidate generation.

Catalog provider maps authorized catalog kinds to `find_ppt_slides`, `find_sheet_music`, or `find_resource`. Schedule provider matches stored series/date/meeting/role metadata. Memory provider searches only visible, unexpired explicit memories. Knowledge provider preserves the existing body-only engagement/write guard.

- [ ] **Step 4: Wire definitions and composition root**

Declare `retrievalEvidence` on all four read families and construct the providers in `src/index.ts`. Pass requester/source scope through `ControlledAgentRouterInput`; do not infer it from planner output.

- [ ] **Step 5: Add content-only cases and commit**

Add cases such as `奔跑不放棄`, `7/21 家族是誰`, a remembered sentence question, and a Notion-body-only question. Verify unrelated small talk and write intent do not activate read evidence.

Run: `pnpm vitest run src/__tests__/evidence-providers.test.ts src/__tests__/capability-candidates.test.ts src/__tests__/controlled-agent-router.test.ts`

Expected: PASS.

Commit: `git add src && git commit -m "feat: add bounded capability evidence registry"`

### Task 5: Implement Resumable Cross-Capability Resolution

**Files:**

- Create: `src/agent/capability-resolution.ts`
- Modify: `src/functions/pending-resolution.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/agent/controlled-agent-router.ts`
- Test: `src/__tests__/controlled-resolution.test.ts`
- Test: `src/__tests__/pending-resolution.test.ts`
- Test: `src/__tests__/agent-turn-runtime.test.ts`

**Interfaces:**

- Produces: `PendingCapabilityResolution`, `createCapabilityResolutionReply()`, and `resumeCapabilityResolution()`.
- Consumes: requester-scoped session/selection store and deterministic plan validator.

- [ ] **Step 1: Write failing ambiguity journey tests**

Test that two valid schedule/resource candidates produce named Quick Replies, store the original request, resume on numeric/postback/text choice, reject a different group requester, and expire cleanly.

- [ ] **Step 2: Verify current generic clarification loses state**

Run: `pnpm vitest run src/__tests__/controlled-resolution.test.ts src/__tests__/pending-resolution.test.ts src/__tests__/agent-turn-runtime.test.ts`

Expected: FAIL because no cross-capability pending state exists.

- [ ] **Step 3: Implement the pending state**

```ts
export interface PendingCapabilityResolution {
  version: 1;
  profileName: string;
  sourceKey: string;
  requesterUserId: string;
  originalText: string;
  candidates: Array<{ capability: FunctionName; label: string }>;
  groundedArguments: JsonRecord;
  references?: JsonRecord;
  expiresAt: string;
}
```

Bound text to 2,000 characters, candidates to 5, and records to the planner schema limits. Never store retrieved content.

- [ ] **Step 4: Put resolution before new planning**

In the turn state machine, consume cancel/selection before slot collection and planning. On selection, rebuild a one-candidate validated plan using the original text and current effective permissions. If access was revoked, deny and clear state.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run src/__tests__/controlled-resolution.test.ts src/__tests__/pending-resolution.test.ts src/__tests__/agent-turn-runtime.test.ts src/__tests__/entrance.test.ts`

Expected: PASS.

Commit: `git add src && git commit -m "feat: resume cross-capability clarifications"`

### Task 6: Add Generic Focused Response Projection

**Files:**

- Create: `src/agent/response-projector.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/functions/query-schedule.ts`
- Modify: `src/functions/query-knowledge.ts`
- Modify: `src/functions/find-resource.ts`
- Modify: `src/functions/find-ppt-slides.ts`
- Modify: `src/functions/find-sheet-music.ts`
- Modify: `src/functions/query-wikipedia.ts`
- Modify: `src/functions/retrieve-memory.ts`
- Test: `src/__tests__/query-schedule.test.ts`
- Create: `src/__tests__/response-projector.test.ts`

**Interfaces:**

- Produces: `projectAgentReply(input): FunctionExecutionResult`.
- Consumes: Task 1 response fields/reply data and normalized current user text.

- [ ] **Step 1: Write failing focused-answer tests**

Cover role, family, date, location ordinal, resource title, and explicit `完整內容`. Assert `直播是誰` does not contain unrelated roles or repeat the schedule header/body.

- [ ] **Step 2: Run tests and confirm full-record behavior fails them**

Run: `pnpm vitest run src/__tests__/response-projector.test.ts src/__tests__/query-schedule.test.ts`

Expected: FAIL because handlers own pre-rendered full replies.

- [ ] **Step 3: Return structured reply data from handlers**

For schedules, emit records shaped as:

```ts
replyData: {
  kind: "schedule",
  fields: { date, meeting, scheduleType },
  records: roles.map(({ role, people }) => ({ role, people }))
}
```

Use analogous declared fields for resources, Wikipedia, knowledge, and memory. Preserve `replyText` as a safe full fallback while migration is incomplete.

- [ ] **Step 4: Implement projection**

Match current text against contract field aliases and structured role names. Return one requested field plus the shortest disambiguating anchor. Select full mode only for explicit `完整`, `全部`, `整份`, or `查看全文` intent. When multiple records match, invoke generic resolution rather than concatenate all records.

- [ ] **Step 5: Apply projection after successful execution**

Call the projector centrally after handler success and before LINE delivery/task-frame transition. Record only `focused|full|fallback` in trace metadata.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run src/__tests__/response-projector.test.ts src/__tests__/query-schedule.test.ts src/__tests__/functions.test.ts`

Expected: PASS.

Commit: `git add src && git commit -m "feat: project focused function replies"`

### Task 7: Add Read Continuations and Write-to-Read Handoffs

**Files:**

- Modify: `src/agent/task-frame.ts`
- Modify: `src/agent/active-task-transition.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/functions/save-schedule.ts`
- Modify: `src/functions/save-memory.ts`
- Modify: `src/functions/save-resource.ts`
- Modify: all read handlers that currently emit empty `supportedOperations`
- Test: `src/__tests__/active-task.test.ts`
- Test: `src/__tests__/attachment-save.test.ts`
- Test: `src/__tests__/schedule-memory.test.ts`
- Create: `src/__tests__/agent-journeys.test.ts`

**Interfaces:**

- Produces: task frames for all successful reads and validated declarative handoffs after successful writes.
- Consumes: Task 1 handoffs, Task 2 frames, Task 6 structured reply data.

- [ ] **Step 1: Write failing multi-turn journeys**

Drive the real turn runtime through:

```text
下一場服事 -> 音控是誰
保存晨更表 -> 保存 -> 7/21 家族是誰
保存檔案 -> final confirm -> 奔跑不放棄
記住一段文字 -> 保存 -> 對內容提出語意問題
查 Wikipedia -> 那他何時出生
```

Assert focused replies, correct capability, no duplicate full body, and requester isolation.

- [ ] **Step 2: Verify current lifecycle clears or loses state**

Run: `pnpm vitest run src/__tests__/agent-journeys.test.ts src/__tests__/active-task.test.ts`

Expected: FAIL for non-schedule continuation and all write handoffs.

- [ ] **Step 3: Emit operations and handoff metadata**

All successful read handlers emit the intersection of operations they actually support. Successful write handlers emit safe anchors such as schedule type, memory opaque id, or resource kind/item id. No preview/unconfirmed result may emit a handoff-success envelope.

- [ ] **Step 4: Create task frames from declarative handoffs**

Resolve `handoffs` from the source function definition, validate `when` against trusted handler output, map only declared safe anchors, and recheck target effective access before writing the frame. The new frame's `currentCapability` is the target read function.

- [ ] **Step 5: Run journeys and commit**

Run: `pnpm vitest run src/__tests__/agent-journeys.test.ts src/__tests__/attachment-save.test.ts src/__tests__/schedule-memory.test.ts src/__tests__/active-task.test.ts`

Expected: PASS.

Commit: `git add src && git commit -m "feat: connect function results through task handoffs"`

### Task 8: Upgrade Explicit Memory to Hybrid Grounded Retrieval

**Files:**

- Modify: `src/agent/migrations.ts`
- Modify: `src/agent/postgres-store.ts`
- Modify: `src/agent/memory-store.ts`
- Create: `src/agent/memory-retrieval.ts`
- Modify: `src/functions/retrieve-memory.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/agent-migrations.test.ts`
- Test: `src/__tests__/agent-memory.test.ts`
- Test: `src/__tests__/stores.test.ts`

**Interfaces:**

- Produces: `searchVisibleMemoryHybrid()` and idempotent embedding backfill.
- Consumes: existing Ollama embedding client, 1024-dimensional `bge-m3`, visibility rules, and grounded text generator.

- [ ] **Step 1: Write failing migration and semantic-search tests**

Test an embedding column/index, idempotent migration, exclusion of expired/invisible rows, lexical-only fallback when embeddings are unavailable, semantic match without exact substring, and grounded not-found behavior.

- [ ] **Step 2: Run tests and see semantic cases fail**

Run: `pnpm vitest run src/__tests__/agent-migrations.test.ts src/__tests__/agent-memory.test.ts src/__tests__/stores.test.ts`

Expected: FAIL because memory search filters exact substrings in application code.

- [ ] **Step 3: Add pgvector memory schema**

Add nullable `embedding vector(1024)`, lexical GIN index, and vector index consistent with the knowledge store. Migration must preserve current rows and work when `CREATE EXTENSION vector` has already run.

- [ ] **Step 4: Implement bounded hybrid ranking**

Retrieve at most 20 lexical and 20 vector candidates after SQL visibility/expiry filtering. Fuse ranks deterministically and return at most 5 memories. If embedding generation fails, use lexical results only; do not widen visibility or call a different model.

- [ ] **Step 5: Ground the memory answer**

Pass only the retrieved visible memories to the answer generator, require an answer based solely on that context, and return structured `success`, `not_found`, or `unavailable` envelopes with `replyData`.

- [ ] **Step 6: Add idempotent backfill and commit**

Backfill missing embeddings in bounded startup/background batches without blocking readiness. Record only counts/health, not memory text.

Run: `pnpm vitest run src/__tests__/agent-migrations.test.ts src/__tests__/agent-memory.test.ts src/__tests__/stores.test.ts src/__tests__/agent-journeys.test.ts`

Expected: PASS.

Commit: `git add src && git commit -m "feat: add hybrid explicit-memory retrieval"`

### Task 9: Consolidate the Turn State Machine and Remove Legacy Paths

**Files:**

- Create: `src/agent/turn-state-machine.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/server.ts`
- Modify: `src/__tests__/fixtures/router-eval-corpus.ts`
- Modify: `aca.containerapp.yaml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `AGENTS.md`
- Test: `src/__tests__/agent-turn-runtime.test.ts`
- Test: `src/__tests__/entrance.test.ts`
- Test: `src/__tests__/router-evals.test.ts`
- Test: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**

- Produces: deterministic `decideTurnState()` with documented precedence.
- Consumes: pending confirmation, capability resolution, slot collection, attachment flow, task frame, and new planning.

- [ ] **Step 1: Write precedence tests**

Assert this exact order: pending cancel/confirm, capability/entity selection, slot collection, attachment workflow, explicit function switch, task-frame continuation, new plan. Test that bare `保存` confirms the current write and never starts `save_memory`.

- [ ] **Step 2: Run tests and expose implicit ordering**

Run: `pnpm vitest run src/__tests__/agent-turn-runtime.test.ts src/__tests__/entrance.test.ts`

Expected: at least one new precedence test FAILS against handler insertion order.

- [ ] **Step 3: Implement the state decision module**

Use this public result union:

```ts
export type TurnDecision =
  | { type: "reply"; result: FunctionExecutionResult }
  | { type: "collect"; state: PendingCollection }
  | { type: "resolve"; state: PendingCapabilityResolution }
  | { type: "plan"; taskFrame?: AgentTaskFrame }
  | { type: "deny"; reason: string };
```

State handlers return typed claims; do not rely on `Object.entries()` order.

- [ ] **Step 4: Remove replaced paths**

Delete pre-route memory regex handling and generic query clarification once their journeys pass. Remove stale legacy fixture names and `KEYWORD_FALLBACK_ENABLED`. Remove unwired context compression settings unless the same commit wires them exclusively to small-talk context.

- [ ] **Step 5: Align documentation**

Document all enabled functions, effective user/group grants, four-purpose attachment flow, focused replies, task-frame TTL, evidence providers, and write-to-read handoffs. Correct any claim that helper memory functions are disabled.

- [ ] **Step 6: Run targeted tests and commit**

Run: `pnpm vitest run src/__tests__/agent-turn-runtime.test.ts src/__tests__/entrance.test.ts src/__tests__/router-evals.test.ts src/__tests__/profile-config-deployment-contract.test.ts`

Expected: PASS.

Commit: `git add src aca.containerapp.yaml .env.example README.md docs AGENTS.md && git commit -m "refactor: centralize controlled turn state"`

### Task 10: Complete Evals, Verification, PR, Release, and Production Smoke Test

**Files:**

- Modify: module-owned router eval cases under `src/functions/`
- Modify: `src/tools/agent-planner-eval.ts`
- Modify: `.github/workflows/ci.yml` only if a new deterministic script is added
- Modify: design/plan checkboxes after execution

**Interfaces:**

- Produces: offline deterministic regression coverage and deployed verified behavior.
- Consumes: all prior tasks.

- [ ] **Step 1: Add complete contract eval coverage**

For every function add positive, typo, missing-slot, negative, disabled, content-only where applicable, cross-function, ambiguity, continuation, and handoff cases. Add focused field-answer cases for schedules, knowledge, and memory.

- [ ] **Step 2: Run the complete local quality gate**

Run in order:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm config:validate
pnpm eval:agent
pnpm build
```

Expected: every command exits 0; `pnpm test` reports no skipped/new failures; deterministic eval reports all validated expectations passed.

- [ ] **Step 3: Run manual live routing evaluation**

Run: `pnpm eval:agent:live`

Expected: DeepSeek primary and configured Ollama fallback return schema-valid proposals for the live corpus. If credentials/provider are unavailable, record that as a manual-environment limitation; do not weaken CI.

- [ ] **Step 4: Review the diff for authority and privacy regressions**

Run:

```bash
git diff --check
git diff --stat main...HEAD
git grep -nE 'KEYWORD_FALLBACK_ENABLED|query_service_schedule|save_schedule_memory|query_schedule_memory'
```

Expected: diff check is clean; legacy grep returns no runtime/config occurrences; no raw content or secret-bearing trace fields were added.

- [ ] **Step 5: Push branch and create a ready PR**

Use authenticated GitHub CLI without changing the SSH remote. PR body must list architecture changes, data migration, tests/evals, permission behavior, and rollback considerations. Required `PR CI` must pass.

- [ ] **Step 6: Merge after required checks and monitor release**

Squash merge through protected `main`. Monitor the `Build and Release` GitHub Action to completion and confirm the deployed ACA revision uses the new image tag while Dapr remains enabled with app id `hhc-line-function-bot`, port 3000, protocol HTTP.

- [ ] **Step 7: Run production smoke tests**

POST an unsigned JSON body through the public API Gateway helper webhook path.

Expected: `400 {"ok":false,"error":"missing_line_signature"}` from the bot. Then run authorized LINE journeys for next schedule -> one field, saved schedule lookup, resource lookup, memory lookup, ambiguity choice, and group requester isolation.

- [ ] **Step 8: Record the final architecture summary**

Summarize retained controls, removed legacy paths, all function behaviors, task/evidence/result lifecycle, autonomous-maintenance boundary, verification evidence, PR/merge SHA, workflow run URL, ACA revision, and any intentionally deferred control-plane implementation.

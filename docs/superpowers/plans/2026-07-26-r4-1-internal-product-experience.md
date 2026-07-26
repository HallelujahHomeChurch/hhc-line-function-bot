# R4.1 Internal Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make registration, help, capability introduction, result guidance, and administrator summaries reflect only the current requester/source authority, with deterministic Traditional Chinese copy and privacy-safe adoption signals.

**Architecture:** Extract effective access resolution from LINE transport into an application-owned service, then project the resolved function set through one pure presentation model. Keep controlled routing and function handlers authoritative; add narrow copy, persistence, and observability ports around the existing flow instead of creating another router or policy system.

**Tech Stack:** TypeScript, Fastify, LINE Messaging API Quick Replies, Vitest, PostgreSQL, Redis, DeepSeek-only controlled routing, deterministic Kernel v1 evals.

## Global Constraints

- The roadmap and `docs/superpowers/specs/2026-07-26-r4-1-internal-product-experience-design.md` are authoritative.
- Presentation consumes already-resolved authority and never grants a function.
- Ordinary copy must not expose function names, LINE IDs, OneDrive, Notion, DeepSeek, Azure, storage, database, model, raw errors, URLs, or secrets.
- Preferred onboarding order is `query_schedule`, `find_sheet_music`, `find_ppt_slides`, followed by canonical definition order.
- `/help` lists the complete effective read/write set; onboarding and Quick Replies are capped at three.
- A write is advertised only when currently authorized in the current LINE source.
- Every non-success state has at most one bounded next action and no automatic retry loop.
- Identity-only introduction stays `我是小哈，家教會的小幫手。`
- Do not add a capability-projection table, a new router, a second policy system, or a new admin command.
- Group/requester workflow isolation and the DeepSeek-only semantic lane remain unchanged.
- Product telemetry is allowlist-only and never stores raw messages or result content.
- Work test-first and commit after every task.

---

### Task 1: Extract Effective Access Resolution

**Files:**

- Create: `src/application/access/effective-access.ts`
- Create: `src/__tests__/effective-access.test.ts`
- Modify: `src/transport/line/webhook-routes.ts`
- Modify: `src/actions/admin-registry.ts`
- Modify: `src/architecture/dependency-rules.ts`

**Interfaces:**

- Consumes: `BotProfileConfig`, `LineEvent`, `AccessStore`, canonical function-definition grant policy.
- Produces:

```ts
export interface EffectiveAccessContext {
  profile: BotProfileConfig;
  authorized: boolean;
  requesterIsAdmin: boolean;
  sourceType: "user" | "group" | "room";
}

export async function resolveEffectiveAccessContext(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  accessStore: AccessStore;
  requesterIsAdmin?: boolean;
}): Promise<EffectiveAccessContext>;

export function isDefaultUserFunctionAvailable(functionName: FunctionName): boolean;
```

- Authorization rules:
  - `user/public` is authorized;
  - `user/managed` requires an active user principal or admin;
  - `group/managed` requires an active group principal;
  - blocked and unsupported sources are unauthorized;
  - admin status does not bypass a blocked source policy;
  - effective functions merge profile defaults, user grants/roles, and group grants/roles exactly once.

- [ ] **Step 1: Write failing effective-access tests**

Add table-driven tests:

```ts
it.each([
  ["unregistered direct user", directEvent("U1"), false, []],
  ["registered direct user", directEvent("U1"), true, ["query_schedule"]],
  ["registered group requester", groupEvent("C1", "U1"), true, ["query_schedule"]],
  ["blocked group", groupEvent("C1", "U1"), false, []]
])("%s", async (_name, event, authorized, functions) => {
  const context = await resolveEffectiveAccessContext({ profile, event, accessStore });
  expect(context.authorized).toBe(authorized);
  expect(context.profile.enabledFunctions).toEqual(functions);
});
```

Also prove additive group/user/role grants, admin write defaults, source policy, missing requester ID, and stable function order.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/effective-access.test.ts
```

Expected: FAIL because `effective-access.ts` does not exist.

- [ ] **Step 3: Implement the application service**

Move, do not duplicate, the policy currently implemented by
`resolveEffectiveProfile`, `resolveEffectiveFunctions`,
`capabilitiesToFunctionNames`, and `isDefaultUserFunctionAvailable` in
`webhook-routes.ts`.

Return an empty `enabledFunctions` array whenever `authorized` is false:

```ts
return {
  profile: authorized
    ? { ...input.profile, enabledFunctions }
    : { ...input.profile, enabledFunctions: [] },
  authorized,
  requesterIsAdmin,
  sourceType
};
```

- [ ] **Step 4: Replace transport/admin duplicates**

Use `resolveEffectiveAccessContext` in the webhook event loop. Import
`isDefaultUserFunctionAvailable` in the admin registry instead of retaining a
second local definition. Keep access prompting and command authorization at the
transport boundary.

- [ ] **Step 5: Enforce dependency direction**

Allow transport and actions to import `src/application/access/*`; forbid that
application module from importing transport, concrete PostgreSQL, Redis, LINE
SDK, or testing modules.

- [ ] **Step 6: Run focused tests and architecture check**

Run:

```bash
pnpm vitest run src/__tests__/effective-access.test.ts src/__tests__/entrance.test.ts src/__tests__/admin-action-registry.test.ts
pnpm architecture:check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/application/access/effective-access.ts src/__tests__/effective-access.test.ts src/transport/line/webhook-routes.ts src/actions/admin-registry.ts src/architecture/dependency-rules.ts
git commit -m "refactor: centralize effective access resolution"
```

---

### Task 2: Build The Effective Capability Projection

**Files:**

- Create: `src/application/capabilities/effective-capability-projection.ts`
- Create: `src/application/capabilities/capability-presenters.ts`
- Create: `src/__tests__/effective-capability-projection.test.ts`
- Modify: `src/architecture/dependency-rules.ts`

**Interfaces:**

```ts
export interface CapabilityPresentation {
  functionName: FunctionName;
  displayName: string;
  shortDescription: string;
  example: string;
  quickReply: QuickReplyItem;
}

export interface EffectiveCapabilityProjection {
  reads: CapabilityPresentation[];
  writes: CapabilityPresentation[];
  onboarding: CapabilityPresentation[];
}

export function projectEffectiveCapabilities(input: {
  context: EffectiveAccessContext;
  definitions?: readonly FunctionDefinition[];
}): EffectiveCapabilityProjection;

export function renderCapabilityHelp(
  projection: EffectiveCapabilityProjection,
  mode: "help" | "introduction"
): FunctionExecutionResult;

export function renderRegistrationCompletion(
  projection: EffectiveCapabilityProjection
): FunctionExecutionResult;
```

- [ ] **Step 1: Write failing projection tests**

Cover deterministic preferred order, canonical fallback order, complete
read/write grouping, source filtering, unauthorized empty output, admin command
exclusion, no unauthorized write, maximum three onboarding actions, Quick
Reply label/text limits, and ordinary-copy forbidden terms.

Example:

```ts
expect(
  projectEffectiveCapabilities({ context }).onboarding.map((item) => item.functionName)
).toEqual(["query_schedule", "find_sheet_music", "find_ppt_slides"]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/effective-capability-projection.test.ts
```

Expected: FAIL because the projection module does not exist.

- [ ] **Step 3: Implement the pure projector**

Use `getFunctionDefinitions(context.profile.enabledFunctions)` and definition
metadata only. Create message Quick Replies from the first definition example:

```ts
{
  label: definition.displayName.slice(0, 20),
  action: {
    type: "message",
    label: definition.displayName.slice(0, 20),
    text: definition.examples[0]
  }
}
```

Reject definitions not allowed in the current source. Reads are
`sideEffectLevel === "read"`; writes are `sideEffectLevel === "write"`.

- [ ] **Step 4: Implement deterministic renderers**

Help must list every projected item:

```text
我目前可以協助：

可以查詢
- 查服事表：查詢目前可用的聚會服事安排。

可以保存或更新
- 保存資料：依照確認流程保存教會資料。
```

Registration completion uses onboarding only and omits IDs. Introduction uses
the same sections and Quick Replies as help with a conversational first line.

- [ ] **Step 5: Run tests and architecture check**

Run:

```bash
pnpm vitest run src/__tests__/effective-capability-projection.test.ts
pnpm architecture:check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/capabilities src/__tests__/effective-capability-projection.test.ts src/architecture/dependency-rules.ts
git commit -m "feat: project effective capabilities for LINE"
```

---

### Task 3: Unify Registration, Help, And Capability Introduction

**Files:**

- Modify: `src/transport/line/public-access-commands.ts`
- Modify: `src/transport/line/webhook-routes.ts`
- Modify: `src/intro.ts`
- Modify: `src/__tests__/entrance.test.ts`
- Modify: `src/__tests__/intro.test.ts`

**Interfaces:**

- `handlePublicAccessCommand` receives:

```ts
resolveCurrentAccess(): Promise<EffectiveAccessContext>;
```

- Registration calls that dependency only after `addPrincipal` succeeds.
- `createIntroReply` accepts `projection` instead of reading profile functions
  or random sampling.

- [ ] **Step 1: Add failing entrance and intro tests**

Prove:

- direct registration returns text plus preferred Quick Replies;
- group registration returns the same journey without a group ID;
- registration recomputes post-commit authority;
- unregistered `/help` returns registration guidance and no capabilities;
- direct, group, granted-user, and admin help match exact effective sets;
- help and natural-language capability intro list the same functions;
- identity-only intro is unchanged;
- no random dependency remains;
- no write is advertised without effective write authority.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/entrance.test.ts src/__tests__/intro.test.ts
```

Expected: FAIL on old static help, one-line registration, random intro, and ID
leak assertions.

- [ ] **Step 3: Integrate projection into public commands**

Replace `formatPublicHelp()` with
`renderCapabilityHelp(projectEffectiveCapabilities({ context }), "help")`.
When unauthorized, return `registrationPrompt` instead.

After registration:

```ts
const current = await input.resolveCurrentAccess();
return renderRegistrationCompletion(projectEffectiveCapabilities({ context: current }));
```

- [ ] **Step 4: Integrate natural-language introduction**

Remove `random`, `sample`, and direct function-definition selection from
`intro.ts`. Pass the already-built projection from webhook transport for the
capabilities variant. Keep identity triggers local and deterministic.

- [ ] **Step 5: Run entrance, intro, access, and LINE client tests**

Run:

```bash
pnpm vitest run src/__tests__/entrance.test.ts src/__tests__/intro.test.ts src/__tests__/line.test.ts src/__tests__/function-definitions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/transport/line/public-access-commands.ts src/transport/line/webhook-routes.ts src/intro.ts src/__tests__/entrance.test.ts src/__tests__/intro.test.ts
git commit -m "feat: unify capability discovery experiences"
```

---

### Task 4: Standardize Controlled Result Guidance

**Files:**

- Create: `src/application/turn/result-guidance.ts`
- Create: `src/__tests__/result-guidance.test.ts`
- Modify: `src/application/turn/runtime.ts`
- Modify: `src/messages.ts`
- Modify: `src/__tests__/agent-turn-runtime.test.ts`
- Modify: `src/__tests__/clarification.test.ts`
- Modify: `src/__tests__/query-clarification.test.ts`
- Modify: `src/__tests__/functions.test.ts`
- Modify: `src/__tests__/sheet-music.test.ts`
- Modify: `src/__tests__/query-knowledge.test.ts`
- Modify: `src/__tests__/query-schedule.test.ts`

**Interfaces:**

```ts
export type ControlledResultState =
  | "permission_denied"
  | "missing_input"
  | "ambiguous"
  | "not_found"
  | "unavailable"
  | "stale_allowed"
  | "success"
  | "error";

export function applyResultGuidance(input: {
  state: ControlledResultState;
  result: FunctionExecutionResult;
  definition?: FunctionDefinition;
  supportsViewFull?: boolean;
  staleAt?: string;
}): FunctionExecutionResult;
```

- [ ] **Step 1: Write failing copy-contract tests**

Use a table with expected next-action count:

```ts
it.each([
  ["permission_denied", "/help", 1],
  ["missing_input", "請", 1],
  ["not_found", "換一個關鍵字", 1],
  ["unavailable", "稍後再試", 1],
  ["stale_allowed", "資料時間", 0]
])("%s", (state, phrase, maxActions) => {
  const guided = applyResultGuidance({ state, result: baseResult(state) });
  expect(guided.replyText).toContain(phrase);
  expect(guided.quickReplies?.length ?? 0).toBeLessThanOrEqual(maxActions);
});
```

Also scan output for forbidden implementation terms and prove `success`
preserves focused reply data.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/result-guidance.test.ts
```

Expected: FAIL because `result-guidance.ts` does not exist.

- [ ] **Step 3: Implement the pure guidance policy**

Use definition-owned prompts for missing slots and existing grounded choices for
ambiguity. Add only one generic message Quick Reply where allowed:

```ts
const helpQuickReply: QuickReplyItem = {
  label: "查看可用功能",
  action: { type: "message", label: "查看可用功能", text: "/help" }
};
```

Do not modify `agentResult`, `responseData`, anchors, references, or task-frame
state.

- [ ] **Step 4: Integrate at existing state boundaries**

Map validator deny, slot collection, result-envelope status, stale retrieval
diagnostics, and execution error to the copy policy after authority decisions
are complete. Do not add capability-name conditionals to the router,
validator, or top-level state ordering.

- [ ] **Step 5: Run result, runtime, clarification, and capability tests**

Run:

```bash
pnpm vitest run src/__tests__/result-guidance.test.ts src/__tests__/agent-turn-runtime.test.ts src/__tests__/clarification.test.ts src/__tests__/query-clarification.test.ts src/__tests__/functions.test.ts src/__tests__/sheet-music.test.ts src/__tests__/query-knowledge.test.ts src/__tests__/query-schedule.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/turn/result-guidance.ts src/application/turn/runtime.ts src/messages.ts src/__tests__
git commit -m "feat: standardize controlled result guidance"
```

---

### Task 5: Add Privacy-Safe Group Success Summaries

**Files:**

- Modify: `src/access/types.ts`
- Modify: `src/access/migrations.ts`
- Modify: `src/access/memory-access-store.ts`
- Modify: `src/access/postgres-access-store.ts`
- Modify: `src/application/turn/runtime.ts`
- Modify: `src/transport/line/webhook-routes.ts`
- Modify: `src/__tests__/access-store.test.ts`
- Modify: `src/__tests__/access-migrations.test.ts`
- Modify: `src/__tests__/entrance.test.ts`

**Interfaces:**

```ts
export interface AccessPrincipal {
  // existing fields
  lastSuccessFunctionName?: FunctionName;
  lastSuccessAt?: string;
}

export interface RecordPrincipalSuccessInput {
  profileName: string;
  type: "user" | "group";
  principalId: string;
  functionName: FunctionName;
  occurredAt: string;
}

listPrincipals(
  profileName: string,
  options?: { includeDisabled?: boolean }
): Promise<AccessPrincipal[]>;

recordPrincipalSuccess(input: RecordPrincipalSuccessInput): Promise<void>;
```

- [ ] **Step 1: Write failing store and migration tests**

Prove in-memory/PostgreSQL mapping, include-disabled listing, monotonic
last-success update, and migration columns:

```sql
last_success_function_name text,
last_success_at timestamptz
```

Older completions must not overwrite a newer timestamp.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/access-store.test.ts src/__tests__/access-migrations.test.ts
```

Expected: FAIL because the fields and methods do not exist.

- [ ] **Step 3: Implement persistence**

PostgreSQL update:

```sql
update access_principals
set last_success_function_name = $4, last_success_at = $5
where profile_name = $1
  and principal_type = $2
  and principal_id = $3
  and disabled_at is null
  and (last_success_at is null or last_success_at <= $5)
```

- [ ] **Step 4: Record successful group results**

After a controlled function completes with result class `success`, best-effort
update the current registered group principal using function name and `now()`.
Do not record requester ID, query, content, file name, URL, or result text. Do
not fail the reply if summary persistence fails.

- [ ] **Step 5: Enhance `/access-list`**

Use `includeDisabled: true`. For group rows, show display name, `active` or
`disabled`, effective function names, last successful display name, and
last-success time. Keep raw group ID available only on this admin-gated surface.

- [ ] **Step 6: Run store, entrance, observability, and integration tests**

Run:

```bash
pnpm vitest run src/__tests__/access-store.test.ts src/__tests__/access-migrations.test.ts src/__tests__/entrance.test.ts src/__tests__/observability.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/access src/application/turn/runtime.ts src/transport/line/webhook-routes.ts src/__tests__/access-store.test.ts src/__tests__/access-migrations.test.ts src/__tests__/entrance.test.ts
git commit -m "feat: summarize privacy-safe group activity"
```

---

### Task 6: Add Source Ownership And Freshness Responsibility

**Files:**

- Modify: `src/catalog/store.ts`
- Modify: `src/catalog/migrations.ts`
- Modify: `src/catalog/postgres-store.ts`
- Modify: `src/catalog/source-seeds.ts`
- Modify: `src/actions/catalog.ts`
- Modify: `src/actions/admin-registry.ts`
- Modify: `src/knowledge/store.ts`
- Modify: `src/__tests__/catalog.test.ts`
- Modify: `src/__tests__/catalog-migrations.test.ts`
- Modify: `src/__tests__/catalog-source-seeds.test.ts`
- Modify: `src/__tests__/knowledge-admin-actions.test.ts`
- Modify: `src/__tests__/entrance.test.ts`

**Interfaces:**

```ts
export interface SourceResponsibility {
  ownerLabel?: string;
  freshnessResponsibility?: string;
}

export interface CatalogSourceInput extends SourceResponsibility {}
export interface CatalogSourceRecord extends CatalogSourceInput {}
```

Existing source creation/upsert preserves DB-owned non-null values. Seeds set
defaults only on first creation. Knowledge source listing derives owner from
existing creator metadata and emits `尚未指定` when no safe label exists.

- [ ] **Step 1: Write failing catalog and admin-view tests**

Prove migration fields, round-trip mapping, seed non-overwrite, admin-only
output, and absence from ordinary help/results.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/catalog.test.ts src/__tests__/catalog-migrations.test.ts src/__tests__/catalog-source-seeds.test.ts src/__tests__/knowledge-admin-actions.test.ts src/__tests__/entrance.test.ts
```

Expected: FAIL on missing responsibility metadata.

- [ ] **Step 3: Add existing-table metadata**

Add nullable `owner_label` and `freshness_responsibility` columns to
`catalog_sources`; map them through in-memory and PostgreSQL stores. Preserve
existing values on idempotent seed/upsert unless an explicit administrator
input changes them.

- [ ] **Step 4: Render administrator responsibility**

Extend existing source-list replies with:

```text
owner: <label or 尚未指定>
freshness: <responsibility or 尚未指定>
```

Do not add a new command and do not expose storage roots or content.

- [ ] **Step 5: Run focused tests**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog src/knowledge src/actions/catalog.ts src/actions/admin-registry.ts src/__tests__/catalog.test.ts src/__tests__/catalog-migrations.test.ts src/__tests__/catalog-source-seeds.test.ts src/__tests__/knowledge-admin-actions.test.ts src/__tests__/entrance.test.ts
git commit -m "feat: expose source responsibility to admins"
```

---

### Task 7: Measure First Success Without Raw Analytics

**Files:**

- Create: `src/observability/first-success-store.ts`
- Create: `src/__tests__/first-success-store.test.ts`
- Modify: `src/observability/product-events.ts`
- Modify: `src/observability/action-telemetry.ts`
- Modify: `src/bootstrap/create-production-runtime.ts`
- Modify: `src/application/turn/runtime.ts`
- Modify: `src/testing/create-test-runtime.ts`
- Modify: `src/__tests__/product-events.test.ts`
- Modify: `src/__tests__/runtime-composition.test.ts`

**Interfaces:**

```ts
export interface FirstSuccessScope {
  profileName: string;
  sourceType: "user" | "group";
  sourceId: string;
  requesterUserId: string;
}

export interface FirstSuccessStore {
  tryMark(scope: FirstSuccessScope, ttlMs: number): Promise<"first" | "existing">;
}
```

Provide in-memory and Redis implementations. The Redis implementation uses
atomic `SET key value NX PX` with a hashed/bounded key segment. Production TTL
is 365 days.

- [ ] **Step 1: Write failing atomic-store and event tests**

Prove first/existing behavior, requester/source isolation, expiry, Redis command
shape, allowlisted `first_success` event, and no raw IDs/text in sanitized
events.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/first-success-store.test.ts src/__tests__/product-events.test.ts src/__tests__/runtime-composition.test.ts
```

Expected: FAIL because the store and event do not exist.

- [ ] **Step 3: Implement stores and composition**

Use Redis when configured and the in-memory implementation otherwise. Do not
make first-success state part of readiness and do not persist prompts or
results.

- [ ] **Step 4: Emit first success**

After `function_completed` with result class `success`, call `tryMark`. Emit:

```ts
{
  eventName: "first_success",
  action: route.action,
  resultClass: "success"
}
```

only for `"first"`. Failure is best-effort and cannot change the reply.

- [ ] **Step 5: Run focused tests**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/observability src/bootstrap/create-production-runtime.ts src/application/turn/runtime.ts src/testing src/__tests__
git commit -m "feat: record privacy-safe first success"
```

---

### Task 8: Add R4.1 Kernel Journeys And Documentation

**Files:**

- Create: `src/evals/kernel/cases/product-experience.ts`
- Modify: `src/evals/kernel/corpus.ts`
- Modify: `src/evals/kernel/runtime-harness.ts`
- Modify: `src/__tests__/kernel-corpus.test.ts`
- Modify: `src/__tests__/kernel-eval.test.ts`
- Modify: `src/__tests__/kernel-postgres-integration.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `docs/superpowers/specs/2026-07-26-single-church-optimization-roadmap-design.md`
- Modify: `AGENTS.md` only for a genuinely new durable implementation rule

**Interfaces:**

- New versioned boundary IDs:
  - `effective-discovery-direct@1`
  - `effective-discovery-group@1`
  - `effective-discovery-granted-user@1`
  - `effective-discovery-admin@1`
  - `registration-first-read@1`
  - `result-guidance-classes@1`
  - `branch-group-isolation@1`

- [ ] **Step 1: Add failing Kernel/corpus completeness tests**

Require all seven IDs and assert the corpus covers registration, exact
effective discovery, unavailable-write exclusion, every controlled result
class, and two-group requester isolation.

- [ ] **Step 2: Run Kernel tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts src/__tests__/kernel-eval.test.ts src/__tests__/kernel-postgres-integration.test.ts
```

Expected: FAIL because the R4.1 boundaries are missing.

- [ ] **Step 3: Implement deterministic Kernel cases**

Use stub planner/provider behavior and in-memory or disposable real stores. The
two synthetic groups share schedule/catalog/knowledge fixtures but use distinct
source/requester scopes for selections, jobs, attachment sessions, and memory.
Do not call DeepSeek or Azure embedding.

- [ ] **Step 4: Update documentation**

Document the effective-capability projection, deterministic Quick Replies,
result guidance, admin summaries, source responsibility, first-success event,
and R4.1 completion criteria. Mark R4.1 complete only after final gates and
production verification pass.

- [ ] **Step 5: Run focused Kernel and docs tests**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts src/__tests__/kernel-eval.test.ts src/__tests__/kernel-postgres-integration.test.ts src/__tests__/modular-monolith-docs.test.ts src/__tests__/kernel-docs.test.ts
pnpm eval:kernel
pnpm eval:kernel:integration
```

Expected: PASS with no skipped Redis/PostgreSQL dependency.

- [ ] **Step 6: Commit**

```bash
git add src/evals src/testing src/__tests__ README.md docs AGENTS.md
git commit -m "test: accept R4.1 internal product experience"
```

---

### Task 9: Complete R4.1 Validation, Review, And Delivery

**Files:**

- Modify only files required by verified failures or review findings.

**Interfaces:**

- Required local gates:
  - format;
  - typecheck;
  - lint;
  - architecture;
  - full test;
  - build;
  - deterministic agent eval;
  - Kernel;
  - Kernel integration;
  - admin eval when admin output changes.

- [ ] **Step 1: Run all mandatory local gates**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm test
pnpm build
pnpm eval:agent
pnpm eval:admin
pnpm eval:kernel
pnpm eval:kernel:integration
git diff --check origin/main...HEAD
```

Expected: every command exits `0`; integration owns and removes disposable
Redis/PostgreSQL dependencies.

- [ ] **Step 2: Review the complete branch**

Request a spec-compliance review and a code-quality review. Fix only evidenced
findings and rerun the affected focused tests plus the full required gate.

- [ ] **Step 3: Commit verified review fixes**

```bash
git add src README.md docs AGENTS.md
git commit -m "fix: close R4.1 review findings"
```

- [ ] **Step 4: Push and create a ready PR**

Push `codex/r4-1-internal-product-experience-spec`, open a ready PR against
`main`, summarize the R4.1 product effect and exact gates, and enable squash
auto-merge because the user explicitly authorized deployment through R5.0.

- [ ] **Step 5: Wait for PR CI and Production Release**

Do not stop at PR creation. Wait for required `PR CI`, confirm squash merge,
then wait for the post-merge Production Release to complete.

- [ ] **Step 6: Verify production without provider calls**

Verify:

- one healthy bot revision with 100% traffic;
- internal ingress and exact Dapr app ID/port/protocol;
- correctly signed `events: []` canonical Gateway webhook returns success;
- unsigned webhook still fails signature validation;
- registration/help projection through the local deterministic signed harness;
- no DeepSeek or Azure embedding request is made by deployment verification;
- no raw telemetry or secret appears in release output.

- [ ] **Step 7: Synchronize local main and clean the completed worktree**

Fast-forward local `main`, remove the clean R4.1 worktree and local branch, and
confirm local/remote `main` alignment before starting R5.0.

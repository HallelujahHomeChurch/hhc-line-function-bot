# R3.5 Modular Monolith Maintainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single TypeScript/Fastify service mechanically enforceable and easier to change by separating composition, transport, turn orchestration, and one complete capability slice without changing product behavior or deployment topology.

**Architecture:** Keep one deployed modular monolith and use explicit TypeScript factories. `bootstrap` is the only concrete composition root, `transport` adapts Fastify/LINE requests, `application` coordinates use cases and turn stages, and `capabilities` own product behavior through narrow ports. Existing public exports remain as compatibility facades while callers migrate.

**Tech Stack:** TypeScript 5.9, Fastify 5, Vitest 4, ESLint 9, pnpm 11, GitHub Actions.

## Global Constraints

- Preserve all user-facing behavior, canonical LINE paths, access policy, controlled-routing authority, result-envelope privacy, database semantics, and deployment topology.
- Use explicit factory-based dependency injection; do not add a runtime DI container, decorators, reflection metadata, or service locator.
- Production construction must never silently select an in-memory fallback.
- Keep the controlled turn precedence unchanged: pending confirmation/cancellation, resolver selection, required-slot collection, attachment workflow, explicit function switch, active-task continuation, then a new plan.
- Do not add capability-specific branches to the generic controlled router, planner, validator, or top-level active-task flow.
- Keep DeepSeek as the sole semantic provider and Azure OpenAI as the embedding provider.
- Keep `main` protected: work on `codex/r3-5-modular-monolith`, open a pull request, wait for `PR CI`, and do not merge or deploy without explicit deployment approval.

---

### Task 1: Mechanically enforce dependency direction

**Files:**
- Create: `src/architecture/dependency-rules.ts`
- Create: `src/tools/check-dependency-boundaries.ts`
- Create: `src/__tests__/dependency-rules.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `checkDependencyBoundaries(files: SourceFile[]): BoundaryViolation[]`
- Produces: `architecture:check` package script used locally and by PR CI.

- [ ] **Step 1: Write the failing boundary tests**

Add tests that feed virtual source files to `checkDependencyBoundaries` and assert:

```ts
expect(
  checkDependencyBoundaries([
    { path: "src/capabilities/example/handler.ts", source: 'import "../../infrastructure/db.js";' }
  ])
).toEqual([
  expect.objectContaining({
    importer: "src/capabilities/example/handler.ts",
    imported: "src/infrastructure/db.ts"
  })
]);
```

Cover these rules:

- `capabilities` cannot import `bootstrap`, `transport`, or `infrastructure`.
- `application` cannot import `bootstrap`, `transport`, or `infrastructure`.
- `transport` cannot import `bootstrap` or `infrastructure`.
- `infrastructure` cannot import `bootstrap` or `transport`.
- compatibility facades may only re-export their new owner module.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
pnpm vitest run src/__tests__/dependency-rules.test.ts
```

Expected: failure because `src/architecture/dependency-rules.ts` does not exist.

- [ ] **Step 3: Implement the dependency checker**

Use Node built-ins only. Normalize `.js` imports to TypeScript source paths, parse static `import`, `export ... from`, and dynamic `import()` specifiers, resolve relative paths, and return deterministic violations:

```ts
export interface SourceFile {
  path: string;
  source: string;
}

export interface BoundaryViolation {
  importer: string;
  imported: string;
  rule: string;
}

export function checkDependencyBoundaries(files: SourceFile[]): BoundaryViolation[];
```

The CLI reads tracked `src/**/*.ts` files, prints one line per violation, and exits non-zero when violations exist.

- [ ] **Step 4: Wire the check into scripts and CI**

Add:

```json
"architecture:check": "tsx src/tools/check-dependency-boundaries.ts"
```

Add a `Check architecture boundaries` step after lint and before tests in `.github/workflows/ci.yml`.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/dependency-rules.test.ts
pnpm architecture:check
```

Commit:

```bash
git add src/architecture src/tools/check-dependency-boundaries.ts src/__tests__/dependency-rules.test.ts package.json .github/workflows/ci.yml
git commit -m "test: enforce modular dependency boundaries"
```

### Task 2: Make production and test composition explicit

**Files:**
- Create: `src/bootstrap/create-production-runtime.ts`
- Create: `src/bootstrap/runtime-contracts.ts`
- Create: `src/testing/create-test-runtime.ts`
- Create: `src/__tests__/runtime-composition.test.ts`
- Modify: `src/index.ts`
- Modify: `src/functions/registry.ts`

**Interfaces:**
- Produces: `createProductionRuntime(config: AppConfig): Promise<ProductionRuntime>`
- Produces: `createTestRuntime(overrides?: TestRuntimeOverrides): TestRuntime`
- Produces: `ProductionRuntime` with `app`, `close()`, and scheduled maintenance handles.

- [ ] **Step 1: Write failing composition tests**

Test that production composition rejects a missing required production adapter instead of manufacturing an in-memory store, and that `createTestRuntime()` visibly supplies in-memory implementations:

```ts
expect(testRuntime.kind).toBe("test");
expect(testRuntime.stores.session.constructor.name).toBe("InMemorySessionStore");
await expect(createProductionRuntime(invalidProductionConfig)).rejects.toThrow();
```

- [ ] **Step 2: Verify the new imports fail**

Run:

```powershell
pnpm vitest run src/__tests__/runtime-composition.test.ts
```

Expected: module-not-found failures for the new composition modules.

- [ ] **Step 3: Extract the composition root**

Move concrete Redis, PostgreSQL, Graph, Notion, LINE, DeepSeek, Azure embedding, queue, store, registry, diagnostics, and timer construction from `src/index.ts` into `createProductionRuntime`. Keep `src/index.ts` limited to:

```ts
const config = loadConfigFromEnv(process.env);
const runtime = await createProductionRuntime(config);
await runtime.app.listen({ host: config.host, port: config.port });
```

Return one `close()` method that clears timers and closes app, Redis, and PostgreSQL resources in the same order as the current shutdown path.

- [ ] **Step 4: Separate registry assembly from fallback creation**

Require the registry caller to pass constructed stores. Retain in-memory defaults only in `src/testing/create-test-runtime.ts`; production composition passes every store explicitly.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/runtime-composition.test.ts src/__tests__/registry.test.ts
pnpm typecheck
```

Commit:

```bash
git add src/bootstrap src/testing src/index.ts src/functions/registry.ts src/__tests__/runtime-composition.test.ts
git commit -m "refactor: make runtime composition explicit"
```

### Task 3: Split Fastify and LINE transport adapters

**Files:**
- Create: `src/transport/http/health-routes.ts`
- Create: `src/transport/line/webhook-routes.ts`
- Create: `src/transport/line/public-access-commands.ts`
- Create: `src/transport/line/admin-commands.ts`
- Create: `src/transport/line/postbacks.ts`
- Create: `src/transport/line/contracts.ts`
- Modify: `src/server.ts`
- Modify: `src/__tests__/diagnostics.test.ts`
- Modify: `src/__tests__/entrance.test.ts`
- Modify: `src/__tests__/webhook-smoke.test.ts`

**Interfaces:**
- Produces: `registerHealthRoutes(app, config, dependencies): void`
- Produces: `registerWebhookRoutes(app, config, dependencies): void`
- Produces: `handlePublicAccessCommand(command): Promise<FunctionExecutionResult | undefined>`
- Produces: `handleAdminCommand(command): Promise<FunctionExecutionResult | undefined>`
- Produces: `handlePostbackEvent(command): Promise<FunctionExecutionResult | undefined>`
- Keeps: `createApp(config, dependencies): FastifyInstance` as the compatibility facade.

- [ ] **Step 1: Add route ownership tests**

Extend diagnostics and entrance tests to assert the same `/healthz`, `/readyz`, canonical profile webhook, signature validation, access, admin, postback, and ignored-event results through `createApp`.

- [ ] **Step 2: Capture the pre-refactor behavior**

Run:

```powershell
pnpm vitest run src/__tests__/diagnostics.test.ts src/__tests__/entrance.test.ts src/__tests__/webhook-smoke.test.ts
```

Expected: all existing and added characterization tests pass before moving code.

- [ ] **Step 3: Extract bounded transport contracts**

Move LINE payload, event, source, reply, identity, postback, and text-message transport contracts to `src/transport/line/contracts.ts`. Re-export them from `src/types.ts` so existing imports remain source-compatible.

- [ ] **Step 4: Extract focused adapters**

Move route registration and the related private helpers as cohesive units. Each adapter receives only the dependencies it uses. `src/server.ts` retains `AppDependencies` compatibility and `createApp`, but contains no access-policy, admin-command, postback, health, or webhook business implementation.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/diagnostics.test.ts src/__tests__/entrance.test.ts src/__tests__/webhook-smoke.test.ts
pnpm typecheck
pnpm architecture:check
```

Commit:

```bash
git add src/server.ts src/transport src/types.ts src/__tests__/diagnostics.test.ts src/__tests__/entrance.test.ts src/__tests__/webhook-smoke.test.ts
git commit -m "refactor: split Fastify LINE transport adapters"
```

### Task 4: Split the controlled turn runtime into ordered stages

**Files:**
- Create: `src/application/turn/contracts.ts`
- Create: `src/application/turn/coordinator.ts`
- Create: `src/application/turn/stages/text-continuation-stage.ts`
- Create: `src/application/turn/stages/capability-resolution-stage.ts`
- Create: `src/application/turn/stages/admin-action-stage.ts`
- Create: `src/application/turn/stages/controlled-plan-stage.ts`
- Create: `src/application/turn/stages/function-execution-stage.ts`
- Create: `src/application/turn/telemetry.ts`
- Modify: `src/agent/turn-runtime.ts`
- Modify: `src/__tests__/agent-turn-runtime.test.ts`
- Modify: `src/__tests__/turn-state-machine.test.ts`

**Interfaces:**
- Produces: `TurnStage` with an explicit `name`, `order`, and `run(context)` contract.
- Produces: `createTurnCoordinator(stages, telemetry): AgentTurnRuntime`
- Keeps: `createAgentTurnRuntime(options): AgentTurnRuntime` as a compatibility factory.

- [ ] **Step 1: Write stage-order and short-circuit tests**

Add tests proving:

```ts
expect(orderTurnStages(stages).map((stage) => stage.name)).toEqual([
  "text_continuation",
  "capability_resolution",
  "admin_action",
  "controlled_plan",
  "function_execution"
]);
```

Also prove that a handled earlier stage prevents later stages from running and that group requester isolation remains unchanged.

- [ ] **Step 2: Verify the contract test fails**

Run:

```powershell
pnpm vitest run src/__tests__/turn-state-machine.test.ts src/__tests__/agent-turn-runtime.test.ts
```

Expected: failure because `TurnStage` and `createTurnCoordinator` are absent.

- [ ] **Step 3: Extract stage contracts and coordinator**

Define:

```ts
export type TurnStageResult =
  | { kind: "continue"; context: TurnExecutionContext }
  | { kind: "handled"; result: FunctionExecutionResult | undefined };

export interface TurnStage {
  name: string;
  order: number;
  run(context: TurnExecutionContext): Promise<TurnStageResult>;
}
```

The coordinator owns trace finalization only. Stages own their current workflow step and mutate no global registry.

- [ ] **Step 4: Move orchestration in precedence-preserving slices**

Extract text continuations, resolver selection, natural-language admin routing, controlled planning/clarification, and function execution. Keep active-task reads/transitions, in-flight locks, sanitized telemetry, write audit, and error handling in the stage that currently owns the event.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/turn-state-machine.test.ts src/__tests__/agent-turn-runtime.test.ts src/__tests__/active-task.test.ts src/__tests__/pending-resolution.test.ts src/__tests__/pending-function.test.ts
pnpm eval:kernel
pnpm architecture:check
```

Commit:

```bash
git add src/application src/agent/turn-runtime.ts src/__tests__/turn-state-machine.test.ts src/__tests__/agent-turn-runtime.test.ts
git commit -m "refactor: make controlled turn stages explicit"
```

### Task 5: Migrate `query_schedule` as the reference capability slice

**Files:**
- Create: `src/capabilities/query-schedule/definition.ts`
- Create: `src/capabilities/query-schedule/eval-cases.ts`
- Create: `src/capabilities/query-schedule/ports.ts`
- Create: `src/capabilities/query-schedule/handler.ts`
- Create: `src/capabilities/query-schedule/module.ts`
- Create: `src/capabilities/query-schedule/index.ts`
- Modify: `src/functions/query-schedule.ts`
- Modify: `src/functions/definitions.ts`
- Modify: `src/functions/modules.ts`
- Modify: `src/functions/registry.ts`
- Modify: `src/__tests__/query-schedule.test.ts`
- Modify: `src/__tests__/function-modules.test.ts`
- Modify: `src/__tests__/registry.test.ts`

**Interfaces:**
- Produces: `QueryScheduleDependencies` containing only memory, schedule, optional Notion/session/time/request-id ports.
- Produces: `createQueryScheduleModule(dependencies): FunctionModule`
- Keeps: old `src/functions/query-schedule.ts` exports as compatibility re-exports.

- [ ] **Step 1: Write failing slice ownership tests**

Assert that:

- `queryScheduleDefinition.name === "query_schedule"`.
- `queryScheduleRouterEvalCases` contains all required eval kinds.
- `createQueryScheduleModule` constructs a working handler from explicit fakes.
- the module cannot be constructed without its required memory port.
- the compatibility import and new slice import produce equivalent behavior.

- [ ] **Step 2: Verify the new module imports fail**

Run:

```powershell
pnpm vitest run src/__tests__/query-schedule.test.ts src/__tests__/function-modules.test.ts src/__tests__/registry.test.ts
```

Expected: module-not-found failure for `src/capabilities/query-schedule`.

- [ ] **Step 3: Move the capability-owned code**

Move the complete definition object, eval cases, handler/options, and narrow port aliases into the slice. Shared schedule domain registry, occurrence policy, result envelope, and pending-resolution contracts stay in their current shared owners.

- [ ] **Step 4: Integrate through explicit construction**

`src/functions/definitions.ts` aggregates `queryScheduleDefinition`; `src/functions/modules.ts` aggregates the constructed module. Registry composition passes exactly `QueryScheduleDependencies`, not the large `FunctionModuleContext`, to this capability.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/query-schedule.test.ts src/__tests__/function-modules.test.ts src/__tests__/registry.test.ts src/__tests__/router-evals.test.ts
pnpm eval:agent
pnpm eval:kernel
pnpm architecture:check
```

Commit:

```bash
git add src/capabilities/query-schedule src/functions/query-schedule.ts src/functions/definitions.ts src/functions/modules.ts src/functions/registry.ts src/__tests__/query-schedule.test.ts src/__tests__/function-modules.test.ts src/__tests__/registry.test.ts
git commit -m "refactor: migrate query schedule capability slice"
```

### Task 6: Close type ownership and documentation drift

**Files:**
- Create: `src/application/contracts/function-execution.ts`
- Create: `src/application/contracts/routing.ts`
- Modify: `src/types.ts`
- Modify: `docs/architecture-context.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `src/__tests__/modular-monolith-docs.test.ts`

**Interfaces:**
- Produces bounded application contracts re-exported from `src/types.ts`.
- Documents the approved dependency direction and migration path.

- [ ] **Step 1: Write documentation and compatibility tests**

Assert that architecture documentation names `bootstrap`, `transport`, `application`, `capabilities`, and `infrastructure`, and that `AGENTS.md` states the deployed weekly ClamAV refresh schedule `10 19 * * 0`.

- [ ] **Step 2: Verify the documentation test fails**

Run:

```powershell
pnpm vitest run src/__tests__/modular-monolith-docs.test.ts
```

Expected: failure on missing module map and the stale `*/2` schedule.

- [ ] **Step 3: Move bounded contracts**

Move function execution/context/result contracts to `application/contracts/function-execution.ts` and route/planner observer contracts to `application/contracts/routing.ts`. Re-export from `src/types.ts` to avoid a broad caller rewrite. New R3.5 code imports directly from its owning contract module.

- [ ] **Step 4: Update architecture guidance**

Document:

- allowed dependency direction;
- explicit production/test composition;
- route adapter owners;
- turn stage owners and precedence;
- `query_schedule` as the reference vertical slice;
- the rule that new types belong with their invariants.

Correct the ClamAV schedule statement to weekly UTC `10 19 * * 0`, matching the deployed manifest.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm vitest run src/__tests__/modular-monolith-docs.test.ts
pnpm typecheck
pnpm architecture:check
```

Commit:

```bash
git add src/application/contracts src/types.ts docs/architecture-context.md README.md AGENTS.md src/__tests__/modular-monolith-docs.test.ts
git commit -m "docs: define modular monolith ownership"
```

### Task 7: Run the R3.5 acceptance boundary and publish the PR

**Files:**
- Modify only files required by failures attributable to R3.5.

**Interfaces:**
- Produces a reviewable `codex/r3-5-modular-monolith` pull request with all required checks green.

- [ ] **Step 1: Run local quality gates**

Run:

```powershell
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

Expected: every command exits zero. The integration gate must start and remove its own disposable Redis/PostgreSQL dependencies.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Confirm that no secret, `.env`, credential, user ID, raw LINE message, private URL, or deployment topology change is present.

- [ ] **Step 3: Push and open the pull request**

Push `codex/r3-5-modular-monolith`, open a PR titled `Complete R3.5 modular monolith maintainability`, and summarize the dependency check, explicit composition, transport adapters, turn stages, query-schedule slice, and verification evidence.

- [ ] **Step 4: Wait for PR CI**

Wait for required `PR CI`. Diagnose failures from job output, make only R3.5-scoped fixes, rerun the affected local gate, push, and wait again.

- [ ] **Step 5: Stop before merge/deployment**

Report the green PR and the exact production status. Do not enable auto-merge, merge, or trigger `.github/workflows/release.yml` until the user explicitly authorizes deployment.

## Self-Review

- Spec coverage: dependency direction, explicit DI, module ownership, transport split, turn stages, type ownership, CI enforcement, Kernel verification, and the `query_schedule` reference slice each map to a task.
- Scope coverage: no microservice, route, policy, routing-authority, privacy, database, or deployment-topology change is included.
- Placeholder scan: the plan contains no `TBD`, deferred implementation, or unnamed test step.
- Type consistency: production/test runtime, turn stage, dependency checker, and query-schedule factory names are consistent across producer and consumer tasks.

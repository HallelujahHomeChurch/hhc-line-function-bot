# Kernel v1 Acceptance Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Kernel v1 stabilization delivery: a deterministic, privacy-safe acceptance corpus, scorer, report, and required PR CI gate that measures R0 through R3 as one controlled product.

**Architecture:** Add an evaluation-only `src/evals/kernel` package around the real controlled turn runtime and existing in-memory stores. Scenario modules produce allowlisted observations; a pure scorer computes the seven approved metrics; a CLI writes redacted JSON and Markdown artifacts and exits non-zero when a gate fails. Runtime behavior remains unchanged in this delivery, and any failures discovered by the gate become separately planned architecture-fix PRs.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Fastify service contracts, existing in-memory agent/catalog/schedule stores, pnpm 11, GitHub Actions.

## Global Constraints

- Do not add phrase-specific branches to the generic router, planner, validator, or top-level turn flow.
- Do not replace the controlled router with a test-only authority path.
- Corpus content must be synthetic and must not include production LINE IDs, group IDs, source titles, file names, people, URLs, tokens, prompts, or provider payloads.
- Reports may expose stable case IDs and allowlisted classifications only; they must not serialize case turn text or fixture content.
- `pnpm eval:kernel` must be deterministic, offline, and required by PR CI.
- DeepSeek/Ollama live evaluation remains manual and outside PR CI.
- The seven gate thresholds are schedule accuracy `>= 98%`, core success `>= 85%`, unavailable misclassification `< 1%`, ambiguity resolution `>= 80%`, security violations `0`, timely-or-job core reads `>= 90%`, and recurrence coverage `100%`.
- Use first-person `我` for any new user-facing bot copy, although this delivery should not change bot copy.
- Use test-first implementation and keep generated reports under ignored `artifacts/kernel-v1/`.

---

## File Structure

- Create `src/evals/kernel/contracts.ts` for allowlisted case, observation, metric, and report types.
- Create `src/evals/kernel/scorer.ts` for pure metric calculation and gate evaluation.
- Create `src/evals/kernel/report.ts` for redacted JSON/Markdown report rendering and artifact writes.
- Create `src/evals/kernel/runtime-harness.ts` for a reusable synthetic `createAgentTurnRuntime` fixture.
- Create `src/evals/kernel/cases/schedule.ts` for canonical schedule, domain, role-follow-up, and ambiguity cases.
- Create `src/evals/kernel/cases/retrieval.ts` for catalog, PPT, sheet-music, knowledge, freshness, and unavailable cases.
- Create `src/evals/kernel/cases/security-and-state.ts` for permission, requester isolation, confirmation, scanning, and stale-state cases.
- Create `src/evals/kernel/corpus.ts` to combine and validate the versioned corpus.
- Create `src/evals/kernel/evaluate.ts` to execute cases and return a `KernelGateReport`.
- Create `src/tools/eval-kernel.ts` as the CLI entry point.
- Create `src/__tests__/kernel-scorer.test.ts`, `kernel-report.test.ts`, `kernel-corpus.test.ts`, and `kernel-eval.test.ts`.
- Modify `package.json`, `.gitignore`, `.github/workflows/ci.yml`, `README.md`, `AGENTS.md`, and `docs/operations/controlled-agent-support.md` to expose and operate the gate.

---

### Task 1: Define Stable Acceptance Contracts and Pure Gate Scoring

**Files:**

- Create: `src/evals/kernel/contracts.ts`
- Create: `src/evals/kernel/scorer.ts`
- Create: `src/__tests__/kernel-scorer.test.ts`

**Interfaces:**

- Consumes: no runtime dependencies; only synthetic observations.
- Produces: `KernelAcceptanceCase`, `KernelCaseObservation`, `KernelGateReport`, `scoreKernelGate(observations, requiredFamilies)`.

- [ ] **Step 1: Write scorer tests that define all seven metric denominators and threshold directions**

Create `src/__tests__/kernel-scorer.test.ts` with cases that prove exact-threshold passing, below-threshold failure, a single security violation failure, unavailable misclassification using strict `< 1%`, empty denominators marked incomplete, and recurrence coverage based on the declared required-family set.

```ts
import { describe, expect, it } from "vitest";

import type { KernelCaseObservation, RecurrenceFamily } from "../evals/kernel/contracts.js";
import { scoreKernelGate } from "../evals/kernel/scorer.js";

const families: RecurrenceFamily[] = ["explicit_domain_lost", "stale_result_replay"];

function observation(
  id: string,
  override: Partial<KernelCaseObservation> = {}
): KernelCaseObservation {
  return {
    caseId: id,
    passed: true,
    boundary: "result_envelope",
    recurrenceFamily: id.endsWith("1") ? families[0] : families[1],
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: true,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs: 100,
    returnedRetrievableJob: false,
    ...override
  };
}

describe("Kernel v1 gate scorer", () => {
  it("passes every metric at its approved boundary", () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      observation(`case-${index + 1}`, {
        recurrenceFamily: index === 0 ? families[0] : families[1],
        scheduleAssertions: [{ passed: index !== 0 }],
        ambiguityEligible: index < 5,
        ambiguityResolvedWithinTwoTurns: index < 4,
        performanceEligible: index < 10,
        elapsedMs: index < 9 ? 100 : 9_000,
        returnedRetrievableJob: index === 9
      })
    );
    const report = scoreKernelGate(observations, families);
    expect(report.metrics.schedule_accuracy).toMatchObject({ value: 0.99, passed: true });
    expect(report.metrics.core_journey_success).toMatchObject({ value: 1, passed: true });
    expect(report.metrics.unavailable_misclassification).toMatchObject({ incomplete: true });
    expect(report.metrics.ambiguity_resolution).toMatchObject({ value: 0.8, passed: true });
    expect(report.metrics.security_violations).toMatchObject({ value: 0, passed: true });
    expect(report.metrics.core_read_completion).toMatchObject({ value: 1, passed: true });
    expect(report.metrics.recurrence_coverage).toMatchObject({ value: 1, passed: true });
    expect(report.passed).toBe(false);
  });

  it("fails closed for a security violation and an unavailable misclassification", () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      observation(`case-${index + 1}`, {
        unavailableEligible: true,
        unavailableMisclassified: index === 0,
        securityViolations: index === 0 ? ["unauthorized_read"] : []
      })
    );
    const report = scoreKernelGate(observations, families);
    expect(report.metrics.unavailable_misclassification).toMatchObject({
      value: 0.01,
      passed: false
    });
    expect(report.metrics.security_violations).toMatchObject({ value: 1, passed: false });
    expect(report.passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the scorer test and verify it fails because the contracts do not exist**

Run: `pnpm vitest run src/__tests__/kernel-scorer.test.ts`

Expected: FAIL with module-not-found errors for `evals/kernel/contracts.js` and `scorer.js`.

- [ ] **Step 3: Implement allowlisted contracts**

Create `src/evals/kernel/contracts.ts` with these exported unions and interfaces:

```ts
export const RECURRENCE_FAMILIES = [
  "wrapper_words_hide_subject",
  "generic_schedule_domain_ambiguity",
  "explicit_domain_lost",
  "role_follow_up_lost",
  "stale_result_replay",
  "resource_memory_resurrection",
  "required_slot_misrouted",
  "pending_write_confirmation_escape",
  "group_requester_scope_leak",
  "unavailable_presented_as_not_found",
  "write_safety_bypass",
  "replica_state_divergence"
] as const;

export type RecurrenceFamily = (typeof RECURRENCE_FAMILIES)[number];

export type KernelBoundary =
  | "entrance_access"
  | "candidate_generation"
  | "planner_proposal"
  | "deterministic_validation"
  | "slot_ambiguity_resolution"
  | "active_task_lifecycle"
  | "adapter_retrieval"
  | "freshness_invalidation"
  | "result_envelope"
  | "response_projection"
  | "write_workflow"
  | "external_dependency"
  | "deployment_configuration";

export type SecurityViolation =
  | "unauthorized_read"
  | "unauthorized_write"
  | "scope_leak"
  | "confirmation_bypass"
  | "unsafe_binary_publication"
  | "scan_bypass";

export interface KernelScheduleAssertion {
  passed: boolean;
}

export interface KernelCaseObservation {
  caseId: string;
  passed: boolean;
  boundary: KernelBoundary;
  recurrenceFamily: RecurrenceFamily;
  failureCode?: string;
  scheduleAssertions: KernelScheduleAssertion[];
  coreJourneyEligible: boolean;
  coreJourneySucceeded: boolean;
  unavailableEligible: boolean;
  unavailableMisclassified: boolean;
  ambiguityEligible: boolean;
  ambiguityResolvedWithinTwoTurns: boolean;
  securityViolations: SecurityViolation[];
  performanceEligible: boolean;
  elapsedMs: number;
  returnedRetrievableJob: boolean;
}

export interface KernelCaseContext {
  now: () => Date;
}

export interface KernelAcceptanceCase {
  id: string;
  version: 1;
  journey: "schedule" | "ppt" | "sheet_music" | "resource" | "knowledge" | "memory" | "write";
  recurrenceFamily: RecurrenceFamily;
  run(context: KernelCaseContext): Promise<KernelCaseObservation>;
}

export interface KernelMetric {
  numerator: number;
  denominator: number;
  value?: number;
  threshold: string;
  passed: boolean;
  incomplete?: boolean;
  failedCaseIds: string[];
}

export type KernelMetricName =
  | "schedule_accuracy"
  | "core_journey_success"
  | "unavailable_misclassification"
  | "ambiguity_resolution"
  | "security_violations"
  | "core_read_completion"
  | "recurrence_coverage";

export interface KernelGateReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  totalCases: number;
  failedCaseIds: string[];
  metrics: Record<KernelMetricName, KernelMetric>;
  boundaryFailures: Partial<Record<KernelBoundary, string[]>>;
}
```

- [ ] **Step 4: Implement pure scoring with incomplete denominators failing closed**

Create `src/evals/kernel/scorer.ts`. Use helper functions `ratioMetric`, `countMetric`, and `failedIds`. The final `passed` value must be `Object.values(metrics).every(metric => metric.passed && !metric.incomplete)`.

```ts
import {
  type KernelCaseObservation,
  type KernelGateReport,
  type KernelMetric,
  type RecurrenceFamily
} from "./contracts.js";

export function scoreKernelGate(
  observations: readonly KernelCaseObservation[],
  requiredFamilies: readonly RecurrenceFamily[],
  generatedAt = new Date().toISOString()
): KernelGateReport {
  const schedule = observations.flatMap((entry) =>
    entry.scheduleAssertions.map((assertion) => ({ entry, passed: assertion.passed }))
  );
  const core = observations.filter((entry) => entry.coreJourneyEligible);
  const unavailable = observations.filter((entry) => entry.unavailableEligible);
  const ambiguity = observations.filter((entry) => entry.ambiguityEligible);
  const performance = observations.filter((entry) => entry.performanceEligible);
  const violations = observations.flatMap((entry) =>
    entry.securityViolations.map(() => entry.caseId)
  );
  const covered = new Set(observations.map((entry) => entry.recurrenceFamily));
  const missingFamilies = requiredFamilies.filter((family) => !covered.has(family));
  const metrics = {
    schedule_accuracy: ratioMetric(schedule, (entry) => entry.passed, ">= 0.98", 0.98),
    core_journey_success: ratioMetric(core, (entry) => entry.coreJourneySucceeded, ">= 0.85", 0.85),
    unavailable_misclassification: ratioMetric(
      unavailable,
      (entry) => !entry.unavailableMisclassified,
      "< 0.01 misclassified",
      0.99,
      true
    ),
    ambiguity_resolution: ratioMetric(
      ambiguity,
      (entry) => entry.ambiguityResolvedWithinTwoTurns,
      ">= 0.80",
      0.8
    ),
    security_violations: countMetric(violations.length, "= 0", violations),
    core_read_completion: ratioMetric(
      performance,
      (entry) => entry.elapsedMs <= 8_000 || entry.returnedRetrievableJob,
      ">= 0.90",
      0.9
    ),
    recurrence_coverage: {
      numerator: requiredFamilies.length - missingFamilies.length,
      denominator: requiredFamilies.length,
      value: requiredFamilies.length
        ? (requiredFamilies.length - missingFamilies.length) / requiredFamilies.length
        : undefined,
      threshold: "= 1.00",
      passed: requiredFamilies.length > 0 && missingFamilies.length === 0,
      incomplete: requiredFamilies.length === 0,
      failedCaseIds: missingFamilies.map((family) => `missing-family:${family}`)
    }
  } satisfies KernelGateReport["metrics"];
  const boundaryFailures: KernelGateReport["boundaryFailures"] = {};
  for (const entry of observations.filter((candidate) => !candidate.passed)) {
    (boundaryFailures[entry.boundary] ??= []).push(entry.caseId);
  }
  return {
    schemaVersion: 1,
    generatedAt,
    passed: Object.values(metrics).every((metric) => metric.passed && !metric.incomplete),
    totalCases: observations.length,
    failedCaseIds: observations.filter((entry) => !entry.passed).map((entry) => entry.caseId),
    metrics,
    boundaryFailures
  };
}
```

Implement `ratioMetric` so normal metrics use `passed / denominator`, while `invertFailureRate=true` records `1 - passedRatio` as the public value and passes only when that failure rate is `< 0.01`. An empty denominator returns `{ incomplete: true, passed: false }`. `failedCaseIds` contains the case IDs whose predicate failed.

- [ ] **Step 5: Run scorer tests and commit the contracts**

Run: `pnpm vitest run src/__tests__/kernel-scorer.test.ts`

Expected: PASS.

Commit:

```bash
git add src/evals/kernel/contracts.ts src/evals/kernel/scorer.ts src/__tests__/kernel-scorer.test.ts
git commit -m "test: define Kernel v1 acceptance metrics"
```

---

### Task 2: Build a Synthetic Real-Turn Runtime Harness

**Files:**

- Create: `src/evals/kernel/runtime-harness.ts`
- Create: `src/__tests__/kernel-runtime-harness.test.ts`
- Modify: `src/__tests__/agent-turn-runtime.test.ts`

**Interfaces:**

- Consumes: `createAgentTurnRuntime`, `createControlledAgentRouter`, existing in-memory stores and handlers.
- Produces: `createKernelRuntimeHarness(options)`, `KernelRuntimeHarness.runTurns(turns)`, sanitized `KernelTurnResult`.

- [ ] **Step 1: Extract no production behavior; first test the public harness contract**

Create `src/__tests__/kernel-runtime-harness.test.ts` with a schedule fixture containing two domains and prove:

1. an explicit `下一場影視團隊服事音控是誰` turn returns only the role value;
2. `下一場服事` returns a capability-resolution clarification when both domains match;
3. a second requester cannot continue requester one’s active task;
4. returned diagnostics contain only allowlisted trace fields.

Use synthetic assignees `同工甲` and `同工乙`, source keys `media_schedule` and `morning_schedule`, group `G_SYNTHETIC`, and users `U_SYNTHETIC_1/2`.

- [ ] **Step 2: Run the harness test and verify module-not-found failure**

Run: `pnpm vitest run src/__tests__/kernel-runtime-harness.test.ts`

Expected: FAIL because `runtime-harness.ts` does not exist.

- [ ] **Step 3: Implement the harness around `createAgentTurnRuntime`**

Define these public types in `runtime-harness.ts`:

```ts
export interface KernelTurnInput {
  text: string;
  requesterUserId: string;
  requestId: string;
}

export interface KernelTurnResult {
  replyText?: string;
  quickReplyLabels: string[];
  resultStatus?: "success" | "not_found" | "ambiguous" | "unavailable";
  trace: AgentTurnTraceRecord[];
  elapsedMs: number;
}

export interface KernelRuntimeHarness {
  runTurns(turns: readonly KernelTurnInput[]): Promise<KernelTurnResult[]>;
}

export interface KernelRuntimeHarnessOptions {
  now: () => Date;
  profile: BotProfileConfig;
  functionRegistry: FunctionRegistry;
  textMessageHandlers?: TextMessageHandlerRegistry;
  planner: AgentPlanner;
  sessionStore?: SessionStore;
  conversationWindowStore?: ConversationWindowStore;
  elapsedMs?: (turnIndex: number) => number;
}
```

Create one `InMemoryAgentTraceStore`, `MemoryInFlightStore`, `InMemoryLastErrorStore`, `InMemoryLastRouteStore`, `InMemorySessionStore`, and `InMemoryConversationWindowStore` per harness. Build the real controlled router with the supplied planner. For each turn, call `runtime.handleTextTurn` with a synthetic group event and return the newly recorded sanitized trace plus reply projection. Do not include `text`, handler arguments, entities, URLs, source titles, or provider payloads in `KernelTurnResult`.

- [ ] **Step 4: Replace duplicated schedule fixture setup in the new harness test only**

Keep `agent-turn-runtime.test.ts` behavior assertions intact. Do not move production code or weaken its cases. Reuse only exported test fixture constructors where duplication is exact; otherwise leave the existing test unchanged.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
pnpm vitest run src/__tests__/kernel-runtime-harness.test.ts src/__tests__/agent-turn-runtime.test.ts
```

Expected: both files PASS.

Commit:

```bash
git add src/evals/kernel/runtime-harness.ts src/__tests__/kernel-runtime-harness.test.ts src/__tests__/agent-turn-runtime.test.ts
git commit -m "test: add real-turn Kernel evaluation harness"
```

---

### Task 3: Add the Versioned Schedule and Ambiguity Corpus

**Files:**

- Create: `src/evals/kernel/cases/schedule.ts`
- Create: `src/evals/kernel/corpus.ts`
- Create: `src/__tests__/kernel-corpus.test.ts`

**Interfaces:**

- Consumes: `KernelAcceptanceCase`, `createKernelRuntimeHarness`.
- Produces: `SCHEDULE_KERNEL_CASES`, `KERNEL_ACCEPTANCE_CASES`, `validateKernelCorpus(cases)`.

- [ ] **Step 1: Write corpus invariants and schedule-quality tests**

Test that case IDs match `kernel-v1/<journey>/<slug>@1`, are unique, version is `1`, every schedule-owned recurrence family is present in the schedule corpus, schedule cases contribute at least 50 schedule assertions, and at least five cases are genuine ambiguity cases with four resolving in two turns. Full coverage of all declared recurrence families becomes mandatory after Task 4 combines the retrieval and security/state modules.

The schedule cases must include exact one-turn domain queries, generic multi-domain clarification, Quick Reply selection, bare-role continuation, explicit new-query replacement, expired-task behavior, meeting-window advancement in `Asia/Taipei`, and a newly registered synthetic third domain that requires no router code change.

- [ ] **Step 2: Run the corpus test and verify it fails**

Run: `pnpm vitest run src/__tests__/kernel-corpus.test.ts`

Expected: FAIL because the corpus modules do not exist.

- [ ] **Step 3: Implement generated canonical schedule cases**

In `schedule.ts`, generate stable cases from this immutable matrix:

```ts
const DOMAIN_MATRIX = [
  { key: "media_schedule", alias: "影視團隊", role: "音控", assignee: "同工甲" },
  { key: "morning_schedule", alias: "晨更家族", role: "帶領家族", assignee: "家族乙" },
  { key: "children_schedule", alias: "兒童主日", role: "主持", assignee: "同工丙" },
  { key: "prayer_schedule", alias: "禱告會", role: "敬拜", assignee: "同工丁" },
  { key: "sunday_schedule", alias: "主日", role: "導播", assignee: "同工戊" }
] as const;

const WORDING_MATRIX = [
  "下一場{domain}服事的{role}是誰",
  "請幫我查{domain}下一次{role}",
  "我想知道下一場{domain}的{role}",
  "{domain}下一場服事，{role}是誰",
  "幫我找{domain}服事表裡下一場的{role}",
  "下一次{domain}{role}",
  "查詢{domain}下一場{role}",
  "麻煩給我{domain}下一場的{role}",
  "下一場{domain}聚會由誰負責{role}",
  "{domain}下回{role}是哪位"
] as const;
```

The cross product produces exactly 50 canonical assertions. Every case executes the real turn runtime with declarative schedule metadata and asserts the selected domain, occurrence, role, assignee, and focused reply. Add five non-generated ambiguity/lifecycle cases for the recurrence families described in Step 1.

- [ ] **Step 4: Implement corpus validation**

`validateKernelCorpus` returns an array of allowlisted error codes and never throws raw case data. It checks ID format, duplicate IDs, version, positive elapsed values, and required recurrence-family coverage.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts src/__tests__/query-schedule.test.ts src/__tests__/schedule-domain-registry.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/evals/kernel/cases/schedule.ts src/evals/kernel/corpus.ts src/__tests__/kernel-corpus.test.ts
git commit -m "test: add versioned schedule acceptance corpus"
```

---

### Task 4: Add Retrieval, Freshness, State, and Write-Safety Cases

**Files:**

- Create: `src/evals/kernel/cases/retrieval.ts`
- Create: `src/evals/kernel/cases/security-and-state.ts`
- Modify: `src/evals/kernel/corpus.ts`
- Modify: `src/__tests__/kernel-corpus.test.ts`
- Modify: `src/__tests__/retrieval-product-evals.test.ts`

**Interfaces:**

- Consumes: existing catalog, knowledge, resource-memory, attachment, access, and active-task test fixtures.
- Produces: `RETRIEVAL_KERNEL_CASES`, `SECURITY_AND_STATE_KERNEL_CASES` included in the unified corpus.

- [ ] **Step 1: Extend corpus tests with the approved recurrence and journey matrix**

Assert that the unified corpus contains these stable case IDs:

```ts
const requiredIds = [
  "kernel-v1/ppt/sequential-distinct-query@1",
  "kernel-v1/ppt/wrapper-words-subject@1",
  "kernel-v1/sheet_music/catalog-hit@1",
  "kernel-v1/sheet_music/unavailable-not-not-found@1",
  "kernel-v1/resource/fresh-second-query@1",
  "kernel-v1/resource/tombstone-cannot-resurrect@1",
  "kernel-v1/resource/reference-validation@1",
  "kernel-v1/knowledge/body-only-routing@1",
  "kernel-v1/knowledge/section-document-source-follow-up@1",
  "kernel-v1/memory/explicit-save-retrieve@1",
  "kernel-v1/write/bare-confirmation-precedence@1",
  "kernel-v1/write/unauthorized-save-denied@1",
  "kernel-v1/write/scan-unavailable-fails-closed@1",
  "kernel-v1/write/group-attachment-without-intent-silent@1",
  "kernel-v1/write/group-requester-cannot-complete-other-upload@1",
  "kernel-v1/resource/unavailable-not-not-found@1",
  "kernel-v1/state/group-requester-isolation@1",
  "kernel-v1/state/expired-active-task-not-used@1"
] as const;
```

Also require at least ten unavailable cases, ten security/state cases, and twenty non-schedule core-journey cases. These counts prevent a single happy-path schedule matrix from hiding product failures.

- [ ] **Step 2: Run the corpus test and verify the new IDs are missing**

Run: `pnpm vitest run src/__tests__/kernel-corpus.test.ts`

Expected: FAIL listing the missing stable IDs.

- [ ] **Step 3: Implement retrieval cases through real handlers and controlled turns**

In `retrieval.ts`, reuse the production handlers with in-memory catalog/knowledge stores and deterministic Graph/Notion provider doubles. Each case returns only `KernelCaseObservation`; never return reply text, titles, people, URLs, queries, or adapter payloads to the scorer. Generate the ten unavailable cases by varying journey and failure boundary while keeping `unavailableEligible=true` and asserting `unavailableMisclassified=false`.

Map the existing `RETRIEVAL_PRODUCT_CASES` names to the new stable IDs in a compatibility assertion inside `retrieval-product-evals.test.ts`; do not delete the focused regression tests until every old name has a corresponding Kernel case.

- [ ] **Step 4: Implement security and requester-state cases**

In `security-and-state.ts`, execute the existing controlled write and state boundaries with synthetic principals. Record a `SecurityViolation` only when the observed behavior violates the expected fail-closed result. The expected passing observations have an empty `securityViolations` array; the test suite must inject one deliberately unsafe fake outcome and prove the scorer fails.

- [ ] **Step 5: Run focused suites and commit**

Run:

```bash
pnpm vitest run src/__tests__/kernel-corpus.test.ts src/__tests__/retrieval-product-evals.test.ts src/__tests__/attachment-save.test.ts src/__tests__/agent-memory.test.ts src/__tests__/active-task.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/evals/kernel/cases/retrieval.ts src/evals/kernel/cases/security-and-state.ts src/evals/kernel/corpus.ts src/__tests__/kernel-corpus.test.ts src/__tests__/retrieval-product-evals.test.ts
git commit -m "test: cover Kernel retrieval and safety journeys"
```

---

### Task 5: Execute the Corpus and Produce Redacted Reports

**Files:**

- Create: `src/evals/kernel/evaluate.ts`
- Create: `src/evals/kernel/report.ts`
- Create: `src/tools/eval-kernel.ts`
- Create: `src/__tests__/kernel-report.test.ts`
- Create: `src/__tests__/kernel-eval.test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: `KERNEL_ACCEPTANCE_CASES`, `scoreKernelGate`.
- Produces: `evaluateKernelGate(options)`, `renderKernelReportMarkdown(report)`, `writeKernelReport(report, outputDirectory)`, CLI exit code.

- [ ] **Step 1: Write report redaction and CLI-behavior tests**

Test deterministic ordering, schema version `1`, stable case IDs, metric numerators/denominators, boundary failure grouping, and that serialized reports do not match this forbidden-content expression:

```ts
const forbidden =
  /U[0-9a-f]{8,}|G[0-9a-f]{8,}|https?:\/\/|token|secret|replyToken|queryText|sourceTitle|fileName|personValue|providerPayload|同工甲/u;
```

Test that an all-passing report returns CLI exit code `0`, a failed or incomplete gate returns `1`, and an execution/configuration error returns `2` with only an allowlisted error code.

- [ ] **Step 2: Run tests and verify module-not-found failures**

Run:

```bash
pnpm vitest run src/__tests__/kernel-report.test.ts src/__tests__/kernel-eval.test.ts
```

Expected: FAIL because evaluator/report modules do not exist.

- [ ] **Step 3: Implement deterministic evaluation**

`evaluateKernelGate` accepts optional `cases`, `now`, and `concurrency` with concurrency bounded from `1` to `8`. Sort cases by ID before execution, convert thrown case errors to a failed observation with `failureCode="case_execution_failed"` and the case’s declared boundary, and pass only observations to `scoreKernelGate`.

- [ ] **Step 4: Implement report rendering and safe artifact writes**

`writeKernelReport` creates the output directory, writes `report.json` using `JSON.stringify(report, null, 2)`, and writes Markdown containing only version, generated time, overall result, metric rows, failed case IDs, and boundary classifications. Before writing, run `assertKernelReportSafe(serialized)` against a structural allowlist and the forbidden expression. Throw `kernel_report_contains_forbidden_data` on failure.

Add this line to `.gitignore`:

```gitignore
artifacts/
```

- [ ] **Step 5: Implement the CLI**

`src/tools/eval-kernel.ts` must use `pathToFileURL`, run the default corpus with the fixed evaluation clock `2026-07-21T00:00:00.000Z`, write to `artifacts/kernel-v1`, print one summary line per metric, and set `process.exitCode` to `0`, `1`, or `2` as tested. It must not print turn text or fixture values.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm vitest run src/__tests__/kernel-report.test.ts src/__tests__/kernel-eval.test.ts
```

Expected: PASS and no tracked artifact files.

Commit:

```bash
git add .gitignore src/evals/kernel/evaluate.ts src/evals/kernel/report.ts src/tools/eval-kernel.ts src/__tests__/kernel-report.test.ts src/__tests__/kernel-eval.test.ts
git commit -m "feat: add redacted Kernel acceptance report"
```

---

### Task 6: Make the Kernel Gate a Required Local and PR Check

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**

- Consumes: `src/tools/eval-kernel.ts`.
- Produces: `pnpm eval:kernel`; required `Kernel v1 acceptance gate` CI step.

- [ ] **Step 1: Write deployment-contract assertions before changing scripts**

Extend `profile-config-deployment-contract.test.ts` to assert:

```ts
expect(packageJson.scripts["eval:kernel"]).toBe("tsx src/tools/eval-kernel.ts");
expect(ciWorkflow).toContain("name: Kernel v1 acceptance gate");
expect(ciWorkflow).toContain("run: pnpm eval:kernel");
expect(ciWorkflow.indexOf("run: pnpm test")).toBeLessThan(
  ciWorkflow.indexOf("run: pnpm eval:kernel")
);
expect(ciWorkflow.indexOf("run: pnpm eval:kernel")).toBeLessThan(
  ciWorkflow.indexOf("run: pnpm build")
);
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts`

Expected: FAIL because the script and workflow step are absent.

- [ ] **Step 3: Add the package script and CI step**

Add to `package.json` scripts:

```json
"eval:kernel": "tsx src/tools/eval-kernel.ts"
```

Add after `Controlled agent eval` and before `Compile app` in `.github/workflows/ci.yml`:

```yaml
- name: Kernel v1 acceptance gate
  run: pnpm eval:kernel
```

- [ ] **Step 4: Run the contract and gate**

Run:

```bash
pnpm vitest run src/__tests__/profile-config-deployment-contract.test.ts
pnpm eval:kernel
```

Expected: both commands PASS; the gate writes ignored report files and prints no synthetic fixture content.

- [ ] **Step 5: Commit CI wiring**

```bash
git add package.json .github/workflows/ci.yml src/__tests__/profile-config-deployment-contract.test.ts
git commit -m "ci: require Kernel v1 acceptance gate"
```

---

### Task 7: Document Operation, Failure Triage, and the Next Stabilization Slice

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/operations/controlled-agent-support.md`
- Create: `docs/kernel-v1/acceptance-baseline.md`
- Create: `src/__tests__/kernel-docs.test.ts`

**Interfaces:**

- Consumes: gate commands, metrics, report paths, and failure boundaries.
- Produces: operator/agent instructions and the first redacted baseline record.

- [ ] **Step 1: Add documentation assertions**

Extend `src/__tests__/profile-config-deployment-contract.test.ts` or create `src/__tests__/kernel-docs.test.ts` to require the exact strings `pnpm eval:kernel`, `artifacts/kernel-v1/report.json`, all seven metric keys, `case_execution_failed`, and the rule that runtime fixes are planned from failed boundary IDs rather than phrases.

- [ ] **Step 2: Run the docs test and verify failure**

Run: `pnpm vitest run src/__tests__/kernel-docs.test.ts`

Expected: FAIL until the documentation is updated.

- [ ] **Step 3: Update repository guidance**

Document in `README.md` how developers run the gate and interpret exit codes. Add to `AGENTS.md` that behavior work after R3 must add or update a Kernel case and that failed Kernel cases are fixed at their declared architecture boundary. Add to the support runbook the privacy-safe triage sequence: support ID, sanitized trace, Kernel case ID, boundary, then architecture-fix plan.

- [ ] **Step 4: Generate and commit the redacted baseline**

Run `pnpm eval:kernel`, then create `docs/kernel-v1/acceptance-baseline.md` containing only:

- git commit under test;
- corpus schema/version and case count;
- seven numerator/denominator/value results;
- failed case IDs and boundary counts;
- statement that integration, live-provider, and production observation gates remain separate later stabilization slices.

Do not copy synthetic turn text or generated artifact files into the document.

- [ ] **Step 5: Run docs test and commit**

Run: `pnpm vitest run src/__tests__/kernel-docs.test.ts`

Expected: PASS.

Commit:

```bash
git add README.md AGENTS.md docs/operations/controlled-agent-support.md docs/kernel-v1/acceptance-baseline.md src/__tests__/kernel-docs.test.ts
git commit -m "docs: operate the Kernel v1 acceptance gate"
```

---

### Task 8: Full Verification, Review, PR, and Production Observation

**Files:**

- Verify all files changed by Tasks 1–7.
- Do not add runtime behavior fixes in this task.

**Interfaces:**

- Consumes: complete first-slice implementation.
- Produces: merged acceptance-gate PR, green PR CI, successful Production Release, and a failure inventory for the next focused plans.

- [ ] **Step 1: Run the complete local verification suite**

Run in this order:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:agent
pnpm eval:retrieval-product
pnpm eval:kernel
pnpm build
git diff --check origin/main...HEAD
```

Expected: all commands PASS. If `eval:kernel` fails, preserve its redacted failed case IDs, stop delivery, and create architecture-boundary fix plans before merging.

- [ ] **Step 2: Verify privacy and repository cleanliness**

Run:

```bash
git status --short
git ls-files artifacts
rg -n "https?://|replyToken|providerPayload|personValue|fileName|sourceTitle" docs/kernel-v1 src/evals/kernel
```

Expected: `git ls-files artifacts` prints nothing. Any matches are inspected; only source-code denylist literals or documentation descriptions are allowed, never fixture/report values.

- [ ] **Step 3: Request code review and address findings**

Use `superpowers:requesting-code-review`. Review contract correctness, denominator math, privacy safety, use of the real turn runtime, deterministic execution, and CI placement. Fix all correctness or security findings and rerun Step 1.

- [ ] **Step 4: Push, open a PR, and enable auto-merge**

Push `codex/kernel-v1-stabilization`, open a ready PR titled `Kernel v1: add deterministic acceptance gate`, and enable squash auto-merge. The PR body must state that this is the first stabilization slice and does not claim integration/live/production acceptance.

- [ ] **Step 5: Monitor PR CI, merge, and Production Release**

Wait for required `PR CI`, confirm the squash merge reached `main`, and monitor `Production Release` if triggered. The gate tooling must not change runtime behavior, but the deployment still receives the normal Gateway/Dapr unsigned webhook smoke and ACA healthy/100%-traffic checks.

- [ ] **Step 6: Classify the next work from the report**

If the gate passes, create the next implementation plan for the Redis/PostgreSQL/restart/two-replica integration matrix. If it fails, group failed case IDs by `KernelBoundary` and create one focused architecture-fix plan per shared boundary before the integration slice. Do not create a phrase-specific repair plan.

---

## Plan Self-Review Result

- **Spec coverage:** This first delivery implements the versioned corpus, deterministic evaluator, seven metrics, redacted artifacts, failure boundaries, CI gate, privacy policy, and first acceptance summary. Redis/PostgreSQL integration, live providers, production observation aggregation, and final Kernel v1 acceptance are explicitly separate later slices as required by the spec delivery model.
- **Scope:** One independently reviewable PR creates a useful deterministic gate without mixing unknown runtime repairs into evaluator construction.
- **Type consistency:** `KernelAcceptanceCase`, `KernelCaseObservation`, `KernelGateReport`, and `scoreKernelGate` have one definition and are consumed consistently by corpus, evaluator, report, CLI, and tests.
- **No hidden authority:** The harness calls `createAgentTurnRuntime` and the production controlled router; evaluator code only observes and scores outcomes.
- **Privacy:** Reports serialize allowlisted observation fields and stable case IDs only; raw turns remain inside synthetic fixture execution.

# Task 5 Report: Shared LINE Account Experience and Authorization

## Status

Complete on `codex/main-login-ux-plan` from the required base
`cad10b940e7a3a4c2b5d3fc51241467c4a63eb78`.

- Repository:
  `/Users/rayselfs/Projects/hhc/hhc-line-function-bot/.worktrees/main-login-ux-plan`
- Account API source was inspected read-only through `ba827df`; it was not
  modified.
- Push, PR, merge, deployment, credential access, and production mutation were
  intentionally not performed.
- Dependencies, migrations, caches, routers, and policy engines: none added.
- Legacy LINE `accountLink` event finalization remains available for rollback
  traffic.

## Boundary Trace

Before changing shared access or turn behavior, the following callers and
owners were traced:

- The action catalog and deterministic policy gate own local help, login, and
  identity intent recognition. They run before semantic routing.
- `webhook-routes.ts` owns signed webhook entrance ordering, webhook-event
  dedupe, reserved challenge traffic, public commands, transport replies, and
  per-event runtime construction.
- `public-access-commands.ts`, the effective-capability presenter/projection,
  and `intro.ts` own user-facing account and function presentation.
- `effective-access.ts` owns the local managed-principal boundary. PostgreSQL
  roles/grants remain stored, but no longer expand effective functions.
- Candidate generation, the controlled plan stage, the turn runtime, ordered
  continuation stages, postbacks, pending resolutions, active tasks, attachment
  intake, and confirmation were traced as one authority chain.
- Task 4's bounded `authorizeFunctions` client is the only Account authorization
  lookup. A turn-local memo shares its result across entrance, candidate,
  continuation, and execution checks.
- The rate limiter, webhook-event store, sanitized product event sink, test
  runtime, agent evals, and Kernel corpus were inspected before altering
  ordering or diagnostics.

## Requirements Mapping

| Requirement                            | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared local account actions           | `/help`, `幫助`, `說明`, `功能`, and `可以做什麼` map to help; the six specified login phrases map to login; `/whoami` and the four specified identity phrases map to account identity. Matching is catalog-owned, normalized, exact, and negation-aware. The generic controlled router has no phrase-specific branch.                                                                                                 |
| Byte-exact account challenge entrance  | Only `HHC_ACCOUNT_LINK_V1:` followed by exactly 43 unpadded base64url bytes is accepted. Parsing performs no Unicode normalization. An ASCII local guard reserves HHC/account/link lookalikes separated by spaces, `_`, or `-`. Reserved traffic is processed before ordinary webhook-event dedupe, with its own rate limit, retryable 503/redelivery behavior, terminal acknowledgment, and allowlist-only telemetry. |
| Legacy rollback safety                 | Existing LINE `accountLink` event handling remains intact. Ordinary message dedupe is unchanged and is not reused for the one-shot Account challenge.                                                                                                                                                                                                                                                                  |
| Account-aware help/login/whoami        | Disabled, unbound, active, inactive, and unavailable Account states use the shared presenter. Only unbound direct-chat users receive a binding action. Active identity output is limited to canonical account ID, trusted display name, masked email, and public roles. Internal Account/provider values are never shown. Function names use public display names.                                                     |
| No duplicate binding                   | Login asks Account for an empty function list and creates a binding only for the unbound state. Active/inactive accounts are presented without issuing another binding. Group and account-link-disabled profiles cannot start binding.                                                                                                                                                                                 |
| Allowed function intersection          | Help, identity, intro, registration onboarding, and controlled routing present or execute only the intersection of profile configuration, public read defaults, Account authorization, source policy, and side-effect policy. The `main` profile remains provider-free.                                                                                                                                                |
| Local grants and roles retired         | Stored user/group function grants and managed roles no longer add effective capability. Scope-management actions are absent from the action catalog/evals, retired slash forms are recognized only to return the hidden-management rejection, and old persistence methods/tables remain for compatibility.                                                                                                             |
| Authorization before planner           | Public read candidates remain locally available. Matching permission-required candidates are authorized through Account before the planner sees them. A denied-only candidate set returns `function_disabled` without a planner/provider request. The configured restricted ceiling is included in deterministic candidate discovery even though it is outside the public read projection.                             |
| Continuation and write reauthorization | Pending confirmation/cancellation, resolver selection, required-slot collection, attachment workflows, active-task continuation, postbacks, and capability-owned text entrances reauthorize the owning restricted function before continuing. Denied or unavailable authorization fails closed and cannot reuse stale local grants, previews, or task state.                                                           |
| One Account lookup per handled turn    | A memoized turn authorizer is shared by all authorization consumers. Public weekly/default traffic and unknown text perform zero Account authorization calls. A handled turn performs at most one bounded Account API lookup.                                                                                                                                                                                          |
| Observability and failure behavior     | Challenge/product events contain bounded status/reason metadata only. Raw messages, challenges, account identifiers, invite codes, and provider payloads are not recorded. Account unavailability fails closed for restricted functions while public reads and local account-state presentation retain their defined safe behavior.                                                                                    |

## TDD Evidence

Implementation was split into bounded RED/GREEN waves. Production behavior was
not added until the focused regression for that boundary failed.

### Wave 1: catalog aliases and reserved challenge

RED covered the exact alias matrix, negation, byte-exact parser, Unicode
lookalikes, reserved ordering, dedicated rate limiting, retry/terminal
acknowledgment, legacy `accountLink`, reply failure, and telemetry privacy.
The shared catalog and webhook entrance were then changed; the initial focused
suite finished green with 151 tests.

### Wave 2: account-state presentation

Nine new state-matrix regressions initially failed on the missing shared
Account behavior. The minimum presenter, public-command, and webhook changes
made disabled, unbound, active, inactive, unavailable, group, and provider-free
cases pass. The expanded focused suite finished green with 179 tests.

### Wave 3: effective access and controlled authorization

RED covered retired local grants, authorization before planning, denied and
unavailable candidates, active-task/collection/confirmation continuation,
attachment ownership, and the one-lookup invariant. Shared fixes were made at
effective access, candidate generation, the controlled plan stage, turn runtime,
and text continuation stages. No alternate router or function-specific generic
branch was introduced. Focused coverage expanded through 210 tests.

### Wave 4: shared onboarding and write-function authority

Intro and `/registry` regressions first proved that raw profile capabilities
could still be advertised without the Account intersection. A final three-test
RED then proved that a restricted write outside the read projection was not
discoverable, an allowed pending write stayed disabled, and a
capability-owned text entrance was not authorizing. The root fixes added the
configured permission-required ceiling to deterministic candidates and a typed
capability declaration to continuation handlers. The final focused command was:

```text
pnpm exec vitest run \
  src/__tests__/action-policy.test.ts \
  src/__tests__/admin-action-registry.test.ts \
  src/__tests__/agent-turn-runtime.test.ts \
  src/__tests__/controlled-agent-router.test.ts \
  src/__tests__/effective-access.test.ts \
  src/__tests__/effective-capability-projection.test.ts \
  src/__tests__/entrance.test.ts \
  src/__tests__/intro.test.ts \
  src/__tests__/kernel-corpus.test.ts \
  src/__tests__/kernel-local-live-app.test.ts \
  src/__tests__/attachment-save.test.ts \
  src/__tests__/functions.test.ts \
  src/__tests__/sheet-music.test.ts \
  src/__tests__/query-knowledge.test.ts

Test Files  14 passed (14)
Tests       382 passed (382)
```

## Verification

The following final gates exited zero:

```text
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm build
pnpm eval:agent
pnpm eval:kernel
pnpm eval:admin
git diff --check
```

- Architecture validation checked 399 TypeScript files.
- Agent eval: candidates 20/20, validated 20/20; the advisory proposal score
  remained 14/20 as expected and does not own authority.
- Kernel eval: 116 cases, core 116/116, schedule 50/50, core read 104/104,
  recurrence 12/12. Existing negative-control counters remained unavailable
  0/15, ambiguity 5/6, and security 0/1.
- Admin eval passed all 14 cases.

The exact repository test command reported:

```text
Test Files  139 passed | 1 failed (140)
Tests       1610 passed | 7 failed (1617)
```

All seven failures are confined to the existing fake-cleanup cases in
`src/__tests__/kernel-local-live-runner.test.ts`. This macOS host has no
`/dev/shm`, so the fail-closed runner exits at its memory-storage prerequisite
before the fake Docker fixture can create `calls.log`. The static test in that
file passes, and Task 5 does not change the runner, shell script, or fixture.

All changed Prettier-supported files pass a targeted Prettier check. The
repository-wide `pnpm format:check` remains nonzero only for seven pre-existing
SDD Markdown files: `task-1-brief.md`, `task-1-report.md`, `task-1-review.md`,
`task-2-brief.md`, `task-3-brief.md`, `task-4-brief.md`, and `task-5-brief.md`.
They were not reformatted because they are prior/input artifacts outside the
implementation.

## Files Changed

- Product and architecture documentation: `AGENTS.md`, `README.md`, and
  `docs/architecture-context.md`.
- Local action/policy and account presentation: `src/actions/*`,
  `src/application/capabilities/*`, `src/intro.ts`, and
  `src/transport/line/public-access-commands.ts`.
- Webhook and execution authority: `src/transport/line/webhook-routes.ts`,
  `src/transport/line/postbacks.ts`, `src/application/access/effective-access.ts`,
  controlled router/turn stages/runtime, typed handler contracts, and five
  capability-owned text handlers.
- Test/eval support: focused unit/entrance/runtime tests, test composition,
  Kernel runtime/cases/corpus, and admin evals.

## Handoff / Concerns

- The production helper profile currently declares
  `permissionRequiredFunctions: []`. Task 5 implements and verifies the generic
  Account-authorized write boundary, but the brief did not authorize choosing
  or changing the production rollout list. Enabling a specific restricted
  function remains an explicit configuration/product decision.
- No live Account API smoke test was performed. Contract behavior is covered by
  strict fakes and the Task 4 bounded client tests; deployment requires the
  existing Account presentation/API environment to be provisioned.
- The `/dev/shm` full-suite limitation and pre-existing SDD formatting failures
  are host/repository conditions, not Task 5 regressions.
- Rollback can retain the legacy `accountLink` event path and revert this single
  focused application commit. No data migration or destructive cleanup is
  required because old grant tables remain intact.

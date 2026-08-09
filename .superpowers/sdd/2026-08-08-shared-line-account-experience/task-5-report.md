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
| Account-aware help/login/whoami        | Disabled, unbound, active, inactive, and unavailable Account states use the shared presenter. Only unbound direct-chat users receive a binding action. Active identity output is limited to trusted display name, masked email, and public roles; no canonical Account ID is displayed. Internal Account/provider values are never shown. Function names use public display names.                                     |
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

## Initial Verification

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

## Review Remediation: 2026-08-09

The first review identified four important authorization gaps. They were fixed
in a separate bounded TDD round without adding a router, policy engine, cache,
or framework.

### Wave 1: postback and slow-job ownership

The focused RED run reported 8 failures with 159 passing tests. It proved that
postback registrations did not declare an owning function, in-memory and Redis
jobs did not retain that capability, selection postbacks made no Account
authorization request, and revoked or unavailable job authorization could
still reveal a stored result.

Every postback registration now owns a declarative `FunctionName`. Slow jobs
persist the capability that created the result, including explicit attachment
and sheet-import jobs and generic controlled turns. Selection handlers and job
result delivery authorize that owner through the existing per-event memo before
the handler or result is exposed. Public reads remain local; restricted,
revoked, unavailable, and missing-owner results fail closed. The focused wave
finished with 167/167 tests passing, and the expanded boundary later passed as
part of the 248-test suite.

This also corrects the initial report's premature postback statement: before
this remediation, postback result delivery was not fully reauthorized. It is
now covered for allowed, denied, revoked, unavailable, and one-underlying-lookup
selection-plus-job turns.

A final diff audit found one remaining generic slow-turn edge: controlled
results were not universally stamped with the validated route action, so only
handlers that happened to return `executedAction` persisted an owner. The
focused RED run reported 3 failures with 220 passing tests. The shared runtime
now stamps every executed controlled result with its server-owned capability;
an ownerless timed-out turn becomes a failed job; and legacy completed jobs
without an owner cannot replay. That focused suite finished 223/223.

### Wave 2: full configured ceiling and Account administrator writes

The corrected RED fixture reported 6 failures with 221 passing tests. It used a
managed helper principal and the production-shaped
`permissionRequiredFunctions: []` configuration to prove that writes outside
the public read projection disappeared before discovery, preview, and
confirmation.

The controlled input now carries the full configured `enabledFunctions`
ceiling separately from the effective public projection. Explicit
`permissionRequiredFunctions` require names returned in Account
`allowedFunctions`; the administrator flag does not bypass that explicit
contract. A configured write absent from the public projection is restored only
when the same Account response has `administrator: true`. That status is
propagated through preview, confirmation, continuation, text handlers, and job
delivery. Managed admin allow, non-admin deny, Account-unavailable deny, and
one-lookup behavior are covered. The focused entrance/router/job/turn boundary
finished green.

### Wave 3: memory commands and truthful help

The focused RED run reported 9 failures with 170 passing tests. `/memories` and
`/forget-memory` could enter the legacy memory runtime without explicit
capability authorization, and help advertised commands that were unavailable
to the current source or requester.

The command catalog now maps `/memories` to `retrieve_memory` and
`/forget-memory` to `save_memory`. Webhook entrance verifies configuration,
declared source, the memoized Account decision, and normal action/write policy
before invoking the memory runtime. Public `retrieve_memory` remains local;
explicit `save_memory` grants and administrator-only configured writes follow
their distinct rules. Help command presentation now observes registration,
LINE source, effective functions, and Account/managed authorization. It hides
protected commands for unmanaged requesters and hides `/whoami` in groups. The
entrance suite passed 182/182 and the combined help/projection/memory suite
passed 212/212.

### Wave 4: protected capability-resolution continuation

The RED run reported 4 failures with 32 passing tests. A pending protected
capability choice performed no Account authorization, denied and unavailable
choices were consumed before that decision, and an explicit protected-function
switch authorized only the old pending function.

The shared continuation inventory now includes bounded
`pending_capability_resolution` candidates and deterministic explicit-switch
candidates whenever continuation state exists. Authorization happens before a
continuation handler, and a selected capability-resolution session is deleted
only after the selected capability is effective. Denied and unavailable
protected selections remain retryable; choosing a public alternative stays
local; an allowed protected switch receives the restored capability. The
focused entrance/router/jobs/turn suite passed 248/248.

### Kernel and final verification

A new versioned Kernel case,
`kernel-v1/write/account-admin-outside-read-projection@1`, covers the actual
helper-shaped administrator-write boundary. Its corpus-presence test was RED
before the case was added. The case models the existing per-event Account memo,
so its two runtime consumers represent one underlying Account lookup.

Final gates for the remediation:

```text
pnpm exec vitest run <16 focused files>
Test Files  16 passed (16)
Tests       437 passed (437)

pnpm eval:agent
candidates 20/20, proposal 14/20, validated 20/20

pnpm eval:kernel
117 cases; core 117/117; schedule 50/50; core read 104/104;
recurrence 12/12; unavailable 0/15; ambiguity 5/6; security 0/1

pnpm eval:admin
14/14

pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm build
git diff --check
targeted Prettier check for every changed supported file
```

Architecture validation checked 399 TypeScript files. Every command above
exited zero.

The fresh full repository test result was:

```text
Test Files  139 passed | 1 failed (140)
Tests       1643 passed | 7 failed (1650)
```

The same seven pre-existing fake-cleanup cases in
`src/__tests__/kernel-local-live-runner.test.ts` fail on this macOS host because
`/dev/shm` is absent and the runner exits before the fixture writes `calls.log`.
The file's static test passes. This remediation does not change the runner,
script, or fake binaries.

## Handoff / Concerns

- The production helper profile declares `permissionRequiredFunctions: []`.
  Its configured writes are now reachable only for a currently active Account
  administrator. If product policy later moves a function into
  `permissionRequiredFunctions`, it will instead require an explicit
  `allowedFunctions` entry; administrator status alone will not bypass it.
- No live Account API smoke test was performed. Contract behavior is covered by
  strict fakes and the Task 4 bounded client tests; deployment requires the
  existing Account presentation/API environment to be provisioned.
- The `/dev/shm` full-suite limitation and pre-existing SDD formatting failures
  are host/repository conditions, not Task 5 regressions.
- Rollback can retain the legacy `accountLink` event path and revert this single
  focused application commit. No data migration or destructive cleanup is
  required because old grant tables remain intact.

## Review Remediation Round 2: 2026-08-09

The second review found two remaining cross-capability authorization gaps and
one unnecessary Account lookup. They were fixed in a separate three-wave TDD
round with existing handler ownership, memory-store methods, continuation state,
and the per-event Account memo. No router, policy engine, cache, dynamic phase
framework, or profile-specific generic branch was added.

### Wave 1: external sheet-music import phase ownership

The focused RED run reported 4 failures with 20 passing tests. It proved that
the handler registered as `sheet_music_numeric_selection` owned only the public
`find_sheet_music` capability while it also selected, targeted, and confirmed
the `external_sheet_music_import` write flow. Denied and unavailable Account
decisions therefore still matched that public handler.

The public numeric-selection and external-search-consent handler now stops at
the read boundary. A second statically registered continuation owns
`save_resource` and matches only the external import session. The existing
text-continuation authorization boundary temporarily restores the configured
write only for matching, calls the per-event memo before the handler, and then
either supplies the authorized write profile or skips the handler. Selection,
target choice, confirmation, session consumption, durable scan work creation,
and the resulting slow job therefore all carry `save_resource` authority.

The administrator path covers all three interactive phases and makes exactly
one authorization request per handled turn. Non-administrator and unavailable
Account paths fail closed before the handler and leave the complete selecting
session unchanged. The focused sheet-music and registry suite finished 24/24.

### Wave 2: text-memory command isolation

The focused RED run reported 1 failure with 19 passing tests. Its reply showed
that `/memories` exposed a resource record and a structured schedule entry in
addition to the explicit text memory. The same legacy runtime also fell through
from text deletion to resource and schedule deletion.

`/memories`, which is owned by `retrieve_memory`, now calls only
`listTextMemories`. `/forget-memory`, which is owned by `save_memory`, now calls
only `forgetMemory`; a resource or schedule identifier returns not found and
the underlying record remains active. The regression covers hidden resource
and schedule content, non-deletion of both record types, and successful listing
and deletion of an ordinary text memory. The agent-memory suite finished 20/20.
The administrator-only `/memory-status` diagnostic remains unchanged.

### Wave 3: selected capability authorization

The focused RED run proved that choosing the public `query_schedule` option
from a mixed `query_schedule`/`save_memory` pending resolution still invoked
Account for the unselected protected alternative.

Candidate parsing is now a pure shared operation used both by continuation
authorization and by capability-resolution resumption. The authorization
inventory contains only the selected pending candidate plus any independently
detected explicit switch candidate. A public selection makes zero Account
calls. A selected protected candidate still makes one memoized lookup; allowed
choices resume and consume the session, while denied and unavailable choices
remain retryable. The complete agent-turn runtime suite finished 37/37,
including the existing protected allow/deny/unavailable and explicit-switch
regressions.

### Round 2 verification

Fresh proportional verification passed:

```text
pnpm exec vitest run <5 focused files>
Test Files  5 passed (5)
Tests       264 passed (264)

pnpm eval:agent
candidates 20/20, proposal 14/20, validated 20/20

pnpm eval:kernel
117 cases; core 117/117; schedule 50/50; core read 104/104;
recurrence 12/12; unavailable 0/15; ambiguity 5/6; security 0/1

pnpm eval:admin
14/14

pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm build
git diff --check
```

Architecture validation again checked 399 TypeScript files. Every command in
the block exited zero. A targeted Prettier check covers every Round 2 changed
source, test, and report file. Repository-wide `pnpm format:check` remains
nonzero only for the same seven pre-existing SDD Markdown inputs listed above;
none is a Round 2 change.

No live Account API smoke test was run. The authorization behavior is covered
at the per-event authorizer seam and by the existing production-shaped helper,
Account administrator, webhook, postback, and Kernel regressions. The known
macOS `/dev/shm` full-suite limitation is unchanged; Round 2 required and ran
the proportional suite rather than altering the unrelated live-runner fixture.

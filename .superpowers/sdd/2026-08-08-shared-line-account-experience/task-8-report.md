# Task 8 Report: Shared `update_own_profile` Function

## Status

Complete on `codex/main-login-ux-plan`. The bot now exposes one shared,
direct-only `update_own_profile` capability. Production enables and
permission-requires it only on the provider-free `main` profile; `helper`
remains disabled.

## Delivered behavior

- Registered `update_own_profile` once as a vertical capability module with
  its definition, ports, handler, eval corpus, and module factory.
- Added the exact public argument contract:
  `firstName?: string` and `lastName?: string`. Internal `confirm` and `cancel`
  flags remain owned by the existing pending-function workflow.
- Limited initial intent to the exact normalized whole-message forms
  `/profile`, `修改個人資料`, `修改姓名`, and `更新姓名`. Missing slash,
  punctuation changes, embedded requests, negation, ambiguity, unsupported
  sources, and disabled profiles do not become write candidates.
- Extended the shared capability contract with declarative `exactIntents`
  metadata. Candidate generation and deterministic validation use the same
  helper, avoiding a function-specific router or validator branch.
- Let configured exact slash-function commands take ownership before the
  legacy admin-command path through definition metadata. There is no literal
  `main` branch; helper's existing admin `/profile` behavior remains available
  because helper does not enable this function.
- Reused the existing required-slot and pending-function stages for first name,
  last name, preview, cancellation, expiry, and explicit confirmation. No form,
  cache, state store, or parallel router was added.
- Added a generic turn-runtime fail-closed check: if authority is denied when a
  validated collect/execute plan is rechecked, the runtime does not create
  collection state or execute the handler.
- Rechecks restricted continuation authority on every pending turn, including
  confirmation, through the existing per-webhook memoized Account authority.
  Revocation before confirmation consumes the pending state without mutation.
- Calls Task 7 exactly at `POST /priv/account/v1/line/profile` with only
  `line_user_id`, `profile_name`, `first_name`, and `last_name`. It never sends
  an HHC user ID or permission code.
- Strictly accepts only Task 7's `first_name`, `last_name`, and `updated_at`
  response fields, then returns only normalized first and last name to the
  capability handler.
- Returns the normalized name in the user reply, but uses a generic sanitized
  `agentResult`. Names are absent from task entities, memory payloads, agent
  traces, route telemetry, product telemetry, and write-audit metadata. The
  next `/whoami` performs a fresh Account lookup and displays the updated
  account summary.
- Updated `config/profiles.json`, README, and AGENTS guidance. Only `main`
  includes the function in both `enabledFunctions` and
  `permissionRequiredFunctions`.

## TDD evidence

The implementation used bounded RED/GREEN waves before production behavior:

1. Capability contract RED: the new tests initially reported six failures for
   the missing definition, four absent exact intents, and provider-free
   clarification instead of slot collection. The minimal shared definition,
   candidate policy, validator policy, and module registration made the wave
   green.
2. Preview/commit RED: module registration first reported zero registrations;
   preview reported no handler; commit deliberately failed with
   `update_own_profile_commit_not_implemented`. Each was made green with the
   shared handler and exact Account payload.
3. Webhook lifecycle RED: provider-free `/profile` returned capability help
   because the legacy admin-command entrance intercepted it. Definition-driven
   command ownership and pre-authorization ordering made the complete
   collection/preview/confirmation flow green.
4. Production config RED: the deployment contract showed `main` missing the
   function. The checked-in profile update made it green while asserting
   helper remains disabled.
5. Runtime authority RED: a second denied authority result still created a
   name-collection session. The generic runtime recheck now converts that plan
   to a fail-closed denial.
6. Exact-intent RED: `profile`, `修改姓名！`, and `修改 姓名` were initially
   accepted because ordinary capability normalization strips punctuation and
   whitespace. Exact-intent normalization now preserves those distinctions.
7. Kernel corpus RED: adding the three Task 8 cases exposed fixed corpus counts
   and IDs in the Kernel tests. The corpus contract now includes all eleven
   product-experience cases explicitly.

## Verification

- Focused capability, Account client, router, validator, runtime, webhook,
  module, production-config, and Kernel-contract suite: 10 files, 425 tests
  passed.
- `pnpm config:validate`: passed.
- `pnpm eval:agent`: passed; candidates 20/20, validated plans 20/20.
- `pnpm eval:kernel`: passed; 120/120 cases and every metric passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm architecture:check`: passed for 405 TypeScript files.
- `pnpm build`: passed.
- Full `pnpm test`: 1,686/1,693 tests passed. The only seven failures are the
  same baseline failures in `kernel-local-live-runner.test.ts`, caused by the
  test fixture trying to read a missing generated `calls.log` file.
- Full `pnpm format:check`: Task 8 files are formatted. The command remains
  non-zero because pre-existing ignored SDD brief/report files are not
  Prettier-formatted; those unrelated artifacts were not rewritten.

## Safety and architecture notes

- No provider, alternate router, function-specific generic routing branch,
  state store, cache, persistence schema, or framework was added.
- Initial exact intent may collect and preview provider-free, but no route can
  invoke Task 7 without the existing explicit confirmation state.
- The confirmation is one-shot. Repeated confirmation does not call Account
  again.
- Pending state is profile/source/requester scoped and expires through the
  existing session store. Another requester, a group, an unlinked/denied
  account, or a disabled profile cannot complete the write.
- Account API Task 7 commit `a7fd407` was inspected read-only for the exact
  payload, response, validation, authorization, and status contract.

## Deployment

No push, pull request, merge, deployment, or external mutation was performed.

## Fix Round 1

### Review adjudication

- The raw-UID audit finding was not implemented because it conflicts with the
  approved brief and the existing security-audit contract. Task 8 requires the
  signed LINE UID for the Account call and prohibits the normalized name from
  agent memory, task entities, or telemetry; it does not prohibit actor
  identity in the access audit. Specifically, Task 8 brief steps 5 and 6 say
  to call Account with the signed UID and keep the normalized name out of
  memory/task entities/telemetry. In the existing schema,
  `src/access/types.ts` declares `actorUserId: string` on both
  `AccessAuditInput` and `AccessAuditEvent`;
  `src/access/migrations.ts` declares `actor_user_id text not null`; and
  `src/access/postgres-access-store.ts` writes that required value. The
  administrator-only `/audit-list` surface deliberately renders the actor.
  There is no approved shared audit pseudonymizer. Skipping or changing
  attribution for this one write would weaken the existing write-audit
  semantics rather than close a telemetry leak.
- A persisted-audit regression now exercises the complete profile-update
  lifecycle. It verifies the preview and commit audit records retain the
  caller as `actorUserId`, while neither normalized name appears anywhere in
  the serialized audit events. Production audit behavior was intentionally
  left unchanged.
- The duplicate exact-intent finding was valid. The action catalog's existing
  NFKC, trailing-punctuation, whitespace, locale-casing, and unnegated-clause
  behavior is now one shared exact whole-message matcher in
  `agent/plan-evidence`. System-action hints, write-capability candidates, and
  configured slash-command ownership all use it.
- Non-slash exact write aliases additionally require the existing
  `hasWriteIntent` guard. Slash aliases remain definition-owned. This preserves
  provider-free exact intent while failing closed for negated, embedded, and
  ambiguous messages without adding a function-specific branch or matcher
  framework.
- This round supersedes the earlier report's statement that all punctuation
  changes are rejected: approved trailing sentence punctuation such as
  `修改姓名！` is normalized and accepted. Embedded word spacing such as
  `修改 姓名`, missing slash, negation, embedding, and ambiguity remain
  rejected.

### RED/GREEN and verification

- RED command:
  `pnpm vitest run src/__tests__/update-own-profile.test.ts src/__tests__/entrance.test.ts --reporter=dot`.
  Output: 1 failed, 204 passed; the only failure was
  `offers the shared capability for one exact intent: 修改姓名！`, because the
  candidate list was empty.
- GREEN command: the same focused command. Output: 2 test files passed,
  205/205 tests passed after the shared matcher change. The wider capability,
  action-policy, router, validator, runtime, Account client, webhook, and
  production-profile command passed 9 test files and 465/465 tests.
- `pnpm eval:agent`: passed; candidates 20/20 and validated plans 20/20.
- `pnpm eval:kernel`: passed; 120/120 cases and every metric passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check` (405 TypeScript
  files), and `pnpm build`: passed.
- Full `pnpm test`: 1,687/1,694 tests passed. The only seven failures remain
  the pre-existing `kernel-local-live-runner.test.ts` fixture failures caused
  by `ENOENT` while reading an absent generated `calls.log`; no Task 8 or
  matcher test failed.

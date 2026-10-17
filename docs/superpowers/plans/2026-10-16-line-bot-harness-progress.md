# LINE Bot improvement implementation status

The reviewed [plan](2026-10-16-line-bot-harness-improvement.md) and
[review disposition](2026-10-16-line-bot-harness-review.md) define the scope.
P1–P8 now have implementations. This record distinguishes implementation and
verification from merge, deployment and real-user acceptance. None of this batch
has been merged or deployed; final head checks are recorded on the linked PRs.

| Stage | Implemented behavior                                                                                                                                                                                                                                       | Review units                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P0    | Isolated task worktrees, current producer contracts, synthetic local dependencies and explicit rollout boundaries.                                                                                                                                         | This plan and the cross-repo PRs below.                                 |
| P1/P2 | Correct bulletin response parsing and membership failures; admitted requester/group dialogue limits, atomic warning suppression; bound automatic media bypasses dialogue quota.                                                                            | Bot #99                                                                 |
| P3    | Renewable webhook owner/lease CAS, stable event/job identity, uncertain execution outcomes, separate LINE delivery status.                                                                                                                                 | Bot #100                                                                |
| P4    | Scoped quote receipts, untrusted quote context, requester/chat/profile isolation, reset/unsend generation fences, bounded retention and offline evaluation. Unknown/foreign quotes ask the requester to restate; no ambient group transcript is collected. | Bot #101                                                                |
| P5    | Exact Account binding intent/generation, cancellation and restart; one-use Bot continuation; current member/edition/legal projection and private capability presentation.                                                                                  | Account API #169, Account FE #112, Gateway #171, Web API #240, Bot #102 |
| P6    | Authorized general/children and content-language editions; exact bulletin selectors survive login/legal; existing latest/issue download commands remain compatible, with protected website delivery.                                                       | Website #218, Bot #103                                                  |
| P7    | Fresh code-issuer authority, immutable binding/admission generations, retained published owners, publication-attempt journal, exact-version pause/resume/unbind and unused-code revocation.                                                                | Bot #105–#109, Audit #24, Gateway #173, Admin #252                      |
| P8    | Unique receipt counts, bounded status/cursors and polling, safe individual retry, bulk meeting-binding projection and preservation of other collection links.                                                                                              | Bot #104/#109, Gateway #172/#173, Operations #63, Admin #251/#252       |

## PR locations and dependency order

- Bot: [#99](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/99),
  [#100](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/100),
  [#101](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/101),
  [#102](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/102),
  [#103](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/103),
  [#104](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/104),
  [#105](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/105),
  [#106](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/106),
  [#107](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/107),
  [#108](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/108),
  [#109](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/109).
  The conversation/member chain (#99–#103) and media chain (#104–#108) are both
  integrated into #109, including their explicit webhook/composition dependencies.
  These PRs target main for the repository's CI trigger. Review the focused units,
  merge prerequisites in order and refresh dependent diffs before delivery.
- Account: [API #169](https://github.com/HallelujahHomeChurch/account-api/pull/169),
  [FE #112](https://github.com/HallelujahHomeChurch/account-fe/pull/112), and
  [Gateway #171](https://github.com/HallelujahHomeChurch/api-gateway/pull/171).
  Release the Account contract before its frontend/Bot continuation consumers.
- Bulletin: [Web API #240](https://github.com/HallelujahHomeChurch/hhc-web-api/pull/240)
  and [Website #218](https://github.com/HallelujahHomeChurch/hhc-web/pull/218).
  Producer authority/discovery and the website target route precede Bot links.
- Media status: [Gateway #172](https://github.com/HallelujahHomeChurch/api-gateway/pull/172),
  [Operations #63](https://github.com/HallelujahHomeChurch/operations-api/pull/63),
  [Admin #251](https://github.com/HallelujahHomeChurch/admin-fe/pull/251).
  Deploy the additive projections before their Admin consumers.
- Lifecycle: [Audit #24](https://github.com/HallelujahHomeChurch/audit-log/pull/24),
  [Gateway #173](https://github.com/HallelujahHomeChurch/api-gateway/pull/173),
  [Admin #252](https://github.com/HallelujahHomeChurch/admin-fe/pull/252).
  Canonical audit actions and all compatible workers precede routes and UI.
  `MEDIA_SYNC_LIFECYCLE_ENABLED` defaults to false. Enabling it is a separate
  reviewed rollout action after older workers are drained.

## Verification evidence

- Each focused PR has its own required CI checks; follow the check for its final
  head rather than assuming a previous green run covers a later commit.
- The media journal slice passed 1,654 full-suite tests and real kernel integration.
  The completed media controls/retry slice passed 1,678 full-suite tests before
  the conversation/member integration. The integrated entry/control suite passed
  432 tests, including signed ingress and the existing 30/60-media regressions.
  The final integrated full suite passed 1,755 tests across 146 files; Admin passed
  1,283 tests across 129 files.
- New PostgreSQL tests cover concurrent publication reservation, immutable late
  results, withdrawal cleanup, binding/admission changes, exact-code revocation,
  idempotent audits, pause/resume owner retention and constrained single-work retry.
- Typecheck, lint, build, formatting, architecture, OpenAPI, offline agent evaluation
  and real Redis/PostgreSQL integration are included in Bot verification. Offline
  model-call counters are fixtures, not evidence of live provider calls.
- Admin focused API/UI/page tests cover exact versions, stable keys after unknown
  HTTP outcomes, current-authority failures and stale confirmation dismissal.
  Synthetic browser verification covered desktop and 390px mobile width, Chinese
  copy, pause/resume/unbind, retained settling warnings and individual retry
  eligibility without horizontal overflow. It used no production account.
- Gateway static and local Docker runtime tests cover the exact Admin route/method
  allowlist and header policy. Audit Go and PostgreSQL tests include the intentional
  refusal to roll back non-empty audit data.

## Accepted boundaries and remaining acceptance

- Implementation adjustment: worker outcomes explicitly distinguish pause, unbind
  and admission revocation. Source withdrawal retains the existing tombstone/delete
  outbox flow; explicit collection deletion retains its separate deletion ledger
  and Asset service operation. These durable paths distinguish destructive intent
  without introducing duplicate worker outcome names for existing deletion flows.

- Unknown external publication results remain blocked for authoritative
  reconciliation. No automatic replay or guessed-owner deletion is provided.
  Explicit withdrawal may remain pending until that result is resolved.
- An interrupted manual save that cannot prove independent current authority stays
  blocked. Pausing/unbinding never silently cancels it or deletes a shared Asset.
- A fresh remote issuer check and local code consume are not a cross-service
  transaction. The reviewed revocation window remains explicit.
- Pause skips new intake without backfill. Known in-flight calls may finish;
  settling/unknown counts prevent an inaccurate "fully stopped" presentation.
- No production secrets, runtime flags, real LINE messages, live model requests or
  real member login were used. LINE iOS/Android, two-requester same/cross-group
  quotes, login/legal changes, 30/60 real media and revoke/pause/unbind device
  acceptance remain pending after an authorized deployment.
- Preserve unmerged task worktrees. Merge, CD release, health smoke and real-user
  acceptance remain separate gates; earlier burst-fix CD investigation stays closed.

## Conversation continuity follow-up (2026-10-17)

The integrated Bot PR #109 also contains the focused context follow-up. See
[the continuity plan](2026-10-17-line-context-continuity.md) for the two completed
independent reviews (Codex and official agy Gemini), accepted fixes, current
verification, migration boundary and remaining real-device acceptance. These Bot
changes require no additional Account, Gateway, Admin or Presenter edits. Earlier
cross-repository dependency and merge gates remain in force.

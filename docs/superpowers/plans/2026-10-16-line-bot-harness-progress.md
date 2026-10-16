# LINE Bot improvement implementation status

The reviewed plan and review disposition in this directory remain the full scope.
This document records implementation evidence separately from deployment acceptance.

| Stage | Status                             | Evidence / remaining work                                                                                                                                   |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Started                            | Isolated Bot worktree from `df809fa`; synthetic local dependencies only. Cross-repo implementation worktrees remain to be created.                          |
| P1    | Implemented in this change         | Exact-issue `data` array, series/locale validation, inactive Account and actionable 403/428 handling. Provider-free main retained.                          |
| P2    | Implemented in this change         | Ambient group admission before dialogue quota, requester isolation, independent group cap, atomic Redis expiry and warning claim, legacy key compatibility. |
| P3    | Implemented in the recovery branch | Owner/lease CAS on the compatible receipt key; stable operation jobs before dispatch; uncertain results and separate LINE delivery status.                  |
| P4    | Not implemented                    | Quote receipts, requester-scoped context, reset/unsend generation fences and evaluation cases.                                                              |
| P5    | Not implemented                    | Account API correlation/cancel/status, Bot continuation and membership projection.                                                                          |
| P6    | Not implemented                    | Authorized edition discovery and exact website continuation through login/legal.                                                                            |
| P7    | Not implemented                    | Worker fences, retained-assets unbind, code revocation, pause/resume.                                                                                       |
| P8    | Not implemented                    | Scoped ingest status, bounded polling/retry and meeting selection improvements.                                                                             |

## P1/P2 verification

- Focused ingress, config, store, rate-limit and bulletin tests pass, including the existing 30/60 media burst regressions.
- Real Redis/PostgreSQL evaluator passes all 22 cases, including cross-replica notification claims, legacy TTL repair, existing group-key migration, restart durability and namespace/container cleanup.
- Offline agent evaluator passes without live provider calls.
- Typecheck, lint, build, formatting and architecture checks pass.
- Signed synthetic `/help` webhook through Fastify injection returns HTTP 200; no actual LINE delivery is implied.
- Full test suite and PR CI are separate gates; consult the PR check results for the final commit.
- No merge, deployment, production configuration change, real account flow or LINE device acceptance has occurred.

The group cap defaults to 100 admitted Bot turns per window, independently of the
20-turn requester allowance. Bound automatic media intake bypasses both dialogue
buckets. During rolling deployment old replicas retain their old quota behavior;
the new fairness and notification guarantees apply only after all replicas upgrade.
No Redis flush is needed.

## P3 recovery verification and rollout

P1/P2 is PR #99, whose required CI passed at commit `6f3f01c`. The recovery change
builds on that commit. P1/P2 local full-suite failures were six existing shell-fixture
timeouts under concurrent machine load; all six passed unchanged when rerun alone.

Ordinary webhook receipts now use a renewable two-minute lease and owner CAS. Only
pre-dispatch admission failures may release their claim. A lease expiring after
execution starts becomes uncertain, never an automatic replay. Completed receipts
remain for seven days. Existing native Account linking/challenge, media intake and
unsend paths retain their owning idempotency behavior.

A stable event/operation job is persisted before starting an agent or approval turn.
The four-second handoff only changes delivery; it does not enqueue durable work.
Lost execution leases and handler/result-store failures remain uncertain. A known
late result can resolve uncertainty; an already completed result cannot be replaced.
LINE delivery failure is recorded separately and never causes another business call.

Real Redis/PostgreSQL tests cover owner takeover, stale-owner rejection, legacy
receipt compatibility, concurrent execution claims, immutable completed results,
and a committed database write followed by an exception and retry (one row only).
The integration matrix has 24 cases and the owning suites include 21 tests.

Rollout preserves `webhook-event:v1` keys. Legacy `1` receipts remain terminal; old
replicas see new JSON receipts as existing and do not run them. Recovery is available
only on upgraded replicas. Drain in-flight turns before rollback; retaining keys is
mandatory. No production redelivery setting or device behavior has been verified.
P4 is implemented in the following slice. P5–P8 remain pending.

## P4 quoted context

P3 is PR #100 at `d478c09`, with required CI passed. This slice builds on P1–P3;
merge dependencies first and refresh each dependent PR before delivery.

The LINE adapter returns ordered sent-message IDs without quote tokens. A PostgreSQL
index accepts only admitted requester messages and matching Bot replies, partitioned
by profile/chat/requester. Bot entries retain the originating safe request as a
server-owned reference, never literal tool output or sharing links. A quote of a
known Bot reply may wake a registered group; foreign/unknown content asks the user
to restate the request. No ambient group conversation is collected.

Quote text is explicitly untrusted model input. Existing live tool authorization
and write review gates remain authoritative; quoted confirmation cannot approve.
Group/direct content TTL is 15/30 minutes. Seven-day metadata tombstones reject
unsend-before-original and events older than retention. Reset/unsend bump a generation
before checkpoint cleanup; pending cleanup survives failures. Checkpoint guards and
reply indexing reject stale generations, and job-result/review buttons validate the
original context. A LINE message already accepted cannot be recalled by this fence.
Wake-window storage now keeps activity markers instead of unused conversation text.

Verification includes ordered receipts, actual signed ingress, cross-requester/profile/
chat isolation, sensitive-text exclusion, stale replies, tombstones, retryable cleanup,
late real PostgreSQL LangGraph checkpoint deletion and offline prompt/authority cases.
Native LINE device quotes, live model behavior and production migration are pending.

Deployment must drain old workers before relying on reset/unsend fences: older
replicas do not understand context tokens. The additive tables can remain on rollback;
rollback does not provide these new invalidation guarantees. No production actions
have been performed for this slice.

## P5 Account continuation and member status

P4 is PR #101 at `d434c08`; required CI passed. P1/P2 #99 and P3 #100 also remain
open with passing CI. These are dependent slices, not merged production behavior.

Companion producer/consumer PRs:

- Account API #169 (`2345332`): exact scoped intent generation, status, cancellation,
  restart, consent reset, unchanged original expiry and terminal winner. Required CI passed.
- Gateway #171 (`1d5c0f8`): exact public POST cancel/restart routing, with CSRF and
  intent proof enforced by Account. Required CI passed.
- Account FE #112 (`ebb113a`): current intent view, cancellation, restart-before-switch,
  stale-response guards and terminal states. Required CI passed.
- Web API #240 (`34c7cf9`): Bot-only current qualification,
  edition grants and legal acceptance projection. Focused tests/OpenAPI passed;
  local full race hit a package timeout; CI policy has a scanner finding under
  investigation, image passed and Go verification is pending.

The Bot recognizes cancelled/superseded status and validates additive Account intent
correlation. An unbound direct main-profile bulletin request can start Account login
and retain only its allowlisted selectors, requester/chat/profile/channel, exact
intent/generation, context token and the earlier of ten minutes or Account expiry.
The existing session store provides one-use consumption. Browser restart, newer
intent, cancel, reset, unsend and expiry invalidate continuation. No old workflow,
generic arguments, login URL or secret is restored from the continuation record.

Completion offers an explicit Continue button only for the matching current intent;
the original button also permits recovery when the callback reply is lost. Clicking
checks the exact intent and context again, then resolves the current Account subject
and uses the existing protected content endpoint. Pending login does not consume or
extend the request. Callback completion never executes content or write operations.
Transient login replies are delivered once; persisted job results contain a safe
request-again message instead of the login URL. If the producer or context fence is
unavailable, ordinary login remains usable without promising continuation.

Private help/identity responses now distinguish Account roles from qualification,
edition grants, pending legal acceptance and authority unavailability. They do not
advertise the bulletin capability as available when member access is denied or unknown.
Content authorization remains fresh at the protected Web API endpoint.

Validation so far: exact continuation/member-client unit cases; signed ingress through
the production capability registry, Account challenge finalization and postback;
one-use parallel clicks, source isolation, generation drift, cancellation, expiry,
pending login, legacy producer, authority failure and transient credential exclusion.
The focused regression passed 221 tests (one optional integration skipped); the other
focused Account/main/result suites also passed. Typecheck, lint, build, format and
architecture checks passed. Full Bot regression/CI and live native LINE/browser
acceptance remain pending.

Deploy additive Account/Web API producers first, drain old Account replicas before
new consumers rely on generation fences, deploy Bot terminal-status support and
Gateway routes before enabling the Account FE cancellation/restart UI. No merge or
production rollout is included. P6 edition/discovery/exact website target, P7 binding
lifecycle and P8 ingest/Admin improvements remain pending.

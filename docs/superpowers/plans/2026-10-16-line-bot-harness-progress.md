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
P4–P8 remain unimplemented.

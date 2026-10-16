# LINE Bot improvement implementation status

The reviewed plan and review disposition in this directory remain the full scope.
This document records implementation evidence separately from deployment acceptance.

| Stage | Status                     | Evidence / remaining work                                                                                                                                   |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Started                    | Isolated Bot worktree from `df809fa`; synthetic local dependencies only. Cross-repo implementation worktrees remain to be created.                          |
| P1    | Implemented in this change | Exact-issue `data` array, series/locale validation, inactive Account and actionable 403/428 handling. Provider-free main retained.                          |
| P2    | Implemented in this change | Ambient group admission before dialogue quota, requester isolation, independent group cap, atomic Redis expiry and warning claim, legacy key compatibility. |
| P3    | Not implemented            | Receipt lease/CAS, pre-dispatch job association, uncertain execution and separate delivery outcomes.                                                        |
| P4    | Not implemented            | Quote receipts, requester-scoped context, reset/unsend generation fences and evaluation cases.                                                              |
| P5    | Not implemented            | Account API correlation/cancel/status, Bot continuation and membership projection.                                                                          |
| P6    | Not implemented            | Authorized edition discovery and exact website continuation through login/legal.                                                                            |
| P7    | Not implemented            | Worker fences, retained-assets unbind, code revocation, pause/resume.                                                                                       |
| P8    | Not implemented            | Scoped ingest status, bounded polling/retry and meeting selection improvements.                                                                             |

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

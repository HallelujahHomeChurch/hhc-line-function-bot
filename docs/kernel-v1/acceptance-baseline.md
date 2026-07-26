# Kernel v1 Acceptance Baseline

- Deterministic corpus schema: `1`
- Deterministic case version: `1`
- Deterministic case count: `106`
- Deterministic result: `PASS`
- Redis/PostgreSQL integration cases: `22`
- Integration result: `PASS`

| Metric                          | Numerator | Denominator |  Value |
| ------------------------------- | --------: | ----------: | -----: |
| `schedule_accuracy`             |        50 |          50 | 1.0000 |
| `core_journey_success`          |       106 |         106 | 1.0000 |
| `unavailable_misclassification` |         0 |          14 | 0.0000 |
| `ambiguity_resolution`          |         5 |           6 | 0.8333 |
| `security_violations`           |         0 |           1 | 0.0000 |
| `core_read_completion`          |        96 |          96 | 1.0000 |
| `recurrence_coverage`           |        12 |          12 | 1.0000 |

- Failed deterministic case IDs: none.
- Failed deterministic boundary counts: none.
- `case_execution_failed`: none.

The deterministic gate and the required Redis/PostgreSQL integration gate are
complete. `pnpm eval:kernel:integration` owns disposable dependencies, proves
two-client scope and atomicity, performs a real Redis restart with AOF, validates
pgvector migrations and atomic publication, and verifies that a PostgreSQL
knowledge search result preserves the real source identity across an anchored
follow-up. Its restart result applies to the owned Compose stack; production
persistence and failover remain operational responsibilities.

The manual local-live harness is implemented and has exercised signed synthetic
LINE webhooks through the real controlled runtime with real DeepSeek routing and
the existing Azure `text-embedding-3-small` deployment. The run history found
and corrected acceptance-fixture grounding defects plus a production
PostgreSQL mapping defect where `chunk.id` was incorrectly persisted as the
knowledge `sourceId`. Successful bounded evidence exists for schedule
execution/refinement, schedule ambiguity, provider-unavailable fail-closed,
requester-isolated independent execution, and confirmed local attachment
outbox behavior. Every run cleaned its Redis namespace, Compose resources, and
memory-backed secret files.

A newly authorized full run against commit
`2c124f3f13c03a4a7a7e4b31b59b30e6395f43f0` stopped after
`schedule-explicit` returned `not_found`; it made 1 DeepSeek request and 0
embedding batches, and did not execute the remaining cases. After the
deterministic current-message schedule role normalizer was corrected, a second
full run against commit `7a4a9c7983bc4cf0c54863de053941973c9dde99`
passed `schedule-explicit` and reached `schedule-refinement`. Both refinement
turns ended with successful schedule results, but its stricter journey
assertion failed; the two runs have consumed 4 DeepSeek requests and 0
embedding batches in total.

Both failed runs removed their Docker resources and Redis namespace. The shell
reported the failure stage as `cleanup` because it did not advance the stage
label after successful cleanup before propagating driver exit code `1`; this
diagnostic attribution is corrected. Allowlisted refinement boundary codes are
now emitted so the next single-case evidence run can distinguish provider,
turn-count, initial-turn, continuation-turn, and validator-reason failures
without exposing message content.

Final Kernel v1 acceptance is therefore not recorded. Do not mark R4
implementation started until an operator explicitly authorizes another bounded
full run and `artifacts/kernel-v1/local-live-report.json` reports all eight
cases `PASS` with exactly 9 successful DeepSeek requests, 3 successful
embedding batches, no provider failure/budget-exhaustion observation, and
successful cleanup. That bounded local report is the approved privacy-safe
replacement for the previously pending production observation window; no raw
LINE conversation or human tester is required.

The local simulation cannot prove LINE platform delivery or reply-token
behavior, production latency, production PostgreSQL/Redis failover, or Graph,
Notion, OneDrive, queue, and ClamAV availability. Those remain R5 operational
checks after the bounded Kernel v1 gate succeeds.

Future regressions are fixed from the failed boundary ID and shared architecture
contract；不要依失敗語句加入特例。

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

A diagnostic single-case run against commit
`45d6e6db` then isolated the refinement failure to its initial turn; it made 2
DeepSeek requests and 0 embedding batches. The three runs have therefore
consumed 6 DeepSeek requests and 0 embedding batches in total.

After the diagnostic boundary was narrowed, a single-case run against
`735b9a1e` passed both refinement turns with 2 DeepSeek requests. A following
full run passed `schedule-explicit` but again found no rows in the initial
refinement turn and stopped after 3 DeepSeek requests. The live runs have
therefore consumed 11 DeepSeek requests and 0 embedding batches in total. The
shared normalizer now drops model-inferred generic schedule nouns such as
`服事` from the role filter while preserving explicit known roles.

The next full run against `67a8a830` passed schedule execution, refinement, and
ambiguity, then stopped when the explicit switch correctly executed
`query_knowledge` but returned `not_found`. It made 5 DeepSeek requests and 1
embedding batch, bringing the live-run total to 16 DeepSeek requests and 1
embedding batch. The shared knowledge argument normalizer now removes explicit
capability prefixes such as `查知識` or `改查知識` from the retrieval query while
leaving ordinary follow-up questions unchanged.

All failed runs removed their Docker resources and Redis namespace. The shell
reported the failure stage as `cleanup` because it did not advance the stage
label after successful cleanup before propagating driver exit code `1`; this
diagnostic attribution is corrected. The diagnostic now attributes the failure
to `driver_result`. Allowlisted refinement boundary codes are further narrowed
so the next single-case evidence run can distinguish an initial capability
failure from `not_found`, `ambiguous`, `unavailable`, or missing result
evidence, without exposing message content.

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

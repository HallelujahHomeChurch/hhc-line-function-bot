# Kernel v1 Acceptance Baseline

- Commit under test: `fff4d006985ead9697af0afe2cd95fe59232190d`
- Corpus schema: `1`
- Case version: `1`
- Case count: `98`
- Result: `PASS`

| Metric                          | Numerator | Denominator |  Value |
| ------------------------------- | --------: | ----------: | -----: |
| `schedule_accuracy`             |        50 |          50 | 1.0000 |
| `core_journey_success`          |        98 |          98 | 1.0000 |
| `unavailable_misclassification` |         0 |          12 | 0.0000 |
| `ambiguity_resolution`          |         4 |           5 | 0.8000 |
| `security_violations`           |         0 |           1 | 0.0000 |
| `core_read_completion`          |        88 |          88 | 1.0000 |
| `recurrence_coverage`           |        12 |          12 | 1.0000 |

- Failed case IDs: none.
- Failed boundary counts: none.
- `case_execution_failed`: none.

This is the deterministic offline first-slice baseline. Redis/PostgreSQL restart and two-replica integration, live-provider evaluation, and production observation remain separate Kernel v1 stabilization slices. Final Kernel v1 acceptance precedes the roadmap transition to R4 Product Experience.

Future regressions are fixed from the failed boundary ID and shared architecture contract；不要依失敗語句加入特例。

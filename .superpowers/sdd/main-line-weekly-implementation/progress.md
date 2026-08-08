# SDD ledger — plan: /Users/rayselfs/Projects/hhc/hhc-line-function-bot/.worktrees/main-profile-prerequisites/.superpowers/sdd/main-line-weekly-implementation.md

Branch root: /Users/rayselfs/Projects/hhc/hhc-line-function-bot/.worktrees/main-profile-prerequisites
Merge base: f1b259c94008939ca1186bcd0daaedf9fc2115ab
Status: Task 8 implementation in progress
Baseline: `pnpm vitest run --exclude src/__tests__/kernel-local-live-runner.test.ts` passed 135 files / 1359 tests.
Baseline exception: `kernel-local-live-runner.test.ts` fails identically on untouched main because macOS lacks `/dev/shm`; Linux PR CI remains authoritative for that file.
Task 1: fix round 1/5 (1 addressed, 0 open — shared catalog dependency parsing; commits ccc239a..57ef020)
Task 1: complete (commits f1b259c..57ef020, review clean)
Task 1 verification: 8 files / 134 tests and TypeScript typecheck passed fresh after review.
Task 2: fix round 1/5 (main source classification cases addressed, 2 open — invalid 600+ status and missing network regressions; commits 4ac579d..24c81e5)
Task 2: fix round 2/5 (2 addressed, 0 open — bounded 500-599 and typed network regressions; commits 24c81e5..84c6551)
Task 2: complete (commits 57ef020..84c6551, review clean)
Task 2 verification: fresh 13 files / 156 tests and TypeScript typecheck passed after review.
Task 2 concern: `pnpm eval:kernel:integration` could not start because Docker Desktop `/_ping` timed out; real Redis focused contract passed 10/10, but Compose integration remains required before merge.
Task 2 accepted behavior: crash after external publication becomes durable `publication_abandoned` and never blindly republishes; operator reconciliation remains visible.
Task 3: minor (deferred): release post-deployment job-definition gate does not attest actual periodic job identity/registry identity; final review must decide whether this blocks merge.
Task 3: fix round 1/5 (1 addressed, 0 open — recover unknown-outcome create/grant IDs before cleanup; commits 4f065e8..4c4e666)
Task 3: complete (commits 84c6551..4c4e666, review clean; 1 deferred minor)
Task 3 verification: fresh 9 files / 191 tests and TypeScript typecheck passed after review.
Task 3: post-gate fix round 2 (stale periodic identity/deploy assertions and no-regex-spaces lint addressed; commit `001f5a7`).
Task 3 post-gate verification: focused 2 files / 21 tests, full lint, and exact full exclusion 138 files / 1464 tests passed.
Task 3 production boundary: probe code/manifests/preflight only; no Azure, production Asset, LINE, Graph, or catalog call was executed.
Task 4 worktree: `/Users/rayselfs/Projects/hhc/.worktrees/main-line-weekly/account-api`, branch `codex/native-line-account-link`, base `48877a248ed0b397ecb1fad088777e90af0cbdb8`.
Task 4 baseline: `go test ./...` passed all account-api packages.
Task 4 final base after rebase: `1ab1464`; feature commit `dc46d3c`, retry-safety fix `444a92b`.
Task 4: fix round 1/5 (2 addressed, 0 open — terminal-state immutability and atomic retry-safe fragment-to-session exchange; commits dc46d3c..444a92b).
Task 4: complete (commits 1ab1464..444a92b, scoped re-review approved).
Task 4 verification: implementer `go test -race ./... -count=1 -p=1`, `go vet ./...`, migration/bootstrap policy checks passed with disposable PostgreSQL/Redis; controller fresh `go test ./internal/security ./internal/services ./internal/repository -count=1` and `go vet ./...` passed.
Task 4 accepted behavior: if Redis commits the atomic transfer but the client loses the response, the unknown session handle cannot be recovered and the user restarts; the transfer cannot create a duplicate live session.
Task 4 deployment boundary: gateway must keep `/priv/account/v1/*` unreachable from public ingress and must not trust caller identity headers supplied by public clients.
Task 5 worktree: `/Users/rayselfs/Projects/hhc/.worktrees/main-line-weekly/account-fe`, branch `codex/native-line-account-link-ui`, base `6f28e45`.
Task 5 baseline: `pnpm test:run` passed 23 files / 127 tests; `pnpm build` and `pnpm lint` passed. Existing build emits only the pre-existing >500 kB chunk warning.
Task 5: feature commit `48d7e98`; fix round 1/5 (4 addressed, 0 open — raw bearer ref retention, late async prepare fencing, failed-stage retry, auth-unavailable recovery; commit `d94ed36`).
Task 5: complete (commits 6f28e45..d94ed36, scoped re-review approved).
Task 5 verification: implementer full 23 files / 153 tests, build, lint, diff-check passed; controller fresh 6 files / 78 tests and lint passed after review.
Task 5 accepted behavior: a one-tab boolean marker bridges provider callbacks that return through `/profile`; it stores no URL/token and a lost marker safely degrades to explicit Continue.
Task 6: complete (commit `71b5e8a`, independent review approved with no findings).
Task 6 verification: implementer focused 5 files / 155 tests, Kernel 114/114, format/type/architecture/build passed; controller fresh focused 5 files / 155 tests and typecheck passed. After Task3 assertion sync, exact full exclusion passed 138 files / 1464 tests and full lint passed.
Task 6 contract: native `account_login` is public/direct/security_change and provider-free; accountLink finalize runs before access/admin/rate/dedupe/LLM, transient transport/429/5xx returns 503, durable/permanent outcomes ack, and optional replies are best-effort.
Task 6 production boundary: no live LINE link token, accountLink event, Account API call, webhook enablement, push, or deployment was performed.
Task 7 hhc-web-api worktree: `/Users/rayselfs/Projects/hhc/.worktrees/main-line-weekly/hhc-web-api`, branch `codex/weekly-paper-by-number`, base `857106d`; baseline `go test ./...` passed.
Task 7 api-gateway worktree: `/Users/rayselfs/Projects/hhc/.worktrees/main-line-weekly/api-gateway`, branch `codex/weekly-paper-by-number-route`, base `eead47f`; baseline Go/auth/www/release/method-matrix/safe-logging tests passed. `scripts/test-safe-logging.sh` lacks execute mode on untouched main and was invoked with `bash`.
Task 7 implementation: hhc-web-api commit `4db0e92`; api-gateway commit `98e4a66`; both worktrees clean and under independent review.
Task 7 verification: web-api focused, full race, vet, migration policy/bootstrap/release checks passed; gateway Go/auth/www/release/method-matrix/safe-logging checks passed.
Task 7 environment gaps: PostgreSQL integration explicitly skipped because `HHW_TEST_DATABASE_URL` is not configured; container `nginx -t` was not run because Docker Desktop `/_ping` times out.
Task 7 production boundary: no push, PR, merge, deployment, gateway mutation, or live API call was performed.
Task 7: fix round 1/5 addressed the mutable published metadata restore boundary in hhc-web-api commit `c9c717e`; scoped re-review approved with no new findings.
Task 7 controller verification: fresh `go test` and `go vet` passed for bulletin, HTTP API, and PostgreSQL packages.
Task 7: complete (hhc-web-api `857106d..c9c717e`; api-gateway `eead47f..98e4a66`; independent review clean).
Task 7: fix round 1/5 (1 addressed, 0 open — public bulletin issue number/date cannot diverge during revision restore; web-api commit `c9c717e`).
Task 7 fix verification: focused restore RED/GREEN, full race suite, vet, and diff-check passed; PostgreSQL integration remains explicitly skipped because `HHW_TEST_DATABASE_URL` is not configured.
Task 8: implementation complete (commit `ed9a34b`; provider-free main profile, deterministic Weekly Paper read, profile-aware presentation, common entrance ordering, and bot-only main LINE secret refs).
Task 8 verification: focused 20 files / 535 tests, exact full exclusion, format, lint, typecheck, build, architecture, agent eval, and Kernel 115-case gate passed.
Task 8 integration correction: controller fresh `pnpm eval:kernel:integration` exited 2 with `kernel_integration_compose_start_failed`, `kernel_integration_compose_cleanup_failed`, and `ELIFECYCLE`; Docker daemon/Compose availability blocks this gate. The Docker daemon was not restarted and the gate was not reclassified as passed.
Task 8 fix round 1: corrected the cross-repo Weekly Paper URL contract to accept hhc-web-api's exact-origin absolute `https://www.alive.org.tw/assets/<32hex>` form while retaining canonical relative support and fail-closed origin/path/query validation.
Task 8 fix round 1 canonicality follow-up: absolute plain and encoded dot-segment paths now fail closed by validating the raw pathname and requiring parsed-path equality before URI acceptance.
Task 8 fix round 2: Dapr redirects fail closed, negated provider-free reads cannot become deterministic execution through either candidate or validator authority, and helper group stateful admission now occurs only after webhook dedupe and rate limiting.
Task 8 fix round 2 controller follow-up: clause-scoped negation closes nested/cancel/helper-form deterministic read bypasses without blocking reminders, and removal of the provider-group prefilter preserves active-window small talk after common dedupe/rate gates.
Task 8 production boundary: no push, merge, deployment, production credential read, or live LINE, Azure, provider, Account, HHC web API, Dapr, Graph, catalog, or Asset call was performed.

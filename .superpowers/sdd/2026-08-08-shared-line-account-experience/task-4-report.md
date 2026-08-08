# Task 4 Report: Bot Profile Account Presentation and Safe Client Contracts

## Status

Complete on `codex/main-login-ux-plan` from required base
`c94b0d6ab7a803c7b5ff5ed71342df308145651b`.

- Repository: `/Users/rayselfs/Projects/hhc/hhc-line-function-bot/.worktrees/main-login-ux-plan`
- Push/PR/merge/deploy: intentionally not performed
- Dependencies: none added
- Migrations: none added or changed
- Background-job secrets: none added

## Contract Trace

Before editing, the following caller and ownership boundaries were traced:

- `src/config.ts`, `src/profile-config-validation.ts`, and
  `config/profiles.json` own profile parsing, production-only validation, and
  runtime normalization.
- `src/account/account-admin-client.ts` is the single bot-to-Account API client.
- `src/bootstrap/create-production-runtime.ts` and
  `src/testing/create-test-app.ts` compose the account client and LINE transport.
- `src/transport/line/webhook-routes.ts` owns the explicit login entrance.
- Attachment, catalog, ClamAV, release-probe, and assurance loaders/manifests were
  checked separately from the bot runtime.
- Account API Task 1/2 source through `ba827df` was read-only. The confirmed
  contracts are POST `/priv/account/v1/line/bindings` with trusted account name
  and canonical account ID, and POST `/priv/account/v1/line/authorize` with a
  bounded requested function list and sanitized authorization response.

## Requirements Mapping

| Requirement                                              | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional account presentation with runtime normalization | `RawAccountLinkPresentation` and `AccountLinkPresentation` were added. The profile schema accepts only `displayName`, `lineIdEnv`, and `providerIdEnv`; only the full bot loader resolves them to runtime values. Tests cover absent, valid, partial, inline/unknown, missing environment, and invalid canonical LINE ID cases.                                                                                                   |
| Shared Provider ownership                                | Every account-link-enabled runtime profile contributes its resolved Provider ID to one equality check. More than one value throws during startup. Both production profiles point to the same environment reference.                                                                                                                                                                                                               |
| Function policy contract                                 | `ProfileFunctionPolicy` and `permissionRequiredFunctions` were added. Known-function validation remains schema-owned; a focused assertion rejects duplicates and values outside `enabledFunctions`. Legacy/test profiles normalize omission to `[]`; production profiles must declare the field explicitly.                                                                                                                       |
| No real deployment IDs in source                         | `config/profiles.json`, `.env.example`, and the ACA manifest contain environment names/placeholders only. No credential or real account/Provider ID is committed.                                                                                                                                                                                                                                                                 |
| Bot-only identifier delivery                             | The existing deployment renderer copies the three account presentation values from the existing bot ACA environment into the bot manifest. Static deployment tests prove those names are absent from all attachment, catalog, ClamAV, release-probe, periodic-assurance job manifests and the release assurance script. Existing temporary-manifest cleanup remains unchanged.                                                    |
| No new Messaging API link token                          | The explicit login entrance no longer composes or calls a LINE account-link token client. `createBinding` sends signed expected LINE UID, profile, channel, trusted display name, and canonical LINE account ID. Provider ID is used only for the startup ownership invariant because Account API intentionally rejects unknown request fields.                                                                                   |
| Bounded function authorization client                    | `authorizeFunctions` calls the Task 2 endpoint with line UID, profile, and requested known functions. It accepts only exact booleans, a requested-order subset of known functions, a canonical active account summary, sorted unique `admin`/`user` roles, and masked email. It rejects raw email, unknown/unrequested functions, unknown roles, extra identifiers/keys, malformed state combinations, and noncanonical ordering. |
| Fail-closed HTTP behavior                                | All client POSTs use manual redirect handling. 3xx and 4xx responses remain permanent; timeout/transport, 408, 429, and 5xx remain retryable under the existing error classifier.                                                                                                                                                                                                                                                 |
| Shared profile path                                      | The account client and login entrance contain no helper/main or function-specific branches. Existing main-profile entrance coverage and the new helper exact-payload regression exercise the same shared path.                                                                                                                                                                                                                    |

## TDD Evidence

### RED

Focused config/client/entrance/deployment/job tests were added before production
edits:

```text
pnpm exec vitest run \
  src/__tests__/config.test.ts \
  src/__tests__/account-admin-client.test.ts \
  src/__tests__/entrance.test.ts \
  src/__tests__/profile-config-deployment-contract.test.ts \
  src/__tests__/attachment-scan-worker-config.test.ts

FAIL: 25 tests failed on the missing accountLink/function-policy schemas,
      runtime normalization, bounded client method, trusted binding payload,
      token-free entrance, and bot-only deployment identifiers.
```

After the minimum implementation made that suite green, a separate production
declaration regression was added. It failed because a production profile could
still omit `permissionRequiredFunctions`; production-only enforcement was then
added.

### GREEN

The final focused command passed:

```text
Test Files  5 passed (5)
Tests       270 passed (270)
```

## Verification

The following gates exited zero after the final implementation:

```text
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm config:validate
pnpm build
git diff --check
```

Architecture validation checked 399 TypeScript files. The production config
validator returned only profile names, webhook paths, and provider names; it did
not print any resolved account identifiers.

All touched Prettier-supported files passed a targeted Prettier check. The
repository-wide `pnpm format:check` remains nonzero solely because six
pre-existing SDD Markdown files (`task-1-brief.md`, `task-1-report.md`,
`task-1-review.md`, `task-2-brief.md`, `task-3-brief.md`, and
`task-4-brief.md`) do not match Prettier. They were not reformatted because they
are intentional prior documentation and outside Task 4.

The proportional repository run produced:

```text
Test Files  139 passed (139)
Tests       1577 passed (1577)
```

That run excluded only `src/__tests__/kernel-local-live-runner.test.ts`. Running
the complete suite and that file alone reproduces seven pre-existing macOS
failures: `/dev/shm` is absent, so `scripts/run-kernel-local-live.sh` exits at its
memory-storage prerequisite before the fixture creates `calls.log`. The first
static test in that file still passes; Task 4 does not touch the runner, script,
or fixture. The complete attempt otherwise reported 139 passing files and 1,578
passing tests.

Routing/kernel evals were not run because this task adds client/config contracts
and removes a token dependency without changing controlled candidate, planner,
validator, result, state, or function execution behavior.

## Files Changed

- `.env.example`
- `README.md`
- `aca.containerapp.yaml`
- `config/profiles.json`
- `scripts/deploy-aca.sh`
- `src/types.ts`
- `src/config.ts`
- `src/profile-config-validation.ts`
- `src/account/account-admin-client.ts`
- `src/bootstrap/create-production-runtime.ts`
- `src/testing/create-test-app.ts`
- `src/transport/line/webhook-routes.ts`
- `src/__tests__/config.test.ts`
- `src/__tests__/account-admin-client.test.ts`
- `src/__tests__/entrance.test.ts`
- `src/__tests__/profile-config-deployment-contract.test.ts`
- `src/__tests__/attachment-scan-worker-config.test.ts`

## Handoff / Concerns

- Before any deployment, the existing bot ACA environment must be pre-provisioned
  with `LINE_HELPER_ACCOUNT_ID`, `LINE_MAIN_ACCOUNT_ID`, and
  `LINE_ACCOUNT_PROVIDER_ID`. Deployment fails before mutation if any is absent;
  bot startup/readiness fails when resolved Provider IDs differ.
- This task establishes `permissionRequiredFunctions` and the bounded Account
  API client contract. Applying that authorization to effective function access
  belongs to the later plan task and was deliberately not implemented here.
- Legacy Account Link event finalization remains for rollback-window intents;
  only new binding creation stopped issuing Messaging API link tokens.
- No production configuration, credential, account ID, Provider ID, external
  state, push, PR, merge, or deployment was performed.

## Review Round 1 Fix

### Status and scope

Addressed both Important findings in `task-4-review.md` from Task 4 commit
`f788e0551e880abffc2c68282088dfe0f4bbb9d6`.

- `BotProfileConfig` now extends the exact required `ProfileFunctionPolicy`.
  Optional omission and `[]` defaulting remain only in the raw config schema and
  loader; direct runtime, eval, tool, and test profile builders declare `[]`
  explicitly.
- `scripts/deploy-aca.sh` now reads the current bot environment and rejects a
  missing, non-string, empty, or whitespace-only account presentation value
  before `capture_known_good_state`, `mark_release_mutated`, or any Azure write.
  The later renderer check remains as defense in depth and reuses the preflight
  environment snapshot.
- No dependency, abstraction layer, background-job environment input, or
  profile-specific branch was added.

### TDD RED evidence

The runtime-type, static mutation-order, and executable fake-Azure deployment
regressions were added before production edits. The focused run failed exactly
on the reviewed boundaries:

```text
Test Files  2 failed (2)
Tests       3 failed | 91 passed (94)

- BotProfileConfig did not extend ProfileFunctionPolicy.
- required_account_presentation_env_names was absent before the snapshot/write boundary.
- the deploy fixture reached known-good capture instead of emitting the required
  ACA environment reference failure before writes.
```

After making the runtime field required, the first `pnpm typecheck` provided the
expected compiler RED for ten direct source profile builders that omitted
`permissionRequiredFunctions`. Each builder was updated explicitly with `[]`;
legacy raw config omission tests were left unchanged.

### GREEN and final verification

The three focused review regressions passed, followed by the complete relevant
deployment contract suite:

```text
Test Files  2 passed (2)
Tests       94 passed (94)
```

The proportional repository run excluding only the previously documented
macOS `/dev/shm` kernel-local-live fixture passed with the new regressions:

```text
Test Files  139 passed (139)
Tests       1580 passed (1580)
```

Additional fresh gates all exited zero:

```text
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm config:validate
pnpm build
targeted Prettier check for every touched supported file
git diff --check
```

Architecture validation again checked 399 TypeScript files. No push, PR, merge,
deployment, credential read, or production mutation was performed.

## Review Round 2 Fix

### Status and scope

Addressed the single Minor finding from the Task 4 fix-round re-review.

- Added `permissionRequiredFunctions: []` to the exact
  `satisfies BotProfileConfig` fixtures in `src/__tests__/save-resource.test.ts`
  and `src/__tests__/query-schedule.test.ts`.
- No runtime, deployment, config, application, or dependency change was made.

### RED and GREEN evidence

A direct test-source compiler command was run before edits:

```text
pnpm exec tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop \
  --types node,vitest \
  src/__tests__/save-resource.test.ts src/__tests__/query-schedule.test.ts
```

RED named `permissionRequiredFunctions` as missing from both exact profile
fixtures. After the two additions, the same compiler command no longer lists
that field as missing. The command remains nonzero because these test files have
older out-of-scope typing gaps: four other long-required profile fields and
pre-existing query-schedule active-task shape mismatches. Repository typecheck
continues to exclude `src/__tests__/**`, as documented in the review.

Focused behavior and requested repository gates passed:

```text
pnpm exec vitest run \
  src/__tests__/save-resource.test.ts \
  src/__tests__/query-schedule.test.ts

Test Files  2 passed (2)
Tests       28 passed (28)

pnpm typecheck
pnpm lint
pnpm exec prettier --check \
  src/__tests__/save-resource.test.ts \
  src/__tests__/query-schedule.test.ts
git diff --check
```

No push, PR, merge, deployment, credential read, or external mutation was
performed.

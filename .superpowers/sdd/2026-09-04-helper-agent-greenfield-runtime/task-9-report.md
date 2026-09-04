# Task 9 report

## Status

Deleted the retired LINE SDK-agent and generic turn architecture, consolidated capability metadata under `CAPABILITY_CATALOG` and `CapabilityName`, and replaced module-array registration with explicit production composition. Main remains provider-free and retains only its narrow requester/source-scoped `profile_update` state. No PostgreSQL schema, migration, or deployed legacy table changed.

## RED evidence

- Dependency fixtures initially failed to reject helper imports of `application/turn/runtime` and main imports of the helper provider runtime.
- Main/store tests initially failed because no `profile_update` lookup existed after generic pending state was removed.
- Schedule ambiguity initially had no replacement continuation proof after `pending_resolution` was removed.
- The first full suite found one stale contract-test import of deleted `agent/sdk-tools`.
- The first kernel integration run still expected the deleted SDK checkpoint case.

## Implementation

- Moved `src/functions/definitions.ts` to `src/capabilities/catalog.ts`, added `src/capabilities/names.ts`, and migrated to `CAPABILITY_NAMES` and `CapabilityName` without compatibility aliases.
- Added explicit capability composition with direct handler, postback, text-continuation, attachment, and admin assignments. Removed the module array, registry factories, and capability module factories.
- Removed `pending_function`, `pending_resolution`, and `pending_capability_resolution` from memory/Redis session types, lookups, indexes, and Lua paths. Main own-profile updates use one plain `profile_update` record that is main-only, requester/source scoped, and excluded from interactive diagnostics.
- Moved schedule matching to `src/schedules/resolution.ts`, resource observation to `src/agent/resource-memory.ts`, `/memories` handling to `src/transport/line/memory-commands.ts`, and completion/product observation to `src/observability/function-completion.ts`.
- Kept schedule ambiguity as bounded evidence plus quick replies. The next requester turn uses the scoped helper checkpoint and performs a fresh authorized schedule tool call with the selected domain.
- Made attachment intake the sole executable owner by moving remaining prompt/session utilities into `src/transport/line/attachment-intake.ts` and deleting compatibility re-exports.
- Removed the dead SearXNG summarizer type, implementation, production construction, handler option, and tests. Consented research remains owned by the Task 8 helper tools.
- Added dependency rules for every retired module and for main-to-helper provider coupling. Matcher failures retain bounded support replies.
- Deleted the retired SDK, turn runtime, stages, generic pending helpers, module registry, and architecture-only tests. Requester isolation, authorization recheck, attachment failure handling, replay, and ambiguity continuation remain under active boundary tests.

## Retired-symbol proof

The exact Task 9 command returned no matches:

```text
rg -n "createSdkAgent|createSdkAgentTurnRuntime|createAgentTurnRuntime|allowRouting|turnStage|pending_function|pending_resolution|pending_capability_resolution|FUNCTION_MODULES|createFunctionRegistries" src config
```

The only test-fixture references to retired file names are dependency-rule inputs:

```text
src/__tests__/dependency-rules.test.ts:21  src/application/turn/runtime.ts
src/__tests__/dependency-rules.test.ts:55  src/agent/sdk-runtime.ts
src/__tests__/dependency-rules.test.ts:134 src/application/turn/runtime.ts
```

## GREEN evidence

- Focused replacement suite: 10 files passed; 87 tests passed.
- Broader entrance/capability/store suite: 10 files passed; 283 tests passed, 1 skipped.
- Fresh full `pnpm test`: 127 files passed; 1,472 tests passed, 39 skipped; 133.93 seconds.
- `pnpm eval:agent`, `pnpm eval:sdk-agent`, and `pnpm eval:kernel`: PASS, offline fake tool-calling model, 31 corpus cases each.
- `pnpm eval:admin`: PASS, 14 cases.
- `pnpm eval:retrieval-product`: PASS, 2 tests.
- `pnpm eval:kernel:integration`: PASS, 21 cases and 16 integration tests.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`: PASS.
- `pnpm architecture:check`: PASS, 348 TypeScript files checked.

## Deletion evidence

Task 9 against `8733fe8`: 1,741 insertions, 6,734 deletions, net -4,993 lines.

Whole branch against `origin/main`: 12,054 insertions, 7,057 deletions, net +4,997 lines. This comparison includes Tasks 1-9.

## Self-review

- Helper is the sole semantic provider runtime. Main imports no helper/provider composition and keeps Weekly Paper plus own-profile behavior deterministic.
- Generic pending dispatch, router stages, and compatibility execution are absent. Numeric selection, postback, action review, attachment/upload intent, external import, current authorization, audit, resource observation, and result replay remain active.
- Action-review records and diagnostics do not contain main profile names. The narrow `profile_update` state is excluded from generic interactive lookup.
- No PostgreSQL schema or migration changed; deployed legacy tables remain for rollback.

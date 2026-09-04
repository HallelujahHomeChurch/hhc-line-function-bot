# SDD ledger — plan: docs/superpowers/plans/2026-09-04-helper-agent-greenfield-runtime.md

Base: `9110b9e2784cfb39ddbf57fdbb0a8d63b65747f7`
Branch: `codex/helper-agent-greenfield-runtime`
Spec: `docs/superpowers/specs/2026-09-04-helper-agent-greenfield-runtime-design.md`

## Preflight task consistency

| Task | Internal check                                                                                                                                         | Finding                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1    | Tests create and consume the proposed profile runtime contract; listed files match the commit step.                                                    | Clean.                                                                            |
| 2    | State and budget tests precede their implementations; PostgreSQL integration is included before commit.                                                | Clean.                                                                            |
| 3    | Typed projection and policy gateway tests cover authorization and bounded model exposure.                                                              | Clean.                                                                            |
| 4    | Read-tool names map to existing capability schemas; latest schedule behavior is server-owned.                                                          | Clean.                                                                            |
| 5    | Middleware thresholds, output cap, state scope, error behavior, construction, and focused tests agree.                                                 | Clean.                                                                            |
| 6    | Review tests cover no-argument postbacks, owner-safe atomic consume, authorization, revision, expiry, and replay; action execution stays server-owned. | Clean after the approved plan correction that validates ownership before consume. |
| 7    | Main parity tests and transport cutover use one dispatcher; old continuation is removed from production composition in the same task.                  | Clean.                                                                            |
| 8    | External research remains consented and bounded; binary attachment intake remains deterministic and Asset/outbox controlled.                           | Clean.                                                                            |
| 9    | Every listed deletion follows import removal or utility relocation; architecture rules and replacement tests gate the deletion.                        | Clean.                                                                            |
| 10   | Offline/live eval cases cover the spec acceptance matrix and documentation describes the final graph.                                                  | Clean.                                                                            |
| 11   | Full gates, live acceptance, deletion evidence, PR creation, and CI wait are ordered; merge remains outside this task.                                 | Clean.                                                                            |

## Preflight shared files and interfaces

| Tasks    | Producer/consumer or shared surface                                                  | Finding                                                                     |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1 -> 5   | `ProfileRuntime` / `ProfileTurnInput` consumed by helper runtime.                    | Compatible.                                                                 |
| 1 -> 7   | Dispatcher contract, `create-test-app.ts`, main parity tests, and entrance tests.    | Task 7 replaces the temporary seam with the sole production map.            |
| 1 -> 9   | `FunctionName` initially comes from `types.ts`, then moves with the catalog.         | Task 9 must update the Task 1 import; no compatibility alias should remain. |
| 2 -> 3   | `takeToolCall` is consumed by the policy gateway.                                    | Single authoritative tool counter.                                          |
| 2 -> 5   | Thread state and transport-level model budget are consumed by helper runtime.        | Same budget wraps response and summary models.                              |
| 2 -> 8   | Research consent selects the 6/6 run mode.                                           | Consent remains requester/thread scoped.                                    |
| 2 -> 11  | PostgreSQL integration runner and state gates are rerun in final verification.       | Compatible.                                                                 |
| 3 -> 4   | Gateway and typed result projection are consumed by read tools.                      | Separate source authority preserved.                                        |
| 3 -> 6   | Gateway/policy boundary is consumed by write proposal tools.                         | Review never replaces live authorization.                                   |
| 3 -> 9   | `FunctionExecutionResult` and capability names are touched by catalog consolidation. | Preserve result shape; update imports only.                                 |
| 4 -> 5   | Dynamic read tools are supplied to the one helper agent.                             | No selector model or regex router added.                                    |
| 4 -> 10  | Latest/authority behavior becomes deterministic eval cases.                          | Compatible.                                                                 |
| 5 -> 6   | Helper agent/checkpoint state carries LangGraph HITL interrupts and resumes.         | Review record stores only hash and pointer.                                 |
| 5 -> 7   | Helper runtime is connected by the production profile dispatcher.                    | No dual dispatch.                                                           |
| 5 -> 8   | `helper-agent/runtime.ts` gains consented research tools after cutover.              | The run budget remains shared.                                              |
| 5 -> 9   | Production composition, config, helper tests, and retired SDK files converge.        | Task 9 deletes old runtime only after new runtime is live in composition.   |
| 5 -> 10  | Context/error/provider behavior becomes offline and live eval coverage.              | Compatible.                                                                 |
| 6 -> 7   | Action executor/review state is shared by helper and deterministic main.             | Main still invokes no provider.                                             |
| 6 -> 9   | Session store gains action review, then obsolete pending variants are removed.       | Keep action review and required selection/attachment variants.              |
| 6 -> 10  | HITL approval/revision/replay cases become eval boundaries.                          | Compatible.                                                                 |
| 7 -> 8   | `webhook-routes.ts` and post-dispatch exceptional workflows are refined.             | Task 8 extracts attachment intake without restoring a registry.             |
| 7 -> 9   | `create-production-runtime.ts` is simplified again after legacy imports reach zero.  | Compatible.                                                                 |
| 7 -> 10  | Main provider-free behavior and final request flow are documented/evaluated.         | Compatible.                                                                 |
| 8 -> 9   | Research behavior moves out of `sdk-tools.ts` before that file is deleted.           | No lost safety guardrails.                                                  |
| 8 -> 10  | Research injection and attachment lifecycle become eval/docs coverage.               | Compatible.                                                                 |
| 9 -> 10  | Final catalog/import graph and deleted architecture determine documentation.         | Documentation follows code.                                                 |
| 9 -> 11  | Deletion/import evidence is measured again in final verification.                    | Compatible.                                                                 |
| 10 -> 11 | Final eval commands and live usage report are consumed as release evidence.          | Compatible.                                                                 |

Preflight result: no unresolved task conflict. No ruling required.

Task 1: dispatched implementer `/root/task1_implementer` from base `bb5db75`.
Task 1: Ruling: preserve current main group behavior (`ignored: group_blocked` with no LINE reply) because the approved spec requires black-box parity and the plan's sample reply assertion contradicts the observed contract — cost if wrong: main group users continue seeing silence instead of a new explanatory reply.
Task 1: fix round 1/5 (2 addressed, 0 open — provider isolation spies; event-scoped blocked-group no-reply assertion; commits `7d5d4be..d42039b`).
Task 1: complete (commits `bb5db75..d42039b`, review clean).
Task 2: dispatched implementer `/root/task2_implementer` from base `d42039b`.
Task 2: Ruling: extend `allowExternalSheetMusic` with the current `LineSource` despite the plan's two-argument sketch, because the approved spec requires 30-minute direct and 15-minute group/room lifetime even when metadata is first created by consent — cost if wrong: one caller/signature migration now instead of retaining the smaller interface.
Task 2: minor (deferred): make the fifth budget request concurrent so the regression test directly exercises simultaneous over-budget calls.
Task 2: minor (deferred): PostgreSQL reset integration should assert deletion from `helper_agent_threads` as well as checkpoint deletion.
Task 2: fix round 1/5 (3 addressed, 0 open — source-aware consent TTL; committed failure cleanup; consent mutation thread lock; commits `8c6fc18..48c9d16`).
Task 2: complete (commits `d42039b..48c9d16`, review clean; 2 deferred minors).
Task 2: reopened after controller PG audit found the new state created `helper_agent_threads`, conflicting with the repository contract to retain the existing `agent_sdk_threads` TTL index.
Task 2: Ruling: reuse the compatible deployed `agent_sdk_threads` table and do not add a new helper metadata table or migration — this satisfies the user request and current AGENTS.md; cost if wrong: the cutover adopts existing short-lived metadata rows instead of starting with an empty namespace.
Task 2: fix round 2/5 (1 addressed, 0 open — reused `agent_sdk_threads`; no new table/migration/dual write; commits `746b55a..dd91fa6`).
Task 2: complete after PG audit (commits `d42039b..dd91fa6`, review clean; 2 deferred minors).
Task 3: dispatched implementer `/root/task3_implementer` from base `48c9d16`.
Task 3: Ruling: a missing authorizer may pass only profile-global unrestricted reads; any `permissionRequiredFunctions` entry fails closed, overriding the plan sample's broad optional-authorizer behavior because Account authorization is a binding server-owned boundary — cost if wrong: a misconfigured restricted read is denied instead of being available.
Task 3: Ruling: require `sourceType` on every gateway call rather than defaulting to `official`, because source authority must be explicit and separate — cost if wrong: every Task 4 tool adapter must supply one additional literal argument.
Task 3: minor (deferred): strengthen the budget test to prove four resolved attempts and fifth failure, with a separate denied-path assertion.
Task 3: minor (deferred): add a valid Zod default/transform regression case.
Task 3: minor (deferred): the projection recursion depth guard resets through `safeRecord`; fix if the Important sanitization change does not naturally replace it.
Task 3: fix round 1/5 (4 addressed, 0 open — restricted-read fail closed; identifier/kind sanitization; typed dependency failures; explicit source authority; commits `b5e0513..7b31904`).
Task 3: complete (commits `48c9d16..7b31904`, review clean; 3 deferred minors).
Task 4 carry-forward: approved knowledge, saved-note, and Wikipedia model evidence must move from deprecated `responseData` into bounded `agentResult.replyData` before the new gateway exposes it.
Task 4: dispatched implementer `/root/task4_implementer` from base `7b31904`.
Task 4: Ruling: require `source.userId` for direct and group helper tool construction, because requester-visible memory and authorization cannot safely use the legacy synthetic `unknown` scope — cost if wrong: malformed direct LINE events are ignored instead of receiving a helper answer.
Task 4: minor (deferred): add a tool-level schedule-versus-saved-note test; the current domain fixture cannot affect `query_schedule` directly.
Task 4: fix round 1/5 (2 addressed, 0 open — bounded schedule-list evidence; anonymous direct source rejection; commits `cd5b62b..746b55a`).
Task 4: complete (commits `7b31904..746b55a`, review clean; 1 deferred minor).
Task 5: Ruling: keep the legacy `agentRuntime.taskFrameSeconds` config only until the Task 7 cutover/Task 9 deletion, and do not add replacement TTL knobs because Task 2 already owns fixed validated 30m/15m constants — cost if wrong: deployments cannot tune these TTLs without a code change.
Task 5: dispatched implementer `/root/task5_implementer` from base `dd91fa6`.
Task 5: Ruling: resolve the complete effective allowed function set before `state.run`, and include only that set in tools, prompt, and `policyKey`; retain per-call gateway authorization as the second check — cost if wrong: each turn makes one batched authorization lookup even when no restricted function will be called.
Task 5: minor (deferred): staged production startup runs both legacy and helper cleanup once against the shared `agent_sdk_threads` table; remove the duplicate at cutover.
Task 5: fix round 1/5 (1 addressed, 1 open — LastErrorStore failure is isolated; production authorizer still memoizes preflight and tool-time checks; commits `a5e2830..3ccb4ed`).
Task 5: Ruling: keep `state()` memoized for one-event account presentation, but make `allowedFunctions()` perform a fresh Account authorization request for every protected-function check; unrestricted local reads remain local — cost if wrong: a multi-tool turn can make up to one Account authorization request per protected tool call in addition to preflight.
Task 5: fix round 2/5 (1 addressed, 0 open — fresh production protected-function authorization; commits `3ccb4ed..214be55`).
Task 5: complete (commits `dd91fa6..214be55`, review clean; 1 deferred minor).
Task 6: dispatched implementer `/root/task6_implementer` from base `214be55`.
Task 6: Ruling: implement free-text revision with the installed LangChain HITL `reject`/message semantics instead of adding a non-existent `respond` decision; the consumed original can never execute and a replacement proposal must receive a new review identity/hash — cost if wrong: revision appears as a rejected proposal in framework state rather than a distinct decision enum.
Task 6: review round 1 found 3 Critical, 3 Important, and 2 Minor issues; fix round 1/5 opened for scoped text lookup, authoritative approval, durable result recovery, normalized hashing, stranded-interrupt cleanup, lifecycle events, atomic Redis fail-closed behavior, and shared exact-source comparison.
Task 6: Ruling: reuse the existing requester-scoped `AgentJobStore` as the durable result pointer created with the review and completed before LINE reply; replay reads the persisted result instead of re-executing — cost if wrong: each write preview creates one short-lived pending job that may expire unused after cancellation.
Task 6: fix round 1/5 (7 addressed, 2 open — scoped discovery, authoritative approval, normalized hashing, lifecycle events, Redis fail-closed, shared source comparison, and bounded result recovery; PostgreSQL pool saturation and terminal job immutability remain; commits `74d0b01..771ffa0`).
Task 6: Ruling: use a dedicated PostgreSQL advisory-lock pool for helper thread serialization while the existing data pool owns LangGraph checkpoints and metadata; no schema change — cost if wrong: one additional small PostgreSQL connection pool per helper service instance.
Task 6: fix round 2/5 (2 addressed, 0 open — dedicated advisory-lock pool and immutable terminal job state; commits `771ffa0..5b68ab3`).
Task 6: complete (commits `214be55..5b68ab3`, review clean; transport wiring remains Task 7).
Task 7: dispatched implementer `/root/task7_implementer` from base `5b68ab3`.
Task 7: Ruling: reuse the existing `createProfileRuntimeDispatcher` in `src/runtime/profile-runtime.ts` instead of creating a duplicate transport dispatcher file — cost if wrong: the dispatcher remains in the runtime layer rather than the plan's suggested transport path.
Task 7: Ruling: keep main update arguments in one linked protected pending record while `ActionReviewSession` stores only its opaque pointer and hash; exclude that record from interactive lookup so there is exactly one user workflow — cost if wrong: main temporarily retains one narrow pending-function storage shape until Task 9 instead of putting arguments in a new store.
Task 7: Ruling: let an exact owner-scoped pending action review bypass the group wake/conversation-window gate, while a different requester remains ignored — cost if wrong: a review owner can finish or revise an already-started write after the short group conversation window closes.
Task 7: Ruling: expose a minimal `freshExecution` review outcome to the transport so a fresh commit receives completion/audit once and durable replay receives none — cost if wrong: one internal envelope is added to the profile review contract instead of inferring freshness from the public function result.
Task 7: complete (production profile dispatcher cutover; main provider-free runtime; helper locked review resume/replay; no PostgreSQL schema change; full suite and required gates green; physical legacy deletion remains Task 9).
Task 7: review round 1 found 2 Important continuation/completion issues and 1 Important main workflow-switch issue; fix round 1/5 restores all `resolution`/`attachment` handlers through the existing matcher and clears stale main update state before explicit Weekly Paper.
Task 7: fix round 1/5 complete (3 addressed, 0 open — deterministic continuation coverage, completion/resource-memory consequences, and main workflow switch; no PostgreSQL schema/migration change).

Task 7: review round 2 found 2 Important issues and requested one test extension: pending-resolution dynamic authorization, intro/help precedence over broad continuations, and main cross-scope result-job isolation.
Task 7: Ruling: preserve `小哈你好` as helper SDK conversation/small-talk; use a true `小哈` intro regression because only existing intro/help patterns precede deterministic continuation — cost if wrong: a true greeting still uses the SDK agent when no intro trigger matches, preserving the approved conversation contract.
Task 7: fix round 2/5 complete (2 Important findings and 1 test extension addressed; restricted pending resolutions reauthorize and fail closed, intro/help preserves pending state, main cleanup settles only the owning job; no PostgreSQL schema/migration change).
Task 8: Ruling: make `src/transport/line/attachment-intake.ts` the sole executable attachment owner; compatibility files may re-export symbols only, and group admission may inspect exact requester-scoped state without executing handlers — cost if wrong: Task 9 must update a small set of direct imports rather than retaining the generic attachment stage.
Task 8: Ruling: atomically consume external-search consent before generic continuations and enter only that helper requester thread's existing 6/6 research mode; remove the legacy summarizer execution branch while retaining internal not-found consent creation — cost if wrong: direct legacy handler tests can no longer perform external research outside helper runtime.
Task 8: complete (commit `ee43bfb`; requester-consented opaque-ref sheet research, bounded public-page reading, direct-file candidate review, one-owner attachment intake, no schema/migration change; full suite and required offline/integration gates green; physical compatibility and retired client deletion remains Task 9).
Task 8: review round 1 found 4 Important issues and one cancellation UX gap: consent TOCTOU across the thread lock, unbounded research results, premature page-inspection release, unhandled text attachment failures, and pending-consent cancellation.
Task 8: Ruling: pass research permission as a post-cleanup snapshot from the existing helper state lock rather than calling a second consent API inside the callback — cost if wrong: state run callbacks receive one small read-only field until Task 9 removes the legacy state surface.
Task 8: fix round 1/5 complete (commit `343c5b5`; 5 addressed, 0 open — locked consent snapshot, 2,000-character research result cap, page-read guard, bounded attachment failures, and exact cancellation; no PostgreSQL schema/migration change; dead summarizer construction remains Task 9).
Task 8: review round 2 found 3 Important issues: unlocked/unrefreshed in-memory consent, split post-lock observation times, and concurrent page-read I/O.
Task 8: fix round 2/5 complete (commit `8733fe8`; same thread lock and idle refresh for memory consent, one run observation instant in memory/PostgreSQL, serialized page inspection; no PostgreSQL schema/migration change; all required gates green).
Task 9: Ruling: keep one plain main-only `profile_update` session for protected slot/review parity; it is noninteractive outside main runtime, requester/source scoped, and excluded from ActionReviewSession/diagnostic plaintext — cost if wrong: main retains one narrow state record instead of storing profile names in the generic review record.
Task 9: Ruling: preserve schedule ambiguity through the scoped helper checkpoint and a fresh authorized tool call rather than retaining generic `pending_resolution` dispatch — cost if wrong: the model performs one additional bounded tool call after the requester selects a domain.
Task 9: complete (retired SDK/turn architecture, generic sessions, factory-array registration, summarizer composition, and attachment compatibility execution deleted; canonical `CAPABILITY_CATALOG`/`CapabilityName`; no PostgreSQL schema/migration change; exact retired-symbol search, full suite, offline evals, and kernel integration green; Task 9 net -4,993 lines).

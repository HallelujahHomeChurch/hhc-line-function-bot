# LINE conversation continuity

Scope: the existing helper runtime, requester checkpoint, quote index, sessions,
jobs and signed webhook. Keep the deterministic main runtime provider-free.
No merge, deployment, live DeepSeek or real LINE device calls are authorized.
The user explicitly authorized the second consultant through the official agy CLI.

## Advisors

- Codex: completed independent read-only review of continuity, isolation,
  delivery projection, segmented messages and fresh evidence.
- Gemini: completed read-only through official `agy` plan mode and sandbox,
  model requested `gemini-4-argon-medium`, CLI status `SUCCESS` (47 seconds).
  Input contained public source excerpts at `86242df` and synthetic scenarios.
  No repository history, credentials or real conversation data were supplied.
- Exactly two seats completed. The local Gemini adapter is enabled and validated
  under the user's explicit authorization. No proxy or credential extraction.

## Acceptance

- [x] A same-requester supplement received before the first answer is accepted;
      simultaneous requesters never share their checkpoint or approvals.
- [x] Text, selection, confirmation and delivered results use one generation.
- [x] The checkpoint and quote receipt describe the actual safe delivered answer.
- [x] More than 64 continuous messages do not clear an active conversation;
      reset and withdrawal still invalidate all dependent results.
- [x] A public group result can be explicitly quoted by another requester for a
      newly authorized read, without private history, drafts or credentials.
- [x] Old tool evidence is historical; current factual answers require current
      successful evidence and dependency failures cannot become false success.
- [x] Scoped draft/job/attachment/media state is readable without a model guessing
      completion; unknown external outcomes remain unknown.
- [x] Expiry and reset are explicit lifecycle events; no expired authority or
      withdrawn content is revived to make continuity appear seamless.
- [x] Ordinary conversation, existing approvals, 30/60-media intake and provider-
      free main behavior remain compatible.
- [x] Execute focused scenarios, full tests, offline eval and real Redis/PostgreSQL
      gates; record failures and retests. Require green PR CI before handoff.

Use existing boundaries. Do not add a second agent, generic task engine or whole-
group transcript. Group sharing contains only scoped safe public read references.

## Decisions and consultant findings

Both consultants identified missing postback generation context, generated-versus-
delivered history drift, the 64-message generation reset, and old tool evidence
being mistaken for current facts. These are fixed in the existing runtime/store.

- Admission opens the requester continuation window before the first answer.
  Per-event jobs and the existing same-thread lock process accepted messages
  sequentially. There is no debounce: multiple short inputs may receive multiple
  replies. Unaddressed group traffic is not ingested.
- Accepted LINE receipts replace pending model replies with safe delivered text.
  Preview history contains only a pending status, never approval content. Index or
  checkpoint write failure after acceptance never retries the LINE send. Receipt
  checkpoint synchronization is asynchronous so the running agent thread lock
  cannot delay an accepted waiting reply or defeat the inline budget.
- A normalized dependency table retains directed ownership/withdrawal edges while quote tokens stay
  bounded. Gemini's FIFO suggestion was rejected because it loses old withdrawal
  dependencies. Reset/withdrawal rotate generations and fence stale callbacks.
- Another group requester may quote a server-produced unrestricted public read
  locator. The current requester runs that capability again with fresh policy,
  budget and authorization. They never receive the original requester checkpoint,
  saved notes, approval, URLs, draft or delivered answer body.
- Historical tool payloads are invalidated before a later turn. Formal capability
  questions without current evidence fail closed; failures/not-found are rendered
  from current domain results. Ordinary conversation still uses the model.
- `get_conversation_state` reads scoped current draft, attachment and recent job
  status. Media counts require fresh binding and Account collection ACL, contain
  no identifiers, and cover only the returned fifteen-minute interval.
- Redis continuation and recent-job indexing use atomic Lua operations. Repeated
  unsend retries affect only their own pending clear, not unrelated requesters.
- Checkpoint policy/TTL resets are explicit in model context. Idle retention stays
  fifteen minutes in groups and thirty minutes in direct chat. No expired approval
  or withdrawn content is recovered for apparent continuity.

Gemini's possible missing post-task lifecycle check was disproved by reading the
full `guardedTask`; the existing final generation check is retained.

## Rollout and limitations

Migration is additive (`line_quote_dependencies`, `cleared_by`, `public_reference`)
and seeds known existing lineage. The helper contract advances to v6, deliberately
invalidating old policy state. No unrelated API, Account, Admin or Presenter change
is required. The primary checkout is untouched.

These guards do not prove zero semantic hallucinations or exactly-once external
LINE delivery. Native quote UX, real model selection and delivery timing still need
an authorized device/provider acceptance run after the PR. CI, merge, deployment
and device acceptance are separate gates. Keep the worktree until authorized
release and acceptance are complete.

## Verification

- Continuity plus receipt/quote boundary: 19 tests pass, including accepted receipt
  replacement/redaction and a pending checkpoint lock that must not delay delivery.
- Scoped state/media and lifecycle tests pass, including fresh ACL denial and
  concurrent binding change. Current status includes cancelled/withdrawn counts.
- Real PostgreSQL/Redis suites: 27 tests pass; includes 100-message continuity,
  old withdrawal after text expiry, directed dependent invalidation, concurrent
  requester windows and scoped recent jobs.
- Docker-owned kernel integration CLI: 24 matrix cases pass, including restart,
  namespace cleanup and container cleanup; its 27 contract tests also pass.
- Offline agent evaluator: all 19 cases pass; retrieval product: 2 tests pass.
- Local full suite: 147 files, 1,767 pass and 5 existing release-shell timeouts
  (5s/15s limits under concurrent local load). All five failures pass in an isolated
  eight-case retest with a 30s default; no product/test code or asserted behavior
  was relaxed. One further delivery-budget regression was added and passes.
- Typecheck, lint, build, formatting, architecture (388 TS files), profile config,
  OpenAPI publication and five OpenAPI contract cases pass. Local shell/contract
  subprocesses use the existing corepack pnpm shim.
- Required PR CI is the authoritative final default-timeout suite check:
  [Bot PR #109 checks](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/109/checks).
  No merge, deployment, live DeepSeek or real LINE acceptance is included.

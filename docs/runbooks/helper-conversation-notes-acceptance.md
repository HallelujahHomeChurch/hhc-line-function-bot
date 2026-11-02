# Helper conversation and notes acceptance (P0–P2)

Baseline: `08832350d8cd79e849dc658bd37b6f4df6a0a73e`. This change is pre-release:
offline contracts are not proof of model quality, real token savings or LINE delivery.
No live model requests or deployment are part of this implementation.

## Fixed scope and limits

Reuse the one helper agent; main remains provider-free. No new routing model,
web search, output-budget increase, long-term retention option, generic pagination,
new database, content-history service or billing system. Current model output is
800 tokens with four model/four tool calls per turn. Existing summary/retry limits apply.

Notes retain the existing 30-day expiry. The **whole rendered preview**, including
metadata, must fit `fitsCompleteWritePreview`: at most 24,000 UTF-16 units AND exact
round-trip through the existing LINE splitter (five messages of 5,000 units).
This is not a promise of 24,000 units of body text. Oversized operations are rejected.

Search excerpts remain 320 characters each / 2,000 total. Full read renders authorized
server content directly; the model does not reconstruct it. A unique text replacement
preserves the rest of the original, including URLs and text beyond the excerpt.
A server-bound record ID and expected revision bind the reviewed mutation. Updating
clears obsolete query text and replaces or clears embedding atomically; backfill uses
revision checks. Content and expiry are never reconstructed from conversation summaries.

`/forget-memory` now previews through the same action executor and one-shot review;
without a review runtime it fails closed. Account permission and ownership/admin checks
apply at preview and confirmation. Group-visible previews are not private messages.
Use direct chat for private content. Reset, withdrawal, stale policy and review expiry
retain their existing behavior. Revision conflicts require a new preview.

## Twelve fixed journeys

| ID                | Input / continuation                                 | Required outcome                                                    | Offline coverage                                   |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| C1 Explain        | Explain time management; use a student example       | Uses the new example without asking the original topic again        | helper-conversation-journeys                       |
| C2 Compare        | A is cheaper, B is faster; prioritize time           | Uses supplied facts, no lookup/save                                 | helper-conversation-journeys                       |
| C3 Plan/group     | Six people, indoors, one hour; shorten to 30 minutes | Retains group/requester and six-person constraint                   | helper-conversation-journeys + quoted-continuation |
| C4 Write          | Saturday-afternoon notice; make it warmer            | Retains time and topic without saving                               | helper-conversation-journeys                       |
| C5 Translate      | Translate a supplied sentence; more formal           | Revises same sentence, no tool                                      | helper-conversation-journeys                       |
| C6 Organize/group | Food, setup, reception; reception first              | Reorders supplied items in same admitted context                    | helper-conversation-journeys + quoted-continuation |
| N1 Create         | Save a travel idea; confirm                          | No write before confirmation; retrievable next day                  | helper-notes-lifecycle                             |
| N2 List           | List saved notes                                     | Authorized names only, no embedding call                            | helper-notes-lifecycle                             |
| N3 Full read      | Read linked note longer than 320 chars               | Exact server-rendered content, no extra summarizer                  | helper-notes-lifecycle                             |
| N4 Edit           | Replace one phrase after character 320               | Exact unchanged remainder and original expiry                       | helper-notes-lifecycle                             |
| N5 Conflict       | Another edit wins before approval                    | Stale edit/delete rejected                                          | helper-notes-lifecycle + real PostgreSQL matrix    |
| N6 Delete         | `/forget-memory`; revoke/reconfirm/replay            | Explicit preview, fresh permission, one deletion, no model approval | helper-notes-lifecycle                             |

Fake-model C1–C6 tests prove context retention, two calls for two turns, no fixed
classifier/tool call and no draft creation. They **do not score the generated prose**.
Existing signed-webhook tests cover ambient silence, quoted continuation, wrong
requester, buttons and result handoff. Separate safety tests cover ambiguous edits,
foreign owner/source, stale embedding, oversized preview and expired confirmation.

Three concrete acceptance pain points, selected from the requested scope (to confirm
with the user at device acceptance): (1) unnecessary restatement during a follow-up;
(2) incomplete linked/long-note readback; (3) inability to safely update/delete the same
saved note. Existing code already offers general conversation: do not claim every
baseline journey failed. P0 records the old evaluator separately before this change.

## Authorized live/device comparison, still pending

Use the twelve synthetic journeys on baseline and candidate with the same model,
settings, inputs and output-length requirements. Do not collect real group transcripts.
Score each journey against the table: all required parts completed, no invented facts
or writes, no redundant question. Require at least 11/12, no regression of formerly
passing cases, all safety cases passing, and a clear improvement on each of the three
pain points (fewer needless follow-ups or a previously failing task now completed).

Record per journey model/tool calls, input/output/cache tokens, summary/embedding/retry
usage, total duration, delivery outcome and cost using the applicable provider rates.
Report total tokens including failed attempts, median tokens per successful task, max
and p50/p95 latency. A >10% median token or non-search p95 regression needs explicit
review; never hide failures by reporting only successful calls. Fake tokens of zero
mean unavailable usage, not free production execution. Actual paid cost is not inferred
from stubs. No new persistent metrics system is required.

P1 and P2 each need separately authorized release and LINE acceptance before wider
activation. Check group quote-to-revision, confirmation buttons, long-text delivery,
context expiry and four-second result handoff on a device. Do not use a signed empty
webhook probe as a substitute. Public search (P3) stays deferred.

## Migration and rollback

The migration adds revision (default 1), nullable updated_at and updated_by without
changing existing expiry or content. Both stores compare expected revision at mutation;
PostgreSQL concurrency and stale embedding are exercised in the integration matrix.
No index/lock tuning is included without representative query-plan/pool evidence.
Production query-plan and lock-pressure measurements remain pending; these are not
needed to claim a database performance improvement because none is claimed here.

Old binaries can read the additive columns, but **cannot preserve the new revision
contract while writing**. Drain writers and invalidate pending approvals before any
rollback; do not mix old and new mutation writers. Do not drop columns or replay
unknown effects after Redis loss. Follow `redis-loss-recovery.md` for recovery.

## Local verification record

Baseline offline evaluator: 19/19 cases, 34 fake model calls and 20 fake tool calls.
Candidate preserves those totals; token fields are unavailable in these stubs.
The six new conversation probes use one fake model call per turn and zero tools.
See the PR for exact commands/results and CI. Real provider quality/cost, production
load and LINE acceptance remain pending; merge triggers production and is not authorized.

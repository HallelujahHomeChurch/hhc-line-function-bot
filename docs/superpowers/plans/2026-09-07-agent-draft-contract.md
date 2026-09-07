# Agent draft contract implementation

Approved design: agent organizes user-provided information and continues natural correction; server validates, previews, authorizes and commits. Retain the single SDK agent and existing bounded budgets. No semantic router, phrase exceptions or new framework.

- [x] Structured schedule drafts: strict bounded entries alongside preserved original text; registry-derived legal domain choices; full preview and validation, including mixed copied content and multiple months.
- [x] Recoverable proposal results: release only unsuccessful preparation reservations; retain one successful mutation per turn and research exclusion. Report real pending outcomes in sanitized telemetry.
- [x] Atomic schedule publication: one confirmation replaces all included months atomically, preserving other months and canonical uniqueness.
- [x] Draft edits: preserve exact original and structured data; prevent an old structured entry from silently overriding edited text.
- [x] Cross-function audit: inspect read arguments/evidence, text memory, attachments, research and review contracts. Fix shared defects in owning boundaries; retain narrow main behavior.
- [x] Acceptance: failing regressions then targeted/full tests, offline evaluations and bounded real DeepSeek journey with complete production domain registry. Assert zero writes before confirmation and exact cross-source readback after one confirmation.
- [ ] Delivery: PR, required CI, authorized merge/release, provider-free production assurance; remove only this task worktree and update clean primary main with ff-only.

Implementation boundaries: root owns function schemas, schedule domain handler, tool schema projections and evaluator. Proposal recovery subtask owns helper runtime and its tests. Atomic storage subtask owns memory stores and tests. These share only the existing typed handler contract and a new `saveScheduleMemories(inputs)` atomic store method. No additional provider calls in CI and no production test data writes.

Ruling: support a multi-month pasted schedule through the existing canonical monthly records and an atomic batch store call. Asking users to manually split the message would preserve the reported usability failure. No schema migration expected; storage implementations must verify this.

## Verification and audit record

- Shared read gateway already rechecks authority and bounds evidence; retained. Schedule read schema now advertises current domain choices without changing raw multi-domain clarification semantics.
- Text-memory proposals share the recovered preparation reservation. Attachment opt-in/purpose/title outcomes now report incomplete preparation, and empty draft reads cannot create a second preview. Research isolation and four-second result handoff remain covered by existing regression tests.
- Structured edits can target one date and typed field without rebuilding other entries. Invalid edit approval revocation uses the same write-lane guard. Review found and resolved an unregistered custom-domain fallback.
- PostgreSQL batch publication uses one SQL statement and the existing active-month unique index. Conflicting writers fail atomically. No schema migration. SQL DATE readback now preserves its calendar date in Asia/Taipei.
- Offline agent 17/17, retrieval 2/2; real Redis/PostgreSQL matrix 21/21 plus 20 contract tests (including batch rollback and concurrency). The new store suite runs in the pgvector integration gate, not the ordinary CI PostgreSQL service.
- Real DeepSeek final mixed-text, complete-domain-registry, two-month preview/question/revision/confirmation/cross-group-readback passed twice: 7 model calls each, 25,639 and 25,590 total tokens. Confirmation used no model calls; no persistence before approval. These are synthetic in-memory product journeys, not actual LINE delivery acceptance.
- Three preceding live diagnostics exposed extraction-contract gaps (parenthetical note organization and operation selection); all five runs total 26 requests and 94,041 tokens. No production user-data writes or automatic provider retries.
- Remaining limits: probabilistic model extraction still requires a full user preview; a conflicting database write needs a fresh proposal. This is not a stability-rate claim or a replacement for post-release human LINE acceptance.

Local full suite: 140 files, 1,566 passed and 40 environment skips before relocating the three store tests into the explicit real-dependency gate. Formatting, typecheck, lint, build and architecture checks passed. Independent review has no remaining blockers.

# Bounded group history (phase B)

This feature is disabled unless `GROUP_HISTORY_CONFIG_PATH` points to a validated
local configuration with `enabled: true`. The committed example is disabled and
contains no group identities. No migration, production secret or collection has
been applied by this change. Phase A must be deployed and accepted before B is
activated. Deploy/review these as separate changes; never undo A to disable B.

## Policy and limits

The confirmed product policy is same-group sharing, including members who join
later. Profile and group are injected by the server. The model cannot choose a
group or requester; direct messages and other groups cannot retrieve this data.
Opt-out IDs exclude ingestion, not the member's right to read shared group data.
Private drafts, approvals and checkpoints remain requester-private.

Start with 90 days. The sample logical capacities (10,000 messages/10 MB per group,
100,000 messages/100 MB globally, 4,000 bytes per message) are provisional examples,
not capacity acceptance. Both row and text-byte caps are enforced; PostgreSQL
indexes, WAL, replicas and backups consume additional physical capacity. Establish
synthetic throughput/storage measurements and approve actual limits before use.
A bounded oldest-first eviction advances a persistent per-group time floor, so
late messages cannot resurrect evicted text or withdrawn messages. Reads exclude
expired data immediately; each purge deletes at most 200 obsolete rows.

Only eligible post-enablement human text is ingested. There is no history import,
attachment download, embedding or background summary. The separate 64-event
collector queue and dedicated PG pool keep storage out of reply handling. Overflow
or dependency failure emits only `history_gap`; retrieval never promises complete
history. Writes/reads have statement and lock timeouts. Candidate scans are limited
before topic filtering, including Chinese substring matching; missing an earlier
candidate is possible and results remain explicitly incomplete.

The current search context tool accepts a fixed-turn relative period (recent 30
minutes, yesterday, previous calendar week) or validated explicit UTC start/end.
Calendar periods use the configured service timezone. Explicit month-plus-topic
requests can cover the retained interval; there is no seven-day hard restriction.
Bounds are start-inclusive/end-exclusive. Ambiguous earlier dates require a range.
Quoted records take priority, followed by topic/time and bounded neighboring
messages. At most two lookups share a deduplicated 1,000-byte conservative evidence
budget (therefore no more than 1,000 tokens), ten records and 2,000 tool characters.
No extra model/tool calls are granted. History lookup and draft mutation cannot
share a turn in this trial: quote/history evidence never becomes write authority.
Existing explicit-content preview/confirmation workflows remain separate. This deliberately conservative trial budget
can truncate evidence; a truncated sample cannot establish a final group decision.

Bot replies are excluded from human full-text candidates. Only a referenced Bot
reply may supply a 200-character safe anchor, with sharing links removed and source
dependencies retained. No model summarizes these anchors. Withdrawn/expired/policy-
invalid sources invalidate the anchor and derived result. Original evidence and
answers are removed from the next model checkpoint and summary; current-task model
calls may reuse evidence. Confirmed delivery does not reinsert historical answers.
Delayed delivery and result replay revalidate source keys, current group, policy,
expiry and restore epoch. Failure is unavailable, never inferred public authority.
Trace fields distinguish unique history evidence bytes/lookups from actual repeated
model input estimates. No raw text, people or source IDs enter diagnostics.

## Activation, restore and shutdown

1. Obtain deployment approval and phase-A real LINE acceptance. Keep B off while
   merging/releasing its code. Notice the selected group about shared history,
   retention, future-member visibility and the chosen exclusion procedure.
2. Apply `migrations/20261030-group-history.sql` through the approved migration
   procedure. It is idempotent and not executed automatically at app startup.
3. Provision a local configuration outside this public repository with exact
   helper group IDs, activation timestamp, exclusions, policy revisions and
   validated limits. Increment the monotonic `generation` for every configuration
   change; old revisions cannot promote an older generation. Set a new non-secret `restoreEpoch` in the external config.
   Configure `GROUP_HISTORY_CONFIG_PATH`; keys remain outside PG.
4. Stage with synthetic groups first. Verify cross-group refusal, new-member
   access, late/duplicate events, withdrawal-before-message, expiry, quotas,
   dependency failure, restart, delayed delivery, quote anchors and invalid replay.
5. Enable only approved groups. Preserve the activation timestamp across ordinary
   restarts; use a new revision/timestamp on re-enablement. A policy/exclusion or
   retention change changes source identity. Drain old configs/revisions before
   applying policy changes; do not run competing configuration owners.
6. To disable, set `enabled: false` (or remove the specific policy), restart under
   the approved release procedure, then run bounded purge until obsolete rows are
   gone. Removing the environment variable alone does not physically purge PG.
7. Before restoring any backup, keep collection/read ingress disabled and rotate
   the external restore epoch. Reapply current deletion/policy state before
   enabling. Restored rows with the old epoch remain unreadable and purge in
   batches. Restoring an old backup together with its old external policy epoch
   is not safe and is forbidden by the restore procedure.

Rollback disables B and preserves A. Keep source fences and data until approved
purge; do not replay old webhook events, re-enable retired providers, or claim
physical deletion from every backup/provider merely because live reads reject it.
Live provider retention and actual LINE delivery require separate acceptance.

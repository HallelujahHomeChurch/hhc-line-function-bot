# Media binding lifecycle controls

All lifecycle reads and mutations require current Account media-management permission
and collection management access. Mutations use an exact binding ID/version (or
unused code ID), a caller-scoped idempotency identity and an atomic audit outbox.
Replaying a successful request cannot alter a replacement binding or code. The
consumer audit fixture comes from audit-log PR #24's canonical catalog.

Pause prevents intake, new claims and publication reservations. It does not collect
media for later backfill. Existing leases may finish an external call; their known
result remains recorded. Resume only opens the same admitted binding generation.
Group removal and re-registration do not restore that generation. Unbind cancels
unpublished automatic branches, preserves published owners and ACLs, and leaves
unknown publication attempts blocked. A new code cannot be issued or consumed
while the collection has an unfinished publication attempt.

Manual saves retain their approved scope. An interrupted pending manual branch
without an external attempt is blocked as `manual_authority_unavailable`, because
this worker cannot independently refresh its original Account authority. It is
never silently cancelled, replayed or used as permission to delete a shared Asset.
A completed auto branch may finish while this manual branch remains blocked.

The binding status endpoint reports current state, exact revision, pending-code
identity, live leases, unknown publication results and blocked manual counts. It
never returns raw source identifiers or the bearer binding code. Successful pause
or unbind means the local transition committed, not that every remote call ended.
Explicit unsend and collection deletion retain their separate cleanup semantics.

## Rollout

1. Release the canonical Audit actions, additive schema and journal/lifecycle-aware
   workers. Drain every older worker before proceeding.
2. Deploy Bot routes and exact Gateway Admin routes, leaving
   `MEDIA_SYNC_LIFECYCLE_ENABLED=false` (the default).
3. Deploy Admin controls. Read-only state remains available; mutation endpoints
   return 404 while disabled.
4. After worker compatibility and acceptance checks, enable the flag through the
   normal reviewed configuration release. No flag was changed by this work.

The first state-contract v2 release is forward-only. The deployment snapshots
the prior contract and exact worker digests before mutation; if they are legacy
or mixed, automatic rollback refuses before any restore write. A failed release
retains its current workloads and requires a compatible forward fix. Subsequent
releases may use automatic rollback only to a matching v2 runtime/worker set.
Do not clear this fence or return to a legacy image merely to get a green report.

Do not roll workers back to versions that ignore paused bindings or publication
attempts. Keep controls disabled until compatible workers are restored. No live
LINE, production account or device acceptance is implied by local/CI tests.

## Individual recovery

The single-work retry endpoint only nudges current, unleased, admitted work in
transient backoff (`asset_unavailable`, LINE read timeout/cancellation, scan,
processing or transcoding pending). It rechecks collection access on every call,
including idempotent replays. It refuses unknown external attempts, unavailable
sources, old generations and independently confirmed pending manual saves.
It never republishes a completed destination or resets an attempt journal. The
work-scoped retry audit and idempotent receipt commit with the outbox nudge.

Admin offers an individual retry only for a temporary failure while controls and
the current binding are active. The backend remains authoritative; a status change
between rendering and clicking yields a conflict. A lost HTTP response reuses the
same idempotency identity. No bulk retry operation exists.

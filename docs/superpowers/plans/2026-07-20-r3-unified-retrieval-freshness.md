# R3 Unified Retrieval and Catalog Freshness Implementation Plan

## Goal

Give presentations, sheet music, and general resources one authoritative
catalog publication, freshness, invalidation, and reference-validation
lifecycle. Cached or remembered metadata must never become an answer by itself.

## Work

1. Add source publication revision and health watermarks: never synced, ready,
   stale, and unavailable, with last attempt/success/failure and item count.
2. Add atomic full-snapshot and delta publication operations. Items, tombstones,
   source revision, cursor, and health become visible together; failed refreshes
   keep the prior successful publication.
3. Refactor OneDrive sync to prepare normalized items before publication and to
   mark failures without overwriting a newer success.
4. Make catalog search return a freshness disposition. Callers distinguish
   fresh, stale-but-allowed, unavailable, and genuine not-found without naming
   Graph, OneDrive, Redis, or catalog internals.
5. Demote resource memory to bounded ranking metadata. Remove direct exact-memory
   answers and validate any remembered reference against current authorized
   catalog/live-provider state.
6. Validate Graph item references immediately before creating a sharing link;
   tombstone/missing references fail closed and request a fresh lookup.
7. Remove the unversioned 30-minute sheet-music file-index cache so a newly
   added file is not hidden. Any future query cache must include profile,
   source, capability contract, normalized query/options, and source revision.
8. Add regression tests for atomic failure, stale/unavailable/not-found
   classification, rename/delete/tombstone behavior, no stale-memory revival,
   fresh second queries, restart-compatible persistence, and multi-instance
   publication semantics.
9. Update documentation and complete PR CI, merge, release, and production
   gateway validation.

## Acceptance

- Full and delta publications are atomic.
- Search exposes a product freshness status and never labels unavailable as not
  found.
- A second query sees new provider data and cannot be satisfied by the prior
  task/cache unless the user explicitly requests replay.
- Remembered metadata cannot revive a disabled, tombstoned, renamed, moved, or
  unauthorized resource.
- Sharing links are generated only after current reference validation.

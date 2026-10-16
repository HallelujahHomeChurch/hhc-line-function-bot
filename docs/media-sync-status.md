# Collection synchronization status

`GET /api/line/media-sync/collections/{collectionId}/status` requires the existing
Gateway/Account media-management gate and a fresh Asset collection-management
check before reading local status. It returns `Cache-Control: private, no-store`.
No source/LINE identity, filename, raw failure, content URL or manual destination
is returned. Work IDs are opaque display identifiers, not authority to retry.

Require `from` and `until` UTC timestamps (three to six fractional digits) for a
half-open receipt window of at most seven days. `until` can be no more than one
minute in the future. `limit` is 1–50, default 25. A cursor is scoped to the exact
collection and window and preserves PostgreSQL timestamp precision. Every page
rechecks authority. Status may advance between pages; refresh begins a new view.

Counts represent unique ingests received within that window. Collection and
manual publications of the same source count once; published means the collection
publication is currently published. A source tombstone takes precedence over a
stale publication row. This is not a LINE batch total and cannot account for
messages LINE did not deliver. The row page and totals share one SQL snapshot.
The additive receipt-window index supports bounded selection without per-row
remote API calls.

This first slice is read-only: it exposes existing received, processing, scanning,
published, failed, cancelled and withdrawn states. It does not enable pause,
unbind or retry before the worker lifecycle fences are implemented. Unknown
internal failure strings become a fixed safe category. No raw exceptions reach
Admin. Automatic worker recovery and publication reconciliation remain separate
from this display.

Deploy the additive Bot producer and exact Gateway GET route before Admin enables
status. Rollback can retain the index. No migration deletes data or changes ACLs.

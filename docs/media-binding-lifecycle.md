# Media binding generation and retained publications

Every new automatic ingest carries the immutable binding ID observed at intake.
The store snapshots the active binding when an internal caller does not supply
one. Redelivery cannot move an existing source to another generation. Workers and
SQL finalization require that exact generation, even if a replacement binding
uses the same group and collection.

The additive migration backfills existing ingests once, only when their receipt
time identifies exactly one historical binding. Ambiguous or missing history
stays unavailable; startup never assigns it to a later binding. The backfill is
serialized under the table lock and preserves all ingests and published handles.

An unavailable binding blocks automatic work without deleting an Asset, an
already published collection item, a manual resource, or ACLs. Unpublished
automatic publication is revoked. An independently approved but unfinished
manual branch remains pending and blocked for explicit recovery; this slice does
not claim fresh manual authorization or silently replay it. Actual external
handles returned after a finalization conflict are remembered for reconciliation.
An explicit source tombstone still reopens deletion work, including a late handle
remembered after unsend.

This is a worker prerequisite, not the pause/unbind API. Group-admission
revocation fencing, reserved external-publication reconciliation, versioned
management operations, Admin controls and recoverable retry remain subsequent
slices. Do not expose those operations while any worker ignores the new fences.
Deploy schema and compatible workers before enabling management operations.

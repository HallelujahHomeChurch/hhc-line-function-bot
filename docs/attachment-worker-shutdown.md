# Attachment worker graceful shutdown

The loop stops accepting work when its signal is aborted. Warm and work queue
receives carry the intake signal and check it again after the SDK returns. A late
message is left unacknowledged, including malformed messages and warm pulses.
A delete already started is awaited; cancellation does not prove it was undone.
Only an `AbortError` from a receive with this worker's aborted signal is treated
as normal stop. Other receive errors and active handler/ACK errors still escape.

Stopping the worker also synchronously stops future media outbox flushes. The
shared media dispatcher waits for every already-started flush, including its
immediate flush and overlapping interval flushes. Repeated stops return the same
join promise. Existing one-second warm and five-second API intervals, batch size
20, reservation lease 30 seconds, and overlap behavior remain unchanged.

Already-started work, durable outcome persistence and the existing conditional
ACK finish before cleanup. Stop does not reset publication state, outbox receipts,
claim generations, tombstones, upload descriptors or pending job updates. An ACK
failure after a durable completion does not authorize republishing the work.
Queue send success followed by a failed dispatch mark retains the existing
reservation/retry behavior; shutdown does not manufacture a dispatched receipt.

After current work/ACK and media flushes settle, the worker starts Redis `quit`
and PostgreSQL `pool.end` independently and waits for both actual promises. A
synchronous failure or stalled Redis close does not prevent PG close initiation.
As before, worker resource-close errors do not change its result. No forced
socket destruction, external PG cancellation connection, session setting, pool
size, replica setting or business deadline is introduced.

The API's consumer of this same dispatcher stops future flushes and starts HTTP
shutdown before waiting for media flushes. It closes Redis and PG only after both
HTTP shutdown and media flushes settle, including when HTTP shutdown rejects.
Resource cleanup continues after a preceding resource-close rejection. Other
attachment/audit dispatchers and maintenance callbacks have not gained active
joins; this change does not establish whole-API quiescence.

## Limits and integration

There is no total drain deadline. Bootstrap, meeting token/lookup, active work,
ACK, outbox dispatch, checked-out PG clients and resource close can still wait
indefinitely. The meeting client's shared refresh and existing HTTP timeout scope
are unchanged. The pinned Identity 4.13.1 MSAL acquisition path does not forward
the caller signal, so Queue's abort option is not an end-to-end auth deadline.
Redis client 6.1.0 removes command abort listeners before sending; abort cannot
certify that a sent EVAL stopped. A graceful-close-then-destroy timeout fallback
is not assumed safe. pg-pool 3.14.0 may resolve `end()` before idle clients finish
physical close. Local close settlement is not remote backend-zero evidence.

This change is based on main independently of PR #115. Integrate
[PR #115](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/pull/115)
first for its separate post-bootstrap setup-error cleanup, then refresh this PR
onto the resulting main and rerun review and CI. This branch intentionally does
not duplicate that setup repair. A green check before that integration is source
validation, not deployment or a connection-capacity certificate.

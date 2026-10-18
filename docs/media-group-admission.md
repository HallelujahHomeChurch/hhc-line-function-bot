# Group admission execution fence

Disabling a PostgreSQL access principal rotates its execution generation in the
same UPDATE. Registration can reactivate that principal but never restores its
old generation. A media binding captures the current generation; old work and
old bindings therefore remain unavailable after group removal/re-registration.
An explicit authorized replacement binding is needed to accept new media.

Worker claim and publication finalization check the exact binding and active
group generation. Database share locks serialize those operations against the
principal update. Intake and each new external phase recheck current admission.
Denied work preserves published owners and leaves unfinished manual work blocked
for explicit recovery; it does not delete shared Assets or expand ACLs.

The additive startup migration initializes access schema before media schema.
Existing bindings are backfilled once from active admission unless an existing
removal audit record postdates the binding. Missing or revoked historical
admission stays unavailable. Later startup must not reassign it to a new epoch.

An external operation already started before revocation can still finish. Its
known result is retained, and unsend still triggers explicit deletion. Reserved
publication attempts and visible settling/uncertain management state are the
next prerequisite before enabling pause/unbind/retry controls. This slice alone
is not a claim that remote publication and local revocation are one transaction.

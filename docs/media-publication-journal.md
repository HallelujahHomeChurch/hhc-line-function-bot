# Publication attempt journal

Before publishing a collection occurrence or a confirmed manual resource, the
worker reserves a single durable attempt under the current lease, binding and
admission checks. A competing worker cannot reserve a second attempt. Once an
attempt starts, a timeout, lost lease or process crash is an unknown result, not
permission to publish again. Such work is blocked as `publication_uncertain`.

Only the exact attempt can record its actual external result. Recording a late
result does not require the original lease or reactivate a revoked binding. A
known target remains owned for later explicit withdrawal. Repeated completion
must match the original outcome; a manual duplicate never acquires ownership of
someone else's target. Pending withdrawal cleanup waits for unfinished attempts,
then the late result reopens its deletion outbox.

This is a conservative at-most-one-attempt boundary, not a distributed
transaction or a guarantee that every attempt publishes. A crash between reserve
and the external call also needs review. There is deliberately no automatic
replay or guessed target deletion for unknown results. The current worker cannot
reconcile an unknown provider outcome without authoritative external evidence.
Operators must keep these records blocked until that evidence is available; do
not clear attempt IDs or use bulk retry. Binding controls will expose outstanding
attempts as settling/needs-review before they are enabled.

Deploy the additive schema and all journal-aware workers before enabling new
lifecycle controls. Drain old workers; rolling back to a worker that ignores
attempt records can duplicate publication. Existing unsend and explicit
collection deletion retain their cleanup semantics but may remain pending when
an external result is unknown. This change adds no live administrative controls.

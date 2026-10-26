# Redis receipt loss recovery

This is a reviewed operator procedure, not an automatic failover or exactly-once
claim. Do not run it for ordinary deployments. OOM with retained receipts is not
permission to rotate namespaces: preserve state and establish write headroom.
The CLI below is offline and makes no Redis, PostgreSQL, Azure or provider calls.

## Hold before diagnosis

Stop webhook delivery/admission, all API revisions, the persistent attachment
worker, finite attachment executions, catalog jobs, manual starts, release/rerun
writers and their queue producers. Confirm actual in-flight work has ended;
traffic zero is insufficient. Include direct internal callers and any external
owner of the same Redis namespace. Unknown owner mappings block reopening.
Keep recovery evidence outside Redis in a restricted durable operator artifact
store. Do not put message content, tokens, URLs, user identifiers, payloads or
private operational exports in this public repository or Actions output.

Record one UUID operation, the current namespace, every retired namespace, the
loss interval, a cutoff after writer drain, and the exact owner/queue inventory.
The journal is an operator attestation with hashes referencing separately retained
restricted evidence; passing the validator does not prove those observations.
Its canonical JSON hash binds the resulting deployment candidate. Preserve prior
journals and activation/release identities; never reuse an operation UUID or
namespace. The journal and deployment configuration must not share the lost Redis
store. If their integrity or completeness is uncertain, keep admission closed.

## Reconcile effects without replay

| Evidence                                                                                                              | Classification | Disposition                                                         |
| --------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Durable owner commit or confirmed provider effect with exact correlation                                              | completed      | no replay; do not resend a LINE reply                               |
| Durable record proving dispatch did not begin                                                                         | not_started    | no automatic replay; a separately reviewed new intent may be needed |
| Retained started/uncertain receipt, missing receipt, missing logs, ambiguous provider response, or incomplete mapping | unknown        | quarantine; absence is never proof of no effect                     |

Preserve retained receipts and copies of scoped evidence; do not FLUSH Redis or
reset old receipts to admitting. A stale snapshot can contain a pre-dispatch
receipt even though the external effect already happened. Redis receipt phase
alone cannot establish a safe retry after a restore.

The PostgreSQL `media_sync_ingests`, `media_sync_publications` and outbox remain
independent owner evidence. An attempt without completion is still uncertain;
use existing binding pause and publication inspection boundaries. Do not clear
attempt IDs or manufacture a completed journal. Manual attachment work and job
results stored only in Redis may have no recoverable outcome. Correlate the
original work with Asset and Graph/catalog owner evidence under separate read
approval; do not issue create/upload/publish to discover whether it happened.

Inventory both attachment and media warm queues, held deliveries and pending
outboxes. Preserve/quarantine ambiguous queue work before reopening. Rotating a
namespace does not migrate old queue payloads: an old work ID will be absent in
the new namespace. During recovery, an attachment `missing` result is left
unacknowledged. This is containment, not reconciliation; repeated deliveries can
consume resources, so keep the consumer held until positive quarantine/drain is
recorded. No queue purge, provider resend or generic replay command is supplied.
Unknown effects remain quarantined even after unrelated fresh work reopens.

## Prepare and review one activation

Use the schema demonstrated by `src/__tests__/redis-recovery.test.ts` to prepare a
private version-1 journal. The six explicit owner entries are API, persistent
attachment app, finite attachment job, catalog job, webhook delivery and queues.
Each requires held/drained evidence; queue quarantine/drain, complete inventory,
retired approvals and no automatic replay are separate required attestations.
Every listed effect needs a hashed correlation and positive evidence reference
or a quarantine record. An empty effect list is acceptable only when complete
inventory evidence positively establishes no affected effects.

```sh
python3 scripts/redis-recovery.py plan /restricted/operation-journal.json
```

A validation failure exits nonzero and prints a bounded error. Success returns
counts and a `candidate`, not an execution command or authorization. Independently
review evidence and copy only that non-secret candidate into
`config/redis-recovery.json` through the existing source/PR/release process.
The checked-in default is `null`: this change does not activate recovery.
No infrastructure, queue, provider or Redis mutation occurs in the planner.

Activation selects a unique `hhc-line-function-bot:recovery:<operation UUID>`
namespace and a signed-event timestamp cutoff. All API and attachment owners
must receive the same selected namespace; the catalog job receives it too.
After signature verification, the API rejects an entire batch containing any
missing/invalid timestamp, timestamp at/before the cutoff, or timestamp over
one minute into the future, before account linking, unsend, media intake,
commands or receipt claims. Such batches return 409 with a bounded quarantine
error and perform no reply or effect. Mixed old/new batches are held in full;
operator reconciliation, not automatic partial replay, handles them.

New timestamps cannot revive old opaque approvals: their session and result-job
lookups use the new namespace. PostgreSQL conversation checkpoints and durable
memory remain intact; they are not one-shot authority. A new explicit intent
can produce a fresh preview, but an old approval does not authorize that intent.
Old account-link/unsend events are also held; reconcile owner state and withdrawal
obligations rather than claiming all historic events were harmlessly dropped.

## Release preservation and reopening gate

The existing deployment renderer validates source candidate against the observed
API configuration before its first production mutation. A normal source `null`
preserves an active fence indefinitely; an older/different namespace cannot
silently replace it. API and worker/job manifests copy the same selected values.
Known-good rollback is permitted only with the same recovery identity and existing
runtime-state compatibility. First activation is forward-only. Do not run an
older release workflow or reactivate an old revision; those older binaries do not
know this fence. Deployment/release holds are mandatory throughout transition.

Before reopening, verify all actual revisions/jobs use the selected identity,
old writers/executions are drained, queue quarantine/drain evidence is complete,
unknown effects are retained without replay, all prior approvals are unusable,
and fresh synthetic events work once. A changed source SHA, owner mapping,
namespace or restored snapshot invalidates the evidence. Retain the fence and
journal after reopening; do not revert configuration to regain old job results.
Repeated incidents use another reviewed operation/new namespace with a later
cutoff, preserving the complete retired namespace history.

Local synthetic tests cover full/partial/stale Redis loss, old signed-event
rejection with zero mocked effect/reply calls, fresh deduplication, stale approval
rejection with a retained checkpoint, unknown attachment non-ACK and release
preservation/downgrade refusal. They do not establish production inventory,
provider reconciliation, physical drain, clock accuracy or a live recovery.

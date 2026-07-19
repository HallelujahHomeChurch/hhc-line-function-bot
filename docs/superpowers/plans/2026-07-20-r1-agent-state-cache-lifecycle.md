# R1 Agent State and Cache Lifecycle Implementation Plan

## Goal

Make a current explicit lookup authoritative, preserve requester-scoped explicit continuation, and make one-shot state safe across retries and replicas.

## Behavior contracts

- A new lookup always reaches the selected function handler. Legacy aliases and remembered resource metadata may never answer before the handler.
- Only a validator-authorized `active_task_refinement` receives the active task. Explicit current-message entities and queries win over that task.
- Resource metadata is deduplicated by stable storage identity and records `verifiedAt`, optional `sourceRevision`, and tombstone state. It is evidence/ranking metadata only.
- Legacy automatic aliases are retired without deleting their referenced resource rows.
- Generic and PPT selections are consumed atomically and remain requester/source/profile scoped.
- LINE `webhookEventId` is deduplicated durably with Redis and process-locally without Redis.
- Redis is required for restart and multi-replica guarantees; memory implementations are single-process development fallbacks.

## Tasks

1. Add failing regression tests for sequential fresh lookups, explicit task replay, explicit-query precedence, alias retirement, identity deduplication, invalidation, requester isolation, atomic selection consumption, and webhook redelivery.
2. Remove the pre-handler alias execution shortcut and retire legacy alias records through an idempotent migration.
3. Extend resource-memory records with stable identity, verification/revision/tombstone metadata and deduplicating upsert behavior.
4. Add atomic `takePptSelection` and `takeSelection` store methods and switch consumers to them.
5. Add memory/Redis webhook event idempotency stores and gate event handling by `webhookEventId`.
6. Add lifecycle diagnostics and update architecture/operations documentation.
7. Run formatting, typecheck, lint, full tests, build, agent eval, and retrieval-product eval; then PR, CI, merge, deploy, and smoke-test.

## Acceptance

- Two different consecutive presentation queries execute two distinct searches.
- `剛剛那份` can replay only through a valid active task and regenerates its link.
- A new title plus `連結` is a fresh lookup.
- Retired aliases cannot short-circuit execution; saved resource rows remain.
- Changed revision or tombstone excludes remembered candidates.
- Concurrent selection and webhook-event consumption has one winner.
- Cross-profile/source/requester leakage tests remain green.

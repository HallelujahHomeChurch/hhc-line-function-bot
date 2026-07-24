# R3.1 Final Review Fixes Report

## Outcome

All five Important final-review findings were resolved without weakening the
controlled write, requester-scope, or fail-closed boundaries.

1. Attachment scan work now moves through durable `pending_enqueue`, `queued`,
   bounded `claimed`, and terminal states. Claims carry an opaque token and
   expiry. A crashed claim can be reclaimed after expiry, while a stale worker
   cannot complete or fail the replacement claim. A queue delivery that gets
   `not_claimed` is acknowledged only after the worker atomically observes a
   terminal work state.
2. Confirmed work is persisted in a Redis-backed enqueue outbox before queue
   handoff. Queue send plus `markEnqueued` is the success boundary. An
   ambiguous queue/Redis failure remains pending for the background dispatcher
   and is reported as an automatic retry, never as a successful queue handoff.
   The in-memory fallback has no durable retry and fails closed.
3. An authorized requester can explicitly select and confirm a direct SearXNG
   PDF/JPEG/PNG result. The webhook process queues only the opaque work ID. The
   finite worker performs the existing DNS-pinned, redirect-bounded,
   private-address-rejecting download, content validation, ClamAV scan, shared
   binary publication, catalog upsert, and requester-scoped job completion.
4. The scan job now uses a dedicated minimal config loader. Its secret surface
   is limited to LINE access tokens, PostgreSQL, Redis, and Graph; the queue
   connection string is provisioned directly from its storage account. The
   ClamAV Azure Files key is obtained directly for environment-storage
   provisioning, discarded, and removed from the bot if a legacy copy exists.
   The scan job no longer receives channel secrets, admin IDs, LLM/embedding
   keys, Notion credentials, observability keys, or the bot producer SAS URL.
5. OpenAI embeddings are fixed to `text-embedding-3-small` at 1536 dimensions.
   Construction rejects missing keys, other models, and other dimensions.
   Configuration rejects every `EMBEDDING_DIMENSIONS` override and any
   non-exact model override. Response cardinality, index uniqueness/range,
   finite values, exact vector length, HTTP failures, and timeout remain
   bounded and tested.

## TDD Evidence

Focused regressions were introduced for crash/reclaim/stale-token behavior,
terminal redelivery acknowledgment, pre-send queue failure with Redis
unavailability, durable outbox retry and duplicate queue delivery, authorized
external import handoff, worker-only external download, minimal worker
configuration and manifest secrets, and the exact OpenAI request/response
contract.

The final stale-token assertion was observed RED:

```text
pnpm vitest run src/__tests__/scan-work-store.test.ts
1 failed, 4 passed
expected undefined to be false
```

After making terminal transitions return their claim-token CAS result, the
focused scan store was GREEN at 5/5. The combined attachment/import regression
run passed 6 files and 62 tests. The config/deployment/external-download/OpenAI
regression run passed 5 files and 96 tests.

The first repository-wide `pnpm test` run exposed one expected integration
fixture mismatch: four Kernel scan cases persisted work but did not model the
new queue handoff. Production handlers already called `markEnqueued`. Updating
the two shared Kernel fixtures to perform that real transition made the focused
Kernel corpus pass 6/6 and the fresh full suite pass 110 files and 936 tests.

## Fresh Offline Verification

- `pnpm format:check`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm test`: 110 files, 936 tests passed.
- `pnpm config:validate`: passed; profile `helper`, provider `deepseek`.
- `pnpm eval:admin`: 14/14 passed.
- `pnpm eval:agent`: candidates 19/19, validated 19/19.
- `pnpm eval:retrieval-product`: 2/2 passed.
- `pnpm eval:kernel`: 104/104 passed; zero security violations.
- `pnpm build`: passed.
- `bash -n scripts/deploy-aca.sh`: passed.
- `aca.attachment-scan-job.yaml`: parsed successfully with `js-yaml`.
- `git diff --check`: passed.
- Active runtime retirement scan found no office Ollama/ClamAV endpoint
  settings outside historical plan artifacts.
- Changed deployment diff contained no concrete API key, bearer token, storage
  connection string, or account key.

## Security And Deployment Notes

- Redis remains required for durable enqueue retry, cross-replica claim
  authority, and restart-safe work state. The in-memory implementation is
  deliberately process-local and does not claim durable retry support.
- Queue delivery remains at-least-once. Duplicate opaque IDs are safe because
  only one live claim token can win and stale terminal transitions return
  failure to the worker.
- No live DeepSeek, LINE, SearXNG, Azure Container Apps, OneDrive, or EICAR
  deployment check was run from this offline worktree. Those checks remain part
  of post-provisioning/deployment validation; no offline gate was weakened.

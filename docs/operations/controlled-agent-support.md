# Controlled Agent Support Runbook

## Support-code workflow

When a requester receives `支援碼：<16 hex characters>`, use the admin direct chat commands below. The same support code correlates webhook routing, function execution, recent errors, and controlled-agent phases without exposing the LINE principal or message.

1. Run `/last-errors` and locate `supportId=<code>`.
2. Run `/last-routes` to identify the selected action, result and duration.
3. Run `/last-agent-turns 20` to identify planner, validator, task lifecycle and retrieval execution mode.
4. Classify the failure before changing code. Never ask for group-chat history when the support code is sufficient.
5. Reproduce the recurrence as a versioned Kernel case and run `pnpm eval:kernel`.
6. Use the case's failed boundary ID to plan a shared contract or lifecycle fix；不要依失敗語句加入特例。

Execution modes:

- `fresh_search`: a normal source search without reusable state.
- `explicit_task_replay`: the requester explicitly refined or replayed the active result.
- `resource_memory_candidate`: a requester-visible recent resource matched.
- `catalog_snapshot_read`: the catalog answered before provider fallback.
- `provider_fallback`: the live provider/folder path answered after catalog miss.

R1 state rules:

- A new explicit query must reach the handler and must not report alias replay.
- `explicit_task_replay` is valid only for explicit continuation such as `剛剛那份`.
- Automatic aliases are retired; resource rows remain, while legacy alias rows are cleared by migration.
- Resource metadata is a candidate signal with verification/revision/tombstone lifecycle, not a completed-response cache.
- Redis is required for restart-safe, multi-replica webhook deduplication and atomic one-shot selection consumption.

Age and freshness are coarse buckets. Query/reference fingerprints are keyed, opaque equality markers; they are not IDs and cannot be used to retrieve content.

## Configuration

Production requires `OBSERVABILITY_HMAC_KEY` with at least 32 random characters. Store it as an ACA secret. Rotation intentionally starts a new actor/query fingerprint series; support IDs remain unaffected.

## Offline regression

```bash
pnpm eval:retrieval-product
pnpm eval:agent
pnpm eval:kernel
pnpm eval:kernel:integration
```

The first three commands are deterministic and do not call external model providers. The integration command additionally owns disposable Redis AOF and pgvector PostgreSQL containers, performs an actual Redis server restart, and fails if Docker, readiness, restart, namespace cleanup, or Compose volume cleanup fails. Its privacy-allowlisted report is `artifacts/kernel-v1/integration-report.json`; dependency URLs, key prefixes, schema names, queries, filenames, people, and payloads are excluded. The offline Kernel report is written to `artifacts/kernel-v1/report.json` and `.md`; reports contain case IDs, metric counts, and boundary classifications but no synthetic turn text. `case_execution_failed` means the evaluator itself could not complete a case. The retrieval corpus includes sequential PPT lookup, legacy-alias retirement, active-task continuation, schedule ambiguity, explicit schedule domain, not-found, unavailable, and write-confirmation precedence.

Redis-backed workflows support app restart and multiple replicas until TTL. Without Redis they are only for single-process local development. This gate proves Redis server restart for the checked-in AOF Compose stack; production recovery remains an infrastructure persistence and failover responsibility. PostgreSQL-backed catalog, schedules, knowledge, access, and explicit memory survive app restart; their in-memory alternatives are development-only.

## Azure Monitor baseline queries

The application emits sanitized JSON product events. Adjust the table name if the Container Apps environment uses a workspace-specific alias.

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.kind == "product_event"
| summarize first_success=minif(TimeGenerated, e.eventName == "function_completed" and e.resultClass == "success") by actor=tostring(e.actorFingerprint)
```

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.kind == "product_event" and e.eventName == "function_completed"
| summarize turns=count() by result=tostring(e.resultClass), action=tostring(e.action)
```

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.kind == "product_event"
| summarize events=count() by event=tostring(e.eventName), latency=tostring(e.latencyBucket), clarification=tostring(e.clarificationCountBucket)
```

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.kind == "function_result"
| summarize turns=count() by mode=tostring(e.executionMode), freshness=tostring(e.freshnessStatus)
```

## R0 baseline checklist

- A failed function reply contains a support code.
- `/last-errors`, `/last-routes`, and `/last-agent-turns` show that same code.
- Two different PPT queries have different query fingerprints.
- Fresh search, memory candidate, catalog, provider fallback, and explicit replay are distinguishable.
- No diagnostic JSON contains message text, person names, filenames, URLs, LINE IDs, tokens, or temporary links.

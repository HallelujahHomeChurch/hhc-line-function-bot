# Controlled Agent Support Runbook

## Support-code workflow

When a requester receives `支援碼：<16 hex characters>`, use the admin direct chat commands below. The same support code correlates webhook routing, function execution, recent errors, and controlled-agent phases without exposing the LINE principal or message.

1. Run `/last-errors` and locate `supportId=<code>`.
2. Run `/last-routes` to identify the selected action, result and duration.
3. Run `/last-agent-turns 20` to identify planner, validator, task lifecycle and retrieval execution mode.
4. Classify the failure before changing code. Never ask for group-chat history when the support code is sufficient.

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
```

Both commands are deterministic and do not call DeepSeek or Ollama. The retrieval corpus includes sequential PPT lookup, legacy-alias retirement, active-task continuation, schedule ambiguity, explicit schedule domain, not-found, unavailable, and write-confirmation precedence.

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

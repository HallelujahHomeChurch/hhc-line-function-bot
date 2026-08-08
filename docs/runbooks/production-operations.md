# Production Operations Runbook

## Health And Readiness

- `GET /healthz` is liveness only. It returns minimal service status and must not expose profiles, functions, or provider details.
- `GET /readyz` is public readiness for the data layer only. It checks Postgres and Redis, and must not mention model providers, Graph, Notion, profile names, enabled functions, IDs, or secrets.
- Use LINE admin `/diag` in direct chat for detailed dependency diagnostics.

## Admin Diagnostics

Direct-message admin commands:

```text
/diag
/llm-status
/llm-use
/last-routes
/last-errors
/last-agent-turns
/help
/help admin
/help admin all
```

`/diag` may show dependency status for DeepSeek, Azure OpenAI embeddings, Redis, Postgres, Graph, and Notion, but must not print tenant IDs, database IDs, folder IDs, LINE IDs, tokens, secrets, credential URLs, raw user messages, or invite codes.

`/llm-use` and `/llm-status` are Account-admin direct-chat only. Provider selection is controlled by profile/env configuration; LINE commands do not persist provider changes. `/llm-status` lists the current profile's DeepSeek-only lane policy. DeepSeek uses `DEEPSEEK_API_KEY` from ACA secrets or local `.env`.

If upgrading from the removed direct OAuth provider, review `docs/sql/drop-legacy-llm-auth.sql` before manually dropping the old `llm_auth_profiles` table.

Model access is profile-scoped. Configure every LLM-enabled profile with `allowedProviders: ["deepseek"]` and `primary: "deepseek"` for every semantic lane. Semantic fallback entries are rejected.

## Provider Secrets

- Store remote provider API keys in ACA secrets, not PostgreSQL.
- DeepSeek requires `DEEPSEEK_API_KEY`; `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, and `DEEPSEEK_TIMEOUT_MS` are normal runtime config.
- The public API gateway should expose only `/api/line/webhook/{profileName}` for this service; do not expose `/api/line/llm-auth/*`.
- The gateway forwards LINE callbacks through Dapr service invocation using app id `hhc-line-function-bot`. Keep the bot Container App Dapr configuration enabled with app port `3000` and HTTP protocol; the bot ingress remains internal.

## Profile Config Safety

- Production profiles live in `config/profiles.json` and are loaded through `PROFILE_CONFIG_PATH=/app/config/profiles.json`. Do not use `BOT_PROFILES_JSON`, `BOT_PROFILES_BASE64_JSON`, or `bot-profiles-base64-json` in ACA.
- Store only referenced LINE values as separate ACA secrets/env vars: `LINE_HELPER_CHANNEL_SECRET` and `LINE_HELPER_CHANNEL_ACCESS_TOKEN`.
- Keep persona, conversation, safety, and format rules in `smallTalk.prompting`. Production LLM profiles require all four layers; do not hard-code helper personality or safety fallback text.
- Before deployment, run `corepack pnpm config:validate`. The deployment pipeline sets the profile path, removes legacy profile configuration, and waits for the new revision to become ready.

## Registration And Admin Safety

- Admins bind LINE to an HHC account and are authorized by the Account `admin` role.
- Admins create one-time registration codes with `/invite-code-create`.
- The reply includes a copyable standalone `/registry <code>` line.
- Destructive admin actions must require `/confirm <code>`.
- `security_change` actions, such as invite-code creation, remain admin direct-only and audited, but do not require confirmation unless their action metadata changes.

## Local Webhook Smoke Test

Webhook paths are canonical and profile-scoped: `/api/line/webhook/{profileName}`. The profile name must match the path segment exactly.

Use the smoke tool to sign a LINE-shaped webhook payload:

```powershell
pnpm smoke:webhook -- --url http://localhost:3000/api/line/webhook/helper --secret PLACEHOLDER_LINE_CHANNEL_SECRET --text "小哈"
```

The tool prints status, request id when present, and response body. It must not print the channel secret or access token.

For an unsigned public gateway check, `POST /api/line/webhook/{profileName}` should reach the app and return a missing-signature style `400`. The Container App itself should keep external ingress disabled; public access should go through the gateway.

This smoke check also verifies the Dapr route. If the gateway returns a Dapr
app-id resolution or upstream error instead of the bot's
`{"ok":false,"error":"missing_line_signature"}`, verify:

```powershell
az containerapp show `
  --resource-group alive `
  --name hhc-line-function-bot `
  --query properties.configuration.dapr
```

Expected values are `enabled=true`, `appId=hhc-line-function-bot`,
`appPort=3000`, and `appProtocol=http`.

The line bot does not expose LLM auth callback routes. Public gateway routing should forward only the canonical webhook path for each profile.

## Controlled Agent Evals

- `pnpm eval:agent` is deterministic and offline. It exercises bounded candidates, planner proposals, plan validation, active tasks, and fail-closed recovery.
- `pnpm eval:agent:live` is manual and uses the configured DeepSeek-only lane. Do not run it in CI/CD unless the pipeline has intentional model endpoints and secrets.

## Dependency Checks

- Redis: verify the ACA secret `REDIS_URL` is set and `/readyz` shows Redis `ok`.
- Redis also stores requester-scoped conversation windows and long-running job results. If Redis is down, production should fail startup instead of silently losing those results.
- Postgres: verify `DATABASE_URL` and `DATABASE_SSL` are set and `/readyz` shows Postgres `ok`.
- Postgres stores access principals, audit events, and agent memory metadata.
- DeepSeek: use `/llm-status` or `/diag`, not `/readyz`.
- Graph: use function smoke tests through LINE, then `/diag` for configured/not configured state.
- Notion: use `pnpm check:notion` locally or function smoke tests through LINE, then `/diag` for configured/not configured state.

## Catalog Sync Job

Catalog sources live in PostgreSQL `catalog_sources`. Startup and the sync job run an idempotent seed from environment-backed roots such as `GRAPH_POP_SHEET_FOLDER_ITEM_ID`, not real folder IDs in git. Keep actual Graph drive/folder IDs in ACA environment settings or secrets.

The webhook service should stay long-running on `node dist/index.js`. The LINE webhook Container App keeps `minReplicas: 1` because LINE delivery is latency-sensitive and must not wait for ACA scale-from-zero. It retains `maxReplicas: 10` and `0.5 CPU / 1 GiB` per replica. Attachment scanning and ClamAV refresh remain finite ACA Jobs because they are asynchronous and are not part of the synchronous reply-token path.

Catalog sync runs as a separate ACA Scheduled Job from the same image:

```text
node dist/tools/sync-catalog.js
```

Use [`aca.catalog-sync-job.yaml`](../../aca.catalog-sync-job.yaml) as the placeholder manifest. The job is configured as `Microsoft.App/jobs` with `triggerType: Schedule` and `cronExpression: "*/15 * * * *"`.

Admins can inspect and operate the same DB-owned registry from direct chat:

- `/catalog-sources`
- `/catalog-source-status <sourceKey>`
- `/catalog-source-enable <sourceKey>`
- `/catalog-source-disable <sourceKey>`
- `/catalog-sync-now [sourceKey]`

Enable/disable/manual-sync operations write access audit events.

Required job settings:

- `PROFILE_CONFIG_PATH=/app/config/profiles.json`
- `DATABASE_URL`
- `DATABASE_SSL=true`
- `LINE_HELPER_CHANNEL_SECRET`
- `LINE_HELPER_CHANNEL_ACCESS_TOKEN`
- `GRAPH_TENANT_ID`
- `GRAPH_CLIENT_ID`
- `GRAPH_CLIENT_SECRET`
- `GRAPH_DRIVE_ID`
- `GRAPH_PPT_FOLDER_ITEM_ID`
- `GRAPH_POP_SHEET_FOLDER_ITEM_ID`
- `GRAPH_HYMN_SHEET_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID`
- `NOTION_TOKEN`
- `NOTION_SERVICE_DATABASE_ID`
- `EMBEDDING_PROVIDER=azure_openai`
- `AZURE_OPENAI_EMBEDDING_API_KEY`
- `AZURE_OPENAI_EMBEDDING_ENDPOINT=https://bible-text-embedding-resource.cognitiveservices.azure.com/`
- `AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small`
- `AZURE_OPENAI_EMBEDDING_API_VERSION=2024-10-21`
- `EMBEDDING_MODEL=text-embedding-3-small`
- `EMBEDDING_BATCH_SIZE=16`, `EMBEDDING_TIMEOUT_MS=30000`

Manual run after deployment:

```powershell
az containerapp job start `
  --name hhc-line-function-bot-catalog-sync `
  --resource-group PLACEHOLDER_RESOURCE_GROUP
```

Inspect executions:

```powershell
az containerapp job execution list `
  --name hhc-line-function-bot-catalog-sync `
  --resource-group PLACEHOLDER_RESOURCE_GROUP `
  --output table
```

The sync output is JSON and includes catalog/schedule counters plus a `knowledge` summary with source, document, chunk, embedding, and failure counts. Knowledge sources use content hashes so unchanged chunks retain their embeddings. An embedding outage leaves lexical content searchable and marks the source pending for the next run. OneDrive sources persist the final Graph delta link after successful writes; later runs apply only changes and tombstone deleted items. A `410 Gone` clears the stale cursor and re-enumerates the source, while sources that cannot use delta fall back to the full crawl. If a source page disappears, the next successful sync tombstones its read-model rows.

Before enabling `query_knowledge`, confirm `select extversion from pg_extension where extname='vector'`, verify the existing `bible-text-embedding-resource` deployment is healthy, and verify `/diag` reports `embedding: ok`. The release copies an Azure account key directly into the workload-scoped `azure-openai-embedding-key` ACA secret without printing or rotating it. Bulk knowledge synchronization is single-threaded in batches of 16 and should be scheduled off peak.

## R5.0 Release Assurance

R4.1 production verification is complete. R5.0 production acceptance is complete. The project is now in Stable Maintenance; no R5.1/R5.2, SaaS, or local-model follow-up is planned.

The accepted baseline is production release
[30237001171](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237001171),
which deployed revision `hhc-line-function-bot--0000149` with all 15 release
checks passing, and weekly assurance
[30237568728](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237568728),
whose seven dependency checks passed. Both reports attest
`providerRequests: { deepseek: 0, embedding: 0 }`.

`Production Release` runs `scripts/deploy-aca.sh` as one bounded transaction.
It snapshots the known-good bot revision and immutable image, applies the new
bot and finite-job definitions, waits for the target, and runs
`hhc-line-bot-release-probe`. The release report is always written to
`artifacts/release-assurance/report.json`; its allowlisted fields are release
and commit identifiers, start/completion timestamps, target and known-good
revision/image identities, check name/status/time/code, `failureCode`, and
rollback status/revision/image. The normal success attestation includes
`providerRequests: { deepseek: 0, embedding: 0 }`.

The release probe sends separately signed empty `events: []` requests through
the public gateway and records `gateway_helper_signed_empty_webhook` and
`gateway_main_signed_empty_webhook`. They verify the Gateway→Dapr→selected-
profile route, configured signature acceptance, and empty-batch early return.
They do not prove LINE platform delivery, LINE Console secret correctness,
reply-token behavior, or provider availability during normal turns. The
`providerRequests: { deepseek: 0, embedding: 0 }` field attests only this
provider-free release path; it is not provider runtime telemetry. Do not infer
a human LINE reply from this probe; inspect sanitized naturally occurring
success telemetry in a separately declared acceptance window for that evidence.

Release check failures use bounded codes such as `network_failed`, `timeout`,
`http_mismatch`, `malformed_json`, or `clamav_manifest_invalid`. Treat any
non-`none` `failureCode` as a failed release: retain the report artifact,
inspect the named check and Azure execution state, and correct the manifest,
network, or dependency condition in a reviewed pull request. Never retry by
changing production state manually before the transaction has completed its
rollback decision.

## Rollback

In single-revision mode the automatic rollback is copy-based: it creates a new
revision from the known-good revision, rather than mutating traffic back to an
old image tag. The transaction also restores each changed finite-job image.

```powershell
az containerapp revision copy `
  --resource-group PLACEHOLDER_RESOURCE_GROUP `
  --name hhc-line-function-bot `
  --from-revision PLACEHOLDER_KNOWN_GOOD_REVISION
```

Verify the copied revision becomes latest and ready, serves the expected
immutable image, and has the required ingress/Dapr contract. The release report
must record `rollback.status: "restored"` with the copied revision and image.
If revision copy itself fails, preserve the failed report and use the following
manual image update only as an emergency fallback while restoring service:

```powershell
az containerapp update `
  --name hhc-line-function-bot `
  --resource-group PLACEHOLDER_RESOURCE_GROUP `
  --image PLACEHOLDER_KNOWN_GOOD_IMMUTABLE_IMAGE
```

After either path, verify `GET /healthz`, `GET /readyz`, and direct-admin
`/diag`; then capture the observed state in the incident record.

## Weekly Dependency Assurance

The scheduled GitHub workflow runs `hhc-line-bot-periodic-assurance` weekly
and uploads `artifacts/release-assurance/periodic-report.json`. It is distinct
from release acceptance: it executes bounded Graph/Notion metadata checks,
attachment-queue and recent-scan checks, ClamAV clean/EICAR checks, and a
dedicated diagnostics-folder write/delete check. Its report has the same
allowlisted identity, timestamp, check, `failureCode`, target, known-good, and
rollback fields, with `providerRequests: { deepseek: 0, embedding: 0 }`.

For a failed weekly report, preserve the artifact, identify the failed check,
and repair the named dependency or job definition through a reviewed change.
Do not use a passing release smoke as a substitute for the first periodic run,
and do not use a periodic pass as proof of LINE delivery or reply-token use.

## Do Not Paste

Do not paste these into LINE, logs, commits, screenshots, or public issues:

- LINE channel secret or access token.
- `DEEPSEEK_API_KEY`.
- Invite codes that have not expired.
- `DATABASE_URL` and `REDIS_URL` if they reveal private network layout.
- Graph tenant/client/folder/drive IDs.
- Notion token or database ID.
- Raw user messages from production.

## Wikipedia Lookup

The bot does not perform arbitrary web browsing or maintain an administrator web allowlist. `query_wikipedia` uses the public Wikipedia API only, tries Chinese before English, and passes the selected article introduction to the configured source-bounded summarizer.

Sheet music has one controlled public-search fallback. If `SEARXNG_BASE_URL` points to an internal SearXNG service and local sheet music lookup finds nothing, the bot asks the requester whether to search public results. It calls SearXNG only after consent, uses only title/snippet/url fields, sends those fields to the `web_summarization` provider for summary/ranking, and does not fetch pages, download files, or save the results. Leave `SEARXNG_BASE_URL` unset to disable this fallback.

Production deploys `hhc-searxng` with internal-only ingress, one replica, `0.25` CPU, and `0.5Gi` memory. The active attachment Job has one replica per execution and uses a dedicated managed identity to call Asset API through authenticated internal ingress. Asset API owns the finite ClamAV scan and signature refresh Jobs. The LINE-owned weekly `10 19 * * 0` UTC refresh remains rollback-only until production smoke succeeds.

Asset returns a durable scan status. `pending` and `scanning` remain retryable; `infected`, `failed`, or any malformed response fails closed. The LINE Job downloads only after creating a service grant and verifies the original hash again before Graph publication.

## Attachment Save Gate

Do not add `image` or `file` to a production profile's `allowedMessageTypes` until all attachment prerequisites are configured:

- `save_resource` is granted only to the intended helper users/groups.
- The target catalog sources have write capabilities and real OneDrive folder IDs.
- Redis is configured so pending attachment sessions are not lost across restarts or replicas.
- The dedicated attachment identity has queue processor, queue reader, ACR pull, and `Asset.Invoke` access; Asset API and its scan Jobs are healthy.

The webhook entrance still only creates a short-lived pending attachment session and asks for purpose. After final confirmation it queues opaque work; the finite worker validates the download, uploads it to Asset, waits for `clean`, downloads through a service grant, verifies the hash, and then publishes.

If the worker, scanner, manifest, or queue is unavailable, or the scan result is anything other than `clean`, publishing fails closed. The bot should not bypass this for production.

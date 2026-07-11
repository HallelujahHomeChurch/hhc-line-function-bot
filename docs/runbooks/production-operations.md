# Production Operations Runbook

## Health And Readiness

- `GET /healthz` is liveness only. It returns minimal service status and must not expose profiles, functions, or provider details.
- `GET /readyz` is public readiness for the data layer only. It checks Postgres and Redis, and must not mention Ollama, Graph, Notion, profile names, enabled functions, IDs, or secrets.
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

`/diag` may show dependency status for Ollama, Redis, Postgres, Graph, and Notion, but must not print tenant IDs, database IDs, folder IDs, LINE IDs, tokens, secrets, credential URLs, raw user messages, or invite codes.

`/llm-use` and `/llm-status` are bootstrap superadmin direct-chat only. Provider selection is controlled by profile/env configuration; LINE commands do not persist provider changes. `/llm-status` lists the current profile's lane policy, including which lanes use Ollama and which use DeepSeek. DeepSeek uses `DEEPSEEK_API_KEY` from ACA secrets or local `.env`.

If upgrading from the removed direct OAuth provider, review `docs/sql/drop-legacy-llm-auth.sql` before manually dropping the old `llm_auth_profiles` table.

Remote API providers are profile-scoped. Configure the internal `helper` profile with explicit `allowedProviders` such as `["ollama","deepseek"]` and a `providerPolicy` that keeps `function_routing`, `admin_routing`, and `memory_routing` on Ollama while using DeepSeek only for higher-value generation lanes such as `smart_talk`. Future official `main` profiles should define their own provider allowlist and lane policy.

## Provider Secrets

- Store remote provider API keys in ACA secrets, not PostgreSQL.
- DeepSeek requires `DEEPSEEK_API_KEY`; `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, and `DEEPSEEK_TIMEOUT_MS` are normal runtime config.
- The public API gateway should expose only `/api/line/webhook/{profileName}` for this service; do not expose `/api/line/llm-auth/*`.

## Profile Config Safety

- Production profiles live in `config/profiles.json` and are loaded through `PROFILE_CONFIG_PATH=/app/config/profiles.json`. Do not use `BOT_PROFILES_JSON`, `BOT_PROFILES_BASE64_JSON`, or `bot-profiles-base64-json` in ACA.
- Store only referenced LINE values as separate ACA secrets/env vars: `LINE_HELPER_CHANNEL_SECRET`, `LINE_HELPER_CHANNEL_ACCESS_TOKEN`, and `LINE_HELPER_ADMIN_USER_ID`.
- Keep persona, conversation, safety, and format rules in `smallTalk.prompting`. Production LLM profiles require all four layers; do not hard-code helper personality or safety fallback text.
- Before deployment, run `corepack pnpm config:validate`. The deployment pipeline sets the profile path, removes legacy profile configuration, and waits for the new revision to become ready.

## Registration And Admin Safety

- The bootstrap `adminUserId` is the single superadmin for each profile.
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

The line bot does not expose LLM auth callback routes. Public gateway routing should forward only the canonical webhook path for each profile.

## Router Evals

- `pnpm eval:router` is deterministic and offline. It replays the function-module corpus through conservative keyword fallback.
- `pnpm eval:router:ollama` is manual and requires a reachable Ollama model. Do not run it in CI/CD unless the pipeline has an intentional model endpoint.

## Dependency Checks

- Redis: verify the ACA secret `REDIS_URL` is set and `/readyz` shows Redis `ok`.
- Redis also stores requester-scoped conversation windows and long-running job results. If Redis is down, production should fail startup instead of silently losing those results.
- Postgres: verify `DATABASE_URL` and `DATABASE_SSL` are set and `/readyz` shows Postgres `ok`.
- Postgres stores access principals, audit events, and agent memory metadata.
- Ollama: use `/llm-status` or `/diag`, not `/readyz`.
- Graph: use function smoke tests through LINE, then `/diag` for configured/not configured state.
- Notion: use `pnpm check:notion` locally or function smoke tests through LINE, then `/diag` for configured/not configured state.

## Catalog Sync Job

Catalog sources live in `config/catalog-sources.json`. The committed file uses environment references such as `GRAPH_POP_SHEET_FOLDER_ITEM_ID`, not real folder IDs. Keep actual Graph drive/folder IDs in ACA environment settings or secrets, never in git.

The webhook service should stay long-running on `node dist/index.js`. Catalog sync runs as a separate ACA Scheduled Job from the same image:

```text
node dist/tools/sync-catalog.js
```

Use [`aca.catalog-sync-job.yaml`](../../aca.catalog-sync-job.yaml) as the placeholder manifest. The job is configured as `Microsoft.App/jobs` with `triggerType: Schedule` and `cronExpression: "*/15 * * * *"`.

Required job settings:

- `PROFILE_CONFIG_PATH=/app/config/profiles.json`
- `CATALOG_SOURCES_PATH=/app/config/catalog-sources.json`
- `DATABASE_URL`
- `DATABASE_SSL=true`
- `LINE_HELPER_CHANNEL_SECRET`
- `LINE_HELPER_CHANNEL_ACCESS_TOKEN`
- `LINE_HELPER_ADMIN_USER_ID`
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
- `GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID` when the weekly report source is enabled
- `NOTION_TOKEN`
- `NOTION_SERVICE_DATABASE_ID`

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

The sync output is JSON and includes `sources`, `synced`, `skipped`, `upserted`, `itemSkipped`, `tombstoned`, `scheduleUpserted`, `scheduleSkipped`, and `scheduleTombstoned`. If a source is removed from OneDrive, the next full crawl tombstones missing catalog items so normal lookups stop returning deleted files. If a Notion schedule page disappears from the source query, the next sync tombstones that schedule row so `query_schedule` stops returning it from the read model.

## Rollback

Use Azure CLI to point the Container App back to a previous known-good image:

```powershell
az containerapp update `
  --name PLACEHOLDER_CONTAINER_APP_NAME `
  --resource-group PLACEHOLDER_RESOURCE_GROUP `
  --image alive.azurecr.io/alive/hhc-line-function-bot:PLACEHOLDER_TAG
```

After rollback, verify:

```text
GET /healthz
GET /readyz
```

Then send `/diag` from a direct admin LINE chat.

## Do Not Paste

Do not paste these into LINE, logs, commits, screenshots, or public issues:

- LINE channel secret or access token.
- `DEEPSEEK_API_KEY`.
- Invite codes that have not expired.
- `DATABASE_URL`, `REDIS_URL`, `OLLAMA_BASE_URL` if it reveals private network layout.
- Graph tenant/client/folder/drive IDs.
- Notion token or database ID.
- Raw user messages from production.

## Wikipedia Lookup

The bot does not perform arbitrary web browsing or maintain an administrator web allowlist. `query_wikipedia` uses the public Wikipedia API only, tries Chinese before English, and passes the selected article introduction to the configured source-bounded summarizer.

Sheet music has one controlled public-search fallback. If `SEARXNG_BASE_URL` points to an internal SearXNG service and local sheet music lookup finds nothing, the bot asks the requester whether to search public results. It calls SearXNG only after consent, uses only title/snippet/url fields, sends those fields to the `web_summarization` provider for summary/ranking, and does not fetch pages, download files, or save the results. Leave `SEARXNG_BASE_URL` unset to disable this fallback.

## Attachment Save Gate

Do not add `image` or `file` to a production profile's `allowedMessageTypes` until all attachment prerequisites are configured:

- `save_resource` is granted only to the intended helper users/groups.
- The target catalog sources have write capabilities and real OneDrive folder IDs.
- `VIRUS_SCAN_ENDPOINT` points to a reachable scanner service; optional `VIRUS_SCAN_API_KEY` is stored as a secret if needed.
- Redis is configured so pending attachment sessions are not lost across restarts or replicas.

The webhook entrance still only creates a short-lived pending attachment session and asks for purpose. The later pending-attachment handler downloads the LINE content only after the requester provides a supported purpose, then validates size, MIME/magic bytes, extension, safe filename, hash, and virus scan. It previews the resolved name/type and requires the requester to reply `保存` before uploading to OneDrive and upserting catalog metadata.

If the scanner is missing, times out, returns a non-2xx response, or returns any status other than `clean`, publishing fails closed. The bot should not bypass this for production.

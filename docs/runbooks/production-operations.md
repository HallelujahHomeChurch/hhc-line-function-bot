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
/web-allowlist
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

- Production profile JSON should be safe to paste for review. Use `channelSecretEnv`, `channelAccessTokenEnv`, and `adminUserIdEnv` in `BOT_PROFILES_BASE64_JSON`.
- Store the referenced LINE values as separate ACA secrets/env vars, for example `LINE_HELPER_CHANNEL_SECRET`, `LINE_HELPER_CHANNEL_ACCESS_TOKEN`, and `LINE_HELPER_ADMIN_USER_ID`.
- Keep small-talk persona and rules in `smallTalk.prompting`. Do not hard-code bot personality in code, and do not put house-church quote behavior into small talk.
- Before and after profile changes, run `skills\hhc-line-deploy-guard\scripts\profile-secret.ps1 -Action check-production-safe`.

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
- Postgres stores access principals, audit events, agent memory, and controlled web allowlist entries.
- Ollama: use `/llm-status` or `/diag`, not `/readyz`.
- Graph: use function smoke tests through LINE, then `/diag` for configured/not configured state.
- Notion: use `pnpm check:notion` locally or function smoke tests through LINE, then `/diag` for configured/not configured state.

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

## Controlled Web Lookup Prep

Future web lookup functions must use the profile-scoped allowlist before fetching any URL.
Manage entries from direct admin chat:

```text
/web-allowlist
/web-allowlist-add <domain> [pathPrefix]
/web-allowlist-enable <id>
/web-allowlist-disable <id>
/web-allowlist-remove <id>
```

The guard allows HTTPS only and still blocks localhost/private-network targets even when an entry exists.

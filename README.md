# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to local-first functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile allowlists, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` first.
- Conservative keyword fallback when Ollama times out, is unreachable, or returns invalid JSON.
- LINE Quick Reply suggestions for supported functions.
- Postback-based selection state for multi-result flows, currently used by PPT search.
- Function handlers:
  - `find_ppt_slides`: searches a configured Microsoft Graph drive folder, fuzzy-matches PPT/PDF names, and returns 24 hour sharing links.
  - `query_service_schedule`: queries Notion with env-configured property mapping.

Disabled, unknown, unclear, or explicitly denied actions are denied. There is no Azure OpenAI fallback in this version.

## Local Setup

```powershell
pnpm install
Copy-Item .env.example .env
# Edit .env with real local values. Do not commit it.
pnpm dev
```

Set the LINE webhook URL per bot profile, for example:

- `/line/main/webhook`
- `/line/slides/webhook`

Health:

```text
GET /healthz
```

## Bot Profiles

Profiles are configured by `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`.

Each profile controls:

- LINE channel secret and access token.
- Webhook path.
- Allowed LINE group/user ids.
- Wake keywords and mention handling.
- Enabled functions.

Example shape:

```json
[
  {
    "name": "main",
    "webhookPath": "/line/main/webhook",
    "channelSecret": "PLACEHOLDER",
    "channelAccessToken": "PLACEHOLDER",
    "allowedGroupIds": ["PLACEHOLDER_GROUP_ID"],
    "allowedUserIds": ["PLACEHOLDER_USER_ID"],
    "allowDirectUser": true,
    "allowRooms": false,
    "allowedMessageTypes": ["text"],
    "groupRequireWakeWord": true,
    "wakeKeywords": ["小哈"],
    "acceptMention": true,
    "enabledFunctions": ["find_ppt_slides", "query_service_schedule"]
  }
]
```

Use `*` in an allowlist only when you intentionally want to allow every id for that source type.

## Routing

Primary routing uses Ollama. Keyword fallback is intentionally narrow:

- `find_ppt_slides`: `投影片`, `ppt`, `powerpoint`, `slides`
- `query_service_schedule`: `服事表`, `服事`

Keyword fallback does not treat `詩歌` or `流行歌` alone as PPT requests. PPT fuzzy matching happens inside `find_ppt_slides`; for example, `奇易恩點` can match `奇異恩典.pptx`.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

## State

Multi-result PPT search stores a short-lived in-memory session and replies with LINE postback Quick Replies. The first version is single-instance friendly. If the Container App scales beyond one replica or restarts, pending selections can expire; use Redis or another shared store before enabling multiple replicas.

## Notion Service Schedule

For the current HHC media service schedule database, use these property mappings:

- `NOTION_DATE_PROPERTY=聚會日期`
- `NOTION_MEETING_PROPERTY=聚會場次`
- `NOTION_ROLE_PROPERTY=服事崗位`
- `NOTION_PERSON_PROPERTY=服事人員`

`NOTION_SERVICE_DATABASE_ID` can be the database id. The app resolves the queryable Notion data source internally.

## Runtime Secrets

Do not commit real `.env` files. In Azure Container Apps, store runtime values in ACA secrets, especially:

- `BOT_PROFILES_JSON`
- `OLLAMA_BASE_URL`
- LINE channel secrets and tokens inside the profile JSON
- `NOTION_TOKEN`
- `GRAPH_CLIENT_SECRET`

## GitHub Actions

`ci.yml` runs install, typecheck, lint, tests, app build, Docker image build, and publishes the image to GHCR on pushes to `main`.

`deploy-aca.yml` uses GitHub OIDC with Azure. Configure these GitHub variables:

- `AZURE_SUBSCRIPTION_ID`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_RESOURCE_GROUP`
- `CONTAINER_APP_NAME`

The deploy workflow updates the Azure Container App to use a GHCR image:

```text
ghcr.io/hallelujahhomechurch/hhc-line-function-bot:<tag>
```

The GHCR package is intended to be public so Azure Container Apps can pull it without registry credentials. Runtime secrets are expected to be preconfigured on the Container App.

## Verification

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

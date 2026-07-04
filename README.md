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
- Hermes-compatible numeric PPT selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
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

Multi-result PPT search stores a short-lived in-memory session and replies with LINE postback Quick Replies. Users can also reply with a plain number such as `1` to select from the latest active PPT candidate list for the same profile, LINE source, and requester.

The first version is single-instance friendly. If the Container App scales beyond one replica or restarts, pending selections can expire; use Redis or another shared store before enabling multiple replicas.

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

## Azure DevOps Pipeline

`azure-pipelines.yml` runs install, format check, typecheck, lint, tests, app build, and Docker image build for PRs and pushes to `main`.

On successful `main` builds, the pipeline uses Azure Resource Manager service connection `alive-azure-rm` and `az acr build` to publish images to ACR:

```text
alive.azurecr.io/alive/hhc-line-function-bot:<branch>-<buildId>
alive.azurecr.io/alive/hhc-line-function-bot:latest
```

Azure Container Apps should pull from the ACR image. Runtime secrets are expected to be preconfigured on the Container App.

## Verification

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

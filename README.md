# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to functions through a local-first LLM router.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile allowlists, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` first.
- Azure OpenAI fallback only when Ollama times out, is unreachable, or returns invalid JSON.
- Function handlers:
  - `find_ppt_slides`: searches a configured Microsoft Graph drive folder and returns 24 hour sharing links.
  - `query_service_schedule`: queries Notion with env-configured property mapping.

Disabled, unknown, or unclear actions are denied and do not call Azure OpenAI.

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

## Runtime Secrets

Do not commit real `.env` files. In Azure Container Apps, store runtime values in ACA secrets, especially:

- `BOT_PROFILES_JSON`
- `OLLAMA_BASE_URL`
- LINE channel secrets and tokens inside the profile JSON
- `NOTION_TOKEN`
- `GRAPH_CLIENT_SECRET`
- `AZURE_OPENAI_API_KEY`

## GitHub Actions

`ci.yml` runs install, typecheck, lint, tests, app build, and Docker image build.

`deploy-aca.yml` uses GitHub OIDC with Azure. Configure these GitHub variables:

- `AZURE_SUBSCRIPTION_ID`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_RESOURCE_GROUP`
- `ACR_NAME`
- `CONTAINER_APP_NAME`

The workflow pushes an image to ACR and updates the Azure Container App image. Runtime secrets are expected to be preconfigured on the Container App.

## Verification

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to local-first functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile allowlists, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` first.
- Conservative keyword fallback when Ollama times out, is unreachable, or returns invalid JSON.
- LINE Quick Reply suggestions for supported functions.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Clarification state for missing slots, so users can ask `查投影片`, `查流行歌譜`, or generic `查服事表` and answer the follow-up with just the missing value.
- Intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts, scoped to each profile's enabled functions.
- Optional Redis backend for sessions, cache, recent errors, and rate limiting.
- Direct-chat admin commands for configured admin LINE user ids.
- Function handlers:
  - `find_ppt_slides`: searches a configured Microsoft Graph drive folder, fuzzy-matches PPT/PDF names, and returns 24 hour sharing links.
  - `query_service_schedule`: queries Notion with env-configured property mapping.
  - `find_pop_sheet_music`: searches a configured OneDrive/SharePoint sheet music folder recursively, including shortcut folders, and returns 24 hour sharing links.

Disabled, unknown, unclear, or explicitly denied actions are denied. There is no Azure OpenAI fallback in this version.

## Local Setup

```powershell
pnpm install
Copy-Item .env.example .env
# Edit .env with real local values. Do not commit it.
pnpm dev
```

Set the LINE webhook URL per bot profile, for example:

- `/line/helper/webhook`
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
    "name": "helper",
    "webhookPath": "/line/helper/webhook",
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
    "enabledFunctions": ["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"],
    "adminUserIds": ["PLACEHOLDER_ADMIN_USER_ID"],
    "adminDirectOnly": true
  }
]
```

Use `*` in an allowlist only when you intentionally want to allow every id for that source type.

## Routing

Primary routing uses Ollama. Keyword fallback is intentionally narrow:

- `find_ppt_slides`: `投影片`, `ppt`, `powerpoint`, `slides`
- `query_service_schedule`: `服事表`, `服事`
- `find_pop_sheet_music`: `流行歌譜`, `流行歌曲樂譜`, `樂譜`, `歌譜`, `sheet music`

Keyword fallback does not treat `詩歌` or `流行歌` alone as PPT requests. PPT fuzzy matching happens inside `find_ppt_slides`; for example, `奇易恩點` can match `奇異恩典.pptx`.

For sheet music requests, Ollama can extract the song title, optional artist, requested file type, and fuzzy/exact match preference. Keyword fallback stays conservative and only routes requests that explicitly mention sheet music wording.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

## State

Multi-result PPT and sheet music searches store short-lived in-memory sessions and reply with LINE postback Quick Replies. Users can also reply with a plain number such as `1` to select from the latest active candidate list for the same profile, LINE source, and requester. Numeric replies without an active selection session are ignored instead of being routed or answered.

If a PPT or sheet music request is missing the title keyword, the bot stores a short-lived pending function session and asks for the missing title. The user's next plain-text reply from the same LINE source and requester fills the missing `query` argument and runs the original function.

If a service schedule request is too generic, such as `查服事表`, the bot asks which range to use and offers Quick Replies for `下一場`, `本週`, `明天`, and `主日`.

The first version is single-instance friendly. If the Container App scales beyond one replica or restarts, pending selections can expire; use Redis or another shared store before enabling multiple replicas.

Set `REDIS_URL` to move sessions, cache, recent errors, and rate-limit state to Redis. If `REDIS_URL` is unset, the app uses in-memory stores. If `REDIS_URL` is set but Redis cannot connect, startup fails.

Sheet music search uses a short-lived in-memory file index cache. Admins can clear it from a direct LINE chat:

```text
/refresh-sheet-music-cache
```

Admin commands use slash syntax and are gated by each profile's `adminUserIds`.
Available commands:

- `/status`
- `/functions`
- `/profile`
- `/route-test <text>`
- `/llm-status`
- `/last-errors`
- `/sessions`
- `/cache`
- `/clear-sessions`
- `/refresh-sheet-music-cache`

`/route-test <text>` reports the selected provider, action, arguments, and any fallback reason. `/llm-status` probes Ollama from inside the running app process with `/api/tags` and a minimal `/api/chat` call, without echoing the full base URL.

## OneDrive And Graph

Graph access uses app-only Microsoft 365 auth. Configure the main drive id and folder ids/paths through env vars:

- `GRAPH_DRIVE_ID`
- `GRAPH_PPT_FOLDER_ITEM_ID`
- `GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID` or `GRAPH_SHEET_MUSIC_FOLDER_PATH`
- `SHEET_MUSIC_ALLOWED_EXTENSIONS`
- `SHEET_MUSIC_DEFAULT_RECURSIVE`

When recursive sheet music lookup is enabled, the Graph client follows folder children and OneDrive shortcut folders by using each shortcut's `remoteItem` drive and item ids.

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
- `REDIS_URL` when using multi-replica or restart-tolerant state

## Governance

The app assigns a request id to each handled LINE event and includes it in route observer logs and recent error records. Basic per-source rate limiting is enabled by default:

- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX_REQUESTS=20`
- `LAST_ERRORS_MAX_ENTRIES=20`

## Azure DevOps Pipeline

`azure-pipelines.yml` runs install, format check, typecheck, lint, tests, router eval replay, app build, and Docker image build for PRs and pushes to `main`.

On successful `main` builds, the pipeline uses Azure Resource Manager service connection `alive-azure-rm` and `az acr build` to publish images to ACR:

```text
alive.azurecr.io/alive/hhc-line-function-bot:<branch>-<buildId>
alive.azurecr.io/alive/hhc-line-function-bot:latest
```

Azure Container Apps should pull from the ACR image. Runtime secrets are expected to be preconfigured on the Container App.

## Verification

```powershell
pnpm test
pnpm eval:router
pnpm typecheck
pnpm lint
pnpm build
```

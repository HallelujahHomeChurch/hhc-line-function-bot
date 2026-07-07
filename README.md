# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to local-first functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile access policy, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` first.
- Conservative keyword fallback when Ollama times out, is unreachable, or returns invalid JSON.
- LINE Quick Reply suggestions for supported functions.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Clarification state for missing slots, so users can ask `查投影片`, `查流行歌譜`, or generic `查服事表` and answer the follow-up with just the missing value.
- Intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts, scoped to each profile's enabled functions.
- Optional Redis backend for sessions, cache, recent errors, rate limiting, and one-time registration invite codes.
- Per-profile access policy with PostgreSQL-backed user/group/admin registration.
- Public `/help`, `/registry <code>`, and `/whoami` commands.
- Direct-chat admin commands for a single bootstrap `adminUserId` plus DB-managed admins.
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
- Direct and group access policy.
- Optional registration flow.
- Wake keywords and mention handling.
- Enabled functions.
- Single bootstrap superadmin user id.

Example shape:

```json
[
  {
    "name": "helper",
    "webhookPath": "/line/helper/webhook",
    "channelSecret": "PLACEHOLDER",
    "channelAccessToken": "PLACEHOLDER",
    "allowDirectUser": true,
    "allowRooms": false,
    "allowedMessageTypes": ["text"],
    "groupRequireWakeWord": true,
    "wakeKeywords": ["小哈"],
    "acceptMention": true,
    "enabledFunctions": ["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"],
    "adminUserId": "PLACEHOLDER_SUPERADMIN_LINE_USER_ID",
    "adminDirectOnly": true,
    "directAccessPolicy": "managed",
    "groupAccessPolicy": "managed",
    "registration": {
      "enabled": true
    }
  }
]
```

Use `adminUserId` for the single bootstrap superadmin. Legacy `adminUserIds`, `allowedUserIds`, and `allowedGroupIds` are rejected.

## Access Control

Profiles can choose separate policies for direct chat and groups:

- `directAccessPolicy: "managed"`: only DB users/admins or the bootstrap superadmin can use functions. If `registration.enabled=true`, unknown direct users receive a registration prompt.
- `directAccessPolicy: "public"`: any direct user can use the profile. This is suitable for a future official one-to-one bot.
- `directAccessPolicy: "blocked"`: direct users are blocked except slash diagnostics such as `/whoami` and admin authorization checks.
- `groupAccessPolicy: "managed"`: groups must be added through DB access management.
- `groupAccessPolicy: "blocked"`: group events are ignored.

Registration is profile-scoped. The current intended split is:

- `helper`: managed direct users, managed groups, invite-code registration enabled.
- `main`: public direct users, groups blocked, registration disabled.

Users and groups register with the same command:

```text
/registry <code>
```

Admins create one-time invite codes with `/invite-code-create`. The reply includes a standalone `/registry <code>` line that can be copied to a user or group. When the code is used within its TTL, the direct user or current group is opened immediately. Display names are resolved through the LINE SDK; users should not type names into the registration command.

If a managed group has not been opened yet, the bot stays quiet for normal group chatter. When someone addresses the bot with a wake word or mention, it replies with a short registration prompt instead of silently ignoring the request.

When any profile enables registration, configure:

```text
DATABASE_URL=...
DATABASE_SSL=true
REDIS_URL=...
REGISTRATION_INVITE_CODE_TTL_MINUTES=60
```

PostgreSQL stores active user/group/admin principals and audit events. Redis stores short-lived one-time registration codes.
If upgrading from the old pending-request registration flow, review `docs/sql/drop-legacy-access-registration.sql` before manually dropping legacy tables.

Function toggles are profile-scoped:

- `enabledFunctions` means profile-global functions for that bot profile only.
- Direct users can use profile-global functions only.
- Groups can use profile-global functions plus DB-managed grants for the same `profileName/groupId`.
- Group grants are additive. To make a function group-only, remove it from `enabledFunctions` and grant it to selected groups.

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

Admin commands use slash syntax and are gated by each profile's bootstrap `adminUserId` or DB-managed admin principals. `/help` lists public commands and enabled functions. `/help admin` lists common admin commands by group, and `/help admin all` includes advanced and diagnostic commands.

Common commands:

```text
/help
/registry <code>
/whoami
/access-list [user|group|admin]
/user-remove <userId>
/group-remove [groupId]
/function-grant <functionName> [groupId]
/function-revoke <functionName> [groupId]
/function-scopes [groupId]
/audit-list [limit]
```

Advanced commands:

```text
/user-add <userId> [name]
/group-add <groupId> [name]
/invite-code-create
/admin-add <userId>
/admin-remove <userId>
/status
/profile
/route-test <text>
/last-errors
/last-routes
```

Registered function modules may add more admin commands, such as `/llm-status`, `/functions`, `/sessions`, `/cache`, `/clear-sessions`, and `/refresh-sheet-music-cache`. `/route-test <text>` reports the selected provider, action, arguments, and any fallback reason. `/last-routes` reports recent sanitized route/function outcomes, including whether a query was present, without echoing the raw query.

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
- `DATABASE_URL`
- `REDIS_URL`

## Governance

The app assigns a request id to each handled LINE event and includes it in route observer logs, recent route diagnostics, and recent error records. Basic per-source rate limiting is enabled by default:

- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX_REQUESTS=20`
- `LAST_ERRORS_MAX_ENTRIES=20`

## Azure DevOps Pipeline

`azure-pipelines.yml` runs install, format check, typecheck, lint, tests, router eval replay, app build, and Docker image build for PRs and pushes to `main`.

The pipeline uses path filters so docs-only or agent-instruction-only changes do not trigger builds or deployments. It runs only when app, build, or deployment inputs change, such as `src/**`, package files, TypeScript/test config, Docker files, `azure-pipelines.yml`, or `aca.containerapp.yaml`.

On successful deploy-triggering `main` builds, the pipeline uses Azure Resource Manager service connection `alive-azure-rm` and `az acr build` to publish images to ACR:

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

# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to local-first functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile access policy, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` by default, with optional Codex app-server provider support.
- Action catalog that separates user functions, admin actions, and system actions.
- Policy gate and admin action registry for natural-language admin operations.
- Conservative keyword fallback when Ollama times out, is unreachable, or returns invalid JSON.
- LINE Quick Reply suggestions for supported functions.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Clarification state for missing slots, so users can ask `查投影片`, `查流行歌譜`, or generic `查服事表` and answer the follow-up with just the missing value.
- Intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts, scoped to each profile's enabled functions.
- Controlled agent turn runtime for routing, slot clarification, in-flight locks, recent file recall, explicit text/resource memories, and resource aliases.
- Requester-scoped short conversation windows, so group follow-up messages can continue naturally without letting other users inherit context.
- Long-running task handoff: slow turns can reply with a "check result" postback instead of using LINE push quota.
- Controlled web allowlist storage and admin commands for future safe web lookup features.
- Optional Redis backend for sessions, cache, recent errors, rate limiting, and one-time registration invite codes.
- Per-profile access policy with PostgreSQL-backed user/group/admin registration.
- Public `/help`, `/registry <code>`, and `/whoami` commands.
- Direct-chat admin commands for a single bootstrap `adminUserId` plus DB-managed admins.
- Admin natural language for selected management actions: invite-code creation, web allowlist add/list, and group function scope management.
- Minimal `/healthz`, data-layer `/readyz`, and admin-only `/diag` diagnostics.
- Destructive admin-action confirmation infrastructure through `/confirm <code>`.
- Function handlers:
  - `find_ppt_slides`: searches a configured Microsoft Graph drive folder, fuzzy-matches PPT/PDF names, and returns 24 hour sharing links.
  - `query_service_schedule`: queries Notion with env-configured property mapping.
  - `find_pop_sheet_music`: searches a configured OneDrive/SharePoint sheet music folder recursively, including shortcut folders, and returns 24 hour sharing links.
  - `save_memory`: saves text only when the user explicitly asks the bot to remember it.
  - `retrieve_memory`: retrieves explicitly saved text memories.

Disabled, unknown, unclear, or explicitly denied actions are denied. There is no Azure OpenAI fallback in this version.

## Local Setup

```powershell
pnpm install
Copy-Item .env.example .env
# Edit .env with real local values. Do not commit it.
pnpm dev
```

Set the LINE webhook URL per bot profile, for example:

- `/api/line/webhook/helper`
- `/api/line/webhook/slides`

Provider auth callbacks are not exposed by this service. LINE webhook traffic should only use the canonical profile paths above.

Health and readiness:

```text
GET /healthz
GET /readyz
```

`/healthz` is minimal liveness. `/readyz` checks only Postgres and Redis. Use admin direct-chat `/diag` for detailed dependency status.

## Bot Profiles

Profiles are configured by `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`.
`BOT_PROFILES_BASE64_JSON` is preferred for Azure Container Apps because it avoids shell quoting and newline issues. The decoded value must always be a JSON array, even when only one profile is configured.

Each profile controls:

- LINE channel secret and access token.
- Webhook path. It must be the canonical `/api/line/webhook/{profileName}` path.
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
    "webhookPath": "/api/line/webhook/helper",
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
    },
    "smallTalk": {
      "mode": "llm",
      "maxChars": 80
    },
    "generalAgent": {
      "enabled": true,
      "conversationWindowSeconds": 90
    },
    "longRunningJobs": {
      "enabled": true,
      "inlineReplyTimeoutMs": 8000,
      "resultTtlMinutes": 10
    }
  }
]
```

Profile names must use lowercase letters, numbers, dash, or underscore. The `webhookPath` must match the profile name exactly; for example, profile `helper` must use `/api/line/webhook/helper`.

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
CONFIRMATION_TTL_MINUTES=5
```

PostgreSQL stores active user/group/admin principals and audit events. Redis stores short-lived one-time registration codes, confirmation codes, sessions, cache, recent errors, and rate-limit counters.
If upgrading from the old pending-request registration flow, review `docs/sql/drop-legacy-access-registration.sql` before manually dropping legacy tables.

Function toggles are profile-scoped:

- `enabledFunctions` means profile-global functions for that bot profile only.
- Direct users can use profile-global functions only.
- Groups can use profile-global functions plus DB-managed grants for the same `profileName/groupId`.
- Group grants are additive. To make a function group-only, remove it from `enabledFunctions` and grant it to selected groups.
- Admin actions are not `enabledFunctions` and cannot be granted to groups. They are gated separately by admin identity, source policy, and audit rules.

## Routing

Primary routing uses Ollama unless a profile or environment selects `codex_app_server`. The Codex provider starts the Codex app-server over stdio inside the container and uses the account state available in `CODEX_HOME`. The bot can start Codex device login from LINE, but it does not expose provider OAuth callback routes or store provider tokens in PostgreSQL.

Provider access is profile-scoped. Internal helper profiles may set `allowSubscriptionProviders=true` and explicitly list `codex_app_server` in `allowedProviders`. Future official `main` profiles should keep subscription providers disabled.

If the primary provider returns invalid JSON, times out, or is unavailable, routing can fall back to Ollama through `LLM_FALLBACK_PROVIDER=ollama`. Explicit model deny decisions do not fall back.

Relevant env vars:

```text
LLM_PROVIDER=ollama
LLM_FALLBACK_PROVIDER=ollama
CODEX_APP_SERVER_COMMAND=codex
CODEX_APP_SERVER_ARGS=app-server,--listen,stdio://
CODEX_HOME=/mnt/codex-home
PROVIDER_AUTH_HOME=/mnt/provider-auth
CODEX_AUTH_ISSUER=https://auth.openai.com
CODEX_LOGIN_CLIENT_ID=app_EMoamEEZ73f0CkXaXp7hrann
CODEX_DEVICE_LOGIN_TTL_MS=900000
CODEX_MODEL=gpt-5.1-codex
CODEX_MODEL_PROVIDER=openai
LLM_RUNTIME_CONTEXT_BUDGET_TOKENS=2000
LLM_CONTEXT_COMPRESSION_THRESHOLD_RATIO=0.75
LLM_GENERAL_MAX_OUTPUT_TOKENS=160
LLM_ROUTE_MAX_OUTPUT_TOKENS=256
```

Bootstrap superadmin direct-chat commands for LLM provider operations:

```text
/llm-login codex
/llm-logout codex
/llm-use
/llm-status
```

`/llm-login codex` starts a Codex device login in direct chat for the bootstrap superadmin. The reply includes a verification URL, one-time user code, and quick replies for `/llm-status` and `/llm-use codex`. Successful login writes Codex account state to the configured `CODEX_HOME`; no public callback route, PostgreSQL token row, or LINE push message is used. `/llm-use` reports the active provider and the provider names accepted by the runtime.

Keyword fallback is intentionally narrow:

- `find_ppt_slides`: `投影片`, `ppt`, `powerpoint`, `slides`
- `query_service_schedule`: `服事表`, `服事`
- `find_pop_sheet_music`: `流行歌譜`, `流行歌曲樂譜`, `樂譜`, `歌譜`, `sheet music`

Keyword fallback does not treat `詩歌` or `流行歌` alone as PPT requests. PPT fuzzy matching happens inside `find_ppt_slides`; for example, `奇易恩點` can match `奇異恩典.pptx`.

For sheet music requests, Ollama can extract the song title, optional artist, requested file type, and fuzzy/exact match preference. Keyword fallback stays conservative and only routes requests that explicitly mention sheet music wording.

Router behavior is guarded by a deterministic offline eval corpus in each function module. Run `pnpm eval:router` for CI-safe keyword fallback checks. Run `pnpm eval:router:ollama` manually when validating a live Ollama model.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

## State

When `generalAgent.enabled=true`, group conversations get a short requester-scoped follow-up window. If one user has just addressed the bot, that same user can send the next related message without repeating the wake word. Other group members do not inherit that window.

When `longRunningJobs.enabled=true`, slow text turns race against `inlineReplyTimeoutMs`. If the turn is still running, the bot replies with a Quick Reply postback to check the result later. The stored result is scoped by profile, LINE source, and requester user id, and should use Redis in production.

Multi-result PPT and sheet music searches store short-lived in-memory sessions and reply with LINE postback Quick Replies. Users can also reply with a plain number such as `1` to select from the latest active candidate list for the same profile, LINE source, and requester. Numeric replies without an active selection session are ignored instead of being routed or answered.

If a PPT or sheet music request is missing the title keyword, the bot stores a short-lived pending function session and asks for the missing title. The user's next plain-text reply from the same LINE source and requester fills the missing `query` argument and runs the original function.

If a service schedule request is too generic, such as `查服事表`, the bot asks which range to use and offers Quick Replies for `下一場`, `本週`, `明天`, and `主日`.

## Agent Runtime And Memory

The agent turn runtime centralizes natural-language task execution after LINE entrance checks. It handles pre-route memory follow-ups, pending text sessions, admin natural-language actions, routing, missing-slot clarification, memory aliases, in-flight duplicate locks, function execution, and sanitized turn traces.

This keeps new functions on a consistent contract: define the capability, normalize arguments, add any required slots, register the handler, and let the runtime apply the shared safety rails.

The memory layer adds controlled memory without making the bot an unrestricted chat recorder.

- Recent PPT and sheet music results store only resource metadata: profile, LINE scope, requester, file title, Graph drive id, and item id.
- Users can explicitly ask the bot to remember an external PPT or sheet-music link. These are saved as scoped resource memories and can be found by the same PPT/sheet-music lookup functions.
- Temporary sharing links are never stored. When a user asks for the previous one again, the bot creates a fresh 24 hour Graph link.
- External links are stored as user-provided links. The bot does not verify whether those links remain accessible.
- Recent-result recall is requester-scoped. In a group, another user cannot accidentally recall someone else's latest result.
- Resource aliases are scope-scoped. A user can say `以後 X 就用這份` after a successful result, and the bot will try that alias before doing a folder search in the same group or direct chat.
- Text memories are saved only when the user clearly asks the bot to remember, save, or store content. Normal group chatter is not saved.
- Text memories currently expire after 30 days.
- LINE image/file attachment saving is not implemented in this version. Ask the bot to remember a title plus URL instead.

Useful memory commands:

```text
/memories
/forget-memory <id>
/memory-status
```

`/memories` and `/forget-memory <id>` work in the current LINE scope. `/memory-status` is admin-only.
`/memories` lists both text memories and resource memories. `/forget-memory <id>` can remove either kind.

The first version is single-instance friendly. If the Container App scales beyond one replica or restarts, pending selections can expire; use Redis or another shared store before enabling multiple replicas.

Set `REDIS_URL` to move sessions, cache, recent errors, rate-limit state, conversation windows, and long-running job results to Redis. If `REDIS_URL` is unset, the app uses in-memory stores. If `REDIS_URL` is set but Redis cannot connect, startup fails.

Set `DATABASE_URL` to persist access state and agent memory. If PostgreSQL is configured, the app creates both access tables and agent memory tables on startup. Agent resource storage supports Graph file metadata and user-provided external links. If PostgreSQL is missing, agent memory falls back to in-memory and is lost on restart.

Sheet music search uses a short-lived in-memory file index cache. Admins can clear it from a direct LINE chat:

```text
/refresh-sheet-music-cache
```

Admin commands use slash syntax and are gated by each profile's bootstrap `adminUserId` or DB-managed admin principals. `/help` lists public commands and enabled functions. `/help admin` lists common admin commands by group, and `/help admin all` includes advanced and diagnostic commands.

Admins can also use natural language for selected admin actions. For example, an admin can ask the bot to create an invite code, list web allowlist entries, add a website to the allowlist, or manage a group's function scope. Invite-code and web allowlist natural language are direct-chat only. Function scope grant/revoke/list is the only group natural-language exception, and only when an admin clearly asks to manage the current group.

`/registry <code>` remains a deterministic slash command and is not routed through the LLM. Admin natural-language requests pass through a conservative local hint check, the admin action router, the policy gate, and the admin action registry. `/last-routes` records sanitized admin route/action outcomes without raw message text or invite codes. Use `pnpm eval:admin` when changing admin intent hints or adding admin actions.

Destructive admin actions must be confirmed with `/confirm <code>`. Invite-code creation is a `security_change` action and remains admin direct-chat only plus audited, but does not require confirmation.

Controlled web allowlist commands are admin direct-chat commands. Admins can also add/list web allowlist entries with direct-chat natural language. They prepare safe, profile-scoped web lookup by allowing only HTTPS domains and optional path prefixes. Private-network and localhost targets are still denied by code-level guardrails.

```text
/web-allowlist
/web-allowlist-add <domain> [pathPrefix]
/web-allowlist-enable <id>
/web-allowlist-disable <id>
/web-allowlist-remove <id>
```

Common commands:

```text
/help
/registry <code>
/whoami
/memories
/forget-memory <id>
/access-list [user|group|admin]
/user-remove <userId>
/group-remove [groupId]
/function-grant <functionName> [groupId]
/function-revoke <functionName> [groupId]
/function-scopes [groupId]
/audit-list [limit]
/web-allowlist
```

Advanced commands:

```text
/user-add <userId> [name]
/group-add <groupId> [name]
/invite-code-create
/confirm <code>
/admin-add <userId>
/admin-remove <userId>
/status
/profile
/diag
/route-test <text>
/last-errors
/last-routes
/last-agent-turns [limit]
/memory-status
/llm-login
/llm-logout
/web-allowlist-add <domain> [pathPrefix]
/web-allowlist-enable <id>
/web-allowlist-disable <id>
/web-allowlist-remove <id>
```

Registered function modules may add more admin commands, such as `/llm-status`, `/functions`, `/sessions`, `/cache`, `/clear-sessions`, and `/refresh-sheet-music-cache`. `/route-test <text>` reports the selected provider, action, arguments, and any fallback reason. `/last-routes` reports recent sanitized route/function outcomes, including whether a query was present, without echoing the raw query. `/last-agent-turns` shows the latest sanitized agent runtime phases so admins can debug whether a request stopped at memory, clarification, routing, in-flight locking, or function execution.

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

- `BOT_PROFILES_BASE64_JSON` preferred, or `BOT_PROFILES_JSON` for local/dev
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

When Redis is configured, rate limits use atomic Redis counters. Recent routes and errors are sanitized before storage and do not include raw user text, function queries, invite codes, LINE reply tokens, credential URLs, or secrets.

## Smoke Testing

Use the signed webhook smoke tool for local or deployed webhook checks:

```powershell
pnpm smoke:webhook -- --url http://localhost:3000/api/line/webhook/helper --secret PLACEHOLDER_LINE_CHANNEL_SECRET --text "小哈"
```

Operational details are in `docs/runbooks/production-operations.md`.

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
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:router
pnpm eval:admin
pnpm build
```

Optional live local-model check:

```powershell
pnpm eval:router:ollama
```

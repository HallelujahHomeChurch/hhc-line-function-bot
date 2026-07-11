# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to local-first functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile access policy, wake words, message type filtering, and function toggles.
- Function router that uses Ollama `qwen3:4b-instruct` by default, with optional DeepSeek API key provider support.
- Action catalog that separates user functions, admin actions, and system actions.
- Policy gate and admin action registry for natural-language admin operations.
- Conservative keyword fallback when Ollama times out, is unreachable, or returns invalid JSON.
- LINE Quick Reply suggestions for clarification and result selection.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Definition-driven clarification state for missing slots. A generic capability request such as `查投影片`, `查流行歌譜`, `查維基百科`, or `查服事表` never runs a lookup; the bot asks for the missing value first.
- Friendly intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts without exposing internal function names or backing services.
- Controlled agent turn runtime for routing, slot clarification, in-flight locks, recent file recall, and explicit text/resource memories.
- Requester-scoped short conversation windows, so group follow-up messages can continue naturally without letting other users inherit context.
- Long-running task handoff: slow turns can reply with a "check result" postback instead of using LINE push quota.
- Free Wikipedia-only lookup: Chinese Wikipedia first, English fallback, then source-bounded summary generation.
- Catalog-driven resource search foundation: OneDrive-style sources can be registered as catalog sources and indexed into a unified item table abstraction. User-facing lookup functions do not expose whether data came from OneDrive, Notion, PostgreSQL, or a future source.
- Optional Redis backend for sessions, cache, recent errors, rate limiting, and one-time registration invite codes.
- Per-profile access policy with PostgreSQL-backed user/group/admin registration.
- Public `/help`, `/registry <code>`, and `/whoami` commands.
- Direct-chat admin commands for a single bootstrap `adminUserId` plus DB-managed admins.
- Admin natural language for selected management actions: invite-code creation and group function scope management.
- Minimal `/healthz`, data-layer `/readyz`, and admin-only `/diag` diagnostics.
- Destructive admin-action confirmation infrastructure through `/confirm <code>`.
- Function handlers:
  - `find_ppt_slides`: searches a configured presentation folder, fuzzy-matches `.pptx`, `.ppt`, `.key`, and `.odp` names, and returns 24 hour sharing links.
  - `query_schedule`: one user-facing service-schedule query that selects configured sources without exposing them.
  - `find_sheet_music`: canonical sheet-music lookup for configured pop and hymn sheet sources. `find_pop_sheet_music` remains an internal legacy alias only.
  - `find_resource`: generic authorized church catalog lookup for non-schedule, non-slide, non-sheet-music resources such as future weekly report audio.
  - `query_wikipedia`: reads a matching Wikipedia introduction and returns a source-bounded summary.
  - `save_schedule`: previews and manages the helper profile's shared canonical text-only service schedules with one-year retention.

The helper production profile enables only the controlled church lookup functions and structured schedule management. Generic text/resource memory functions remain internal modules but are not enabled for ordinary helper conversations.

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

Production profiles are configured by the checked-in [`config/profiles.json`](config/profiles.json) file. The image loads it through `PROFILE_CONFIG_PATH=/app/config/profiles.json`; its root is always a JSON array, even when only one profile is active.

`BOT_PROFILES_JSON` is a local/test override only. Production rejects both it and `BOT_PROFILES_BASE64_JSON`, so profile personality and function policy cannot drift through an ACA secret edit.

Each profile controls:

- LINE channel secret and access token, preferably through env references.
- Webhook path. It must be the canonical `/api/line/webhook/{profileName}` path.
- Direct and group access policy.
- Optional registration flow.
- Wake keywords and mention handling.
- Enabled functions.
- Single bootstrap superadmin user id.

The checked-in [`config/profiles.json`](config/profiles.json) is the sole complete
production example and source of truth. It deliberately contains only the currently
provisioned `helper` profile. Add another profile only after its separate LINE
credential secret references have been provisioned in ACA and `pnpm config:validate`
passes.
Profile names must use lowercase letters, numbers, dash, or underscore. The `webhookPath` must match the profile name exactly; for example, profile `helper` must use `/api/line/webhook/helper`.

Use `adminUserIdEnv` for the single bootstrap superadmin in production. `channelSecretEnv`, `channelAccessTokenEnv`, and `adminUserIdEnv` resolve from ACA secrets at startup. Direct `channelSecret`, `channelAccessToken`, and `adminUserId` are local/test-only. LLM small-talk profiles must configure all four `smallTalk.prompting` layers in `config/profiles.json`; the runtime does not supply a helper-specific persona or safety fallback. Legacy `adminUserIds`, `allowedUserIds`, and `allowedGroupIds` are rejected.

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
- Direct users can use profile-global read functions plus DB-managed grants for the same `profileName/userId`.
- Groups can use profile-global read functions plus DB-managed grants for the same `profileName/groupId` and grants for the requester `profileName/userId`.
- Group grants are additive. To make a function group-only, remove it from `enabledFunctions` and grant it to selected groups.
- Admin actions are not `enabledFunctions` and cannot be granted to groups. They are gated separately by admin identity, source policy, and audit rules.

## Routing

Provider selection is lane-based. Function routing, admin routing, and memory routing default to local Ollama so routine JSON classification stays cheap. Smart talk and future higher-value generation lanes such as `general_agent` and `context_compression` default to DeepSeek when the current profile explicitly allows `deepseek`; otherwise they stay on Ollama.

The DeepSeek provider calls the OpenAI-compatible `/chat/completions` API with `DEEPSEEK_API_KEY`; it does not require provider login routes, mounted auth state, or PostgreSQL token storage.

Provider access is profile-scoped. Internal helper profiles may explicitly list `deepseek` in `allowedProviders`. Future official `main` profiles can stay on `ollama` or define their own allowed providers.

Each profile can override lane policy with `providerPolicy`. For example, the internal helper profile can keep `function_routing`, `admin_routing`, and `memory_routing` on `ollama`, while using `deepseek -> ollama` for `smart_talk` and `general_agent`.

If a lane's primary provider returns invalid JSON, times out, or is unavailable, the lane can fall back to its configured fallback provider. Function routing can still fall back to conservative keyword routing after model failures. Explicit model deny decisions do not fall back. Remote API small talk is bounded by `LLM_GENERAL_MAX_OUTPUT_TOKENS` rather than the local Ollama 80-character fallback limit.

Relevant env vars:

```text
LLM_PROVIDER=ollama
LLM_FALLBACK_PROVIDER=ollama
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=8000
LLM_RUNTIME_CONTEXT_BUDGET_TOKENS=2000
LLM_CONTEXT_COMPRESSION_THRESHOLD_RATIO=0.75
LLM_GENERAL_MAX_OUTPUT_TOKENS=160
LLM_ROUTE_MAX_OUTPUT_TOKENS=256
```

Bootstrap superadmin direct-chat commands for LLM provider operations:

```text
/llm-use
/llm-status
```

`/llm-use` reports the active legacy default provider and the provider names accepted by the current profile. `/llm-status` reports the current profile's lane policy. Provider selection is controlled by profile/env configuration; LINE commands do not persist provider changes.

Keyword fallback is intentionally narrow:

- `find_ppt_slides`: `投影片`, `ppt`, `powerpoint`, `slides`, `keynote`, `odp`
- `query_schedule`: `服事表`, `服事`
- `find_sheet_music`: `流行歌譜`, `詩歌歌譜`, `樂譜`, `歌譜`, `sheet music`
- `find_resource`: `教會資料`, `小哈資料庫`, and explicit catalog aliases such as `週報音檔`
- `save_schedule`: `記住晨更`, `記住舉牌`, or pasted text schedules with date rows.

Keyword fallback does not treat `詩歌` or `流行歌` alone as PPT requests. PPT fuzzy matching happens inside `find_ppt_slides`; for example, `奇易恩點` can match `奇異恩典.pptx`.

For sheet music requests, Ollama can extract the song title, optional artist, requested file type, and fuzzy/exact match preference. Keyword fallback stays conservative and only routes requests that explicitly mention sheet music wording.

The shared query-domain resolver runs before keyword fallback and guards model output when the user names an explicit domain. For example, `查維基百科` with no topic asks for the missing topic instead of letting a model invent one, and `查週報音檔` resolves to internal catalog search rather than Wikipedia when `find_resource` is enabled.

Router behavior is guarded by a deterministic offline eval corpus in each function module. Run `pnpm eval:router` for CI-safe keyword fallback checks. Run `pnpm eval:router:ollama` manually when validating a live Ollama model.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

## State

When `generalAgent.enabled=true`, group conversations get a short requester-scoped follow-up window. The default is 60 seconds. If one user has just addressed the bot, that same user can send the next related message without repeating the wake word. Each handled reply records the latest turn and refreshes the window. Other group members do not inherit that window.

When `longRunningJobs.enabled=true`, slow text turns race against `inlineReplyTimeoutMs`. If the turn is still running, the bot replies with a Quick Reply postback to check the result later. The stored result is scoped by profile, LINE source, and requester user id, and should use Redis in production.

Multi-result PPT and sheet music searches store short-lived in-memory sessions and reply with LINE postback Quick Replies. Users can also reply with a plain number such as `1` to select from the latest active candidate list for the same profile, LINE source, and requester. Numeric replies without an active selection session are ignored instead of being routed or answered.

If a PPT or sheet music request is missing the title keyword, the bot stores a short-lived pending function session and asks for the missing title. The user's next plain-text reply from the same LINE source and requester fills the missing `query` argument and runs the original function.

If a request only selects a capability—such as `查投影片`, `查流行歌譜`, `查維基百科`, or `查服事表`—the bot asks for the required title, topic, date, meeting, or schedule type before any lookup runs. This rule is declared on the function's required slot, so it also overrides a model-inferred query that the user did not supply.

## Catalog Sources

Catalog source config is deployment-owned in v1. Set `CATALOG_SOURCES_PATH` to a JSON file containing source registrations. Each source includes `profileName`, `sourceKey`, `adapterType`, `domain`, `defaultItemKind`, `rootLocation`, `enabled`, `syncPolicy`, and read/write capability names. The app validates that every source references an existing profile. The committed [`config/catalog-sources.json`](config/catalog-sources.json) uses `rootLocation` environment references such as `driveIdEnv` and `folderItemIdEnv`; do not commit real drive IDs or folder IDs. [`config/catalog-sources.example.json`](config/catalog-sources.example.json) remains a placeholder-only shape reference.

`catalog_sources` and `catalog_items` are created automatically when `DATABASE_URL` is configured; local single-process development falls back to the in-memory catalog store. Item kinds are data values, not a closed TypeScript enum. Existing values include `ppt_slide`, `pop_sheet`, `hymn_sheet`, `church_document`, `church_image`, and `church_other`; a future folder such as weekly report audio can add `weekly_report_audio` by source config plus resolver aliases without schema changes.

Binary files are not stored in PostgreSQL by this abstraction. Catalog items store metadata and a storage reference. Temporary Graph sharing links are generated only when replying to a lookup result.

The `xiaoha_database` source is a manual catalog source used for LINE attachment saves. It writes accepted files to OneDrive subfolders (`文件`, `圖片`, `其他`) and immediately upserts metadata into `catalog_items`; the scheduled sync job skips it. Items saved to this source receive a 90-day `expiresAt`. Formal synced sources such as slides, sheet music, service schedules, and future weekly report audio do not receive this TTL.

Run a catalog sync locally with:

```powershell
pnpm catalog:sync
```

Production should run the same built image as an ACA Scheduled Job with a different command. [`aca.catalog-sync-job.yaml`](aca.catalog-sync-job.yaml) is the placeholder-only job manifest:

```text
node dist/tools/sync-catalog.js
```

The webhook service should stay on `node dist/index.js`; do not run recurring sync work inside the long-lived LINE webhook process.

## Agent Runtime And Memory

The agent turn runtime centralizes natural-language task execution after LINE entrance checks. It handles pre-route resource recall, pending text sessions, admin natural-language actions, routing, missing-slot clarification, in-flight duplicate locks, function execution, and sanitized turn traces.

This keeps new functions on a consistent contract: define the capability, normalize arguments, add any required slots, register the handler, and let the runtime apply the shared safety rails.

The memory layer adds controlled memory without making the bot an unrestricted chat recorder. Explicit group memories are private to the requester by default; group sharing must be explicit. Writes are confirmed and audited, owner/admin deletion is enforced, and expired records are physically purged.

- Recent PPT and sheet music results store only resource metadata: profile, LINE scope, requester, file title, Graph drive id, and item id.
- This automatic resource metadata is a controlled read-function exception for recall and aliasing. It is not the same as a user explicitly asking the bot to remember or save content.
- Users can explicitly ask the bot to remember an external PPT or sheet-music link. These are saved as scoped resource memories and can be found by the same PPT/sheet-music lookup functions.
- Temporary sharing links are never stored. When a user asks for the previous one again, the bot creates a fresh 24 hour Graph link.
- External links are stored as user-provided links. The bot does not verify whether those links remain accessible.
- Recent-result recall is requester-scoped. In a group, another user cannot accidentally recall someone else's latest result.
- Resource aliases are scope-scoped. A user can say `以後 X 就用這份` after a successful result, and the bot will try that alias before doing a folder search in the same group or direct chat.
- Text memories are saved only when the user clearly asks the bot to remember, save, or store content. Normal group chatter is not saved.
- Structured schedule memories are separate from plain text memories. They store a schedule header plus date-based entries, are shared across the helper profile, and expire after one year.
- Saving another schedule of the same type and month replaces the previous canonical schedule after confirmation. Entry add, update, delete, and whole-schedule delete use the same preview-and-confirm flow.
- Queries such as `下次世緯家園服事是什麼時候？` and `下一次中平家族什麼時候舉牌？` search these shared entries. Identity-based `我下一次服事是什麼時候？` remains out of scope until LINE identity is bound to the church login system.
- Structured schedule memory is text-only in this version. The bot should ask for pasted text instead of trying to store or parse schedule images.
- Text memories currently expire after 30 days.
- LINE image/file attachment saving is supported only through the controlled `save_resource` flow. The requester must have effective `save_resource` permission, explain the purpose, pass file validation and virus scanning, then confirm before the bot uploads to OneDrive and upserts catalog metadata.

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

Admins can also use natural language for selected admin actions: invite-code creation and function-scope management. Invite-code creation is direct-chat only. Function scope grant/revoke/list is the only group natural-language exception, and only when an admin clearly asks to manage the current group.

`/registry <code>` remains a deterministic slash command and is not routed through the LLM. Admin natural-language requests pass through a conservative local hint check, the admin action router, the policy gate, and the admin action registry. `/last-routes` records sanitized admin route/action outcomes without raw message text or invite codes. Use `pnpm eval:admin` when changing admin intent hints or adding admin actions.

Destructive admin actions must be confirmed with `/confirm <code>`. Invite-code creation is a `security_change` action and remains admin direct-chat only plus audited, but does not require confirmation.

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
/function-user-grant <functionName> <userId>
/function-user-revoke <functionName> <userId>
/function-user-scopes <userId>
/audit-list [limit]
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
/llm-use
```

Registered function modules may add more admin commands, such as `/llm-status`, `/functions`, `/sessions`, `/cache`, `/clear-sessions`, and `/refresh-sheet-music-cache`. `/route-test <text>` reports the selected provider, action, arguments, and any fallback reason. `/last-routes` reports recent sanitized route/function outcomes, including whether a query was present, without echoing the raw query. `/last-agent-turns` shows the latest sanitized agent runtime phases so admins can debug whether a request stopped at memory, clarification, routing, in-flight locking, or function execution.

## OneDrive And Graph

Graph access uses app-only Microsoft 365 auth. Configure the main drive id and folder ids/paths through env vars:

- `GRAPH_DRIVE_ID`
- `GRAPH_PPT_FOLDER_ITEM_ID`
- `GRAPH_POP_SHEET_FOLDER_ITEM_ID`
- `GRAPH_HYMN_SHEET_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID`
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

The production catalog sync job also registers the media team service schedule as a Notion `schedule` source and writes rows into the PostgreSQL `schedule_items` read model. `query_schedule` checks that read model before any live Notion fallback, so users only ask for a service schedule; they never need to choose Notion or PostgreSQL. LINE-created schedules remain separate write-controlled schedule records and do not write back to Notion.

## LINE Attachment Save Gate

Production profiles still allow text messages only unless `allowedMessageTypes` is explicitly expanded. When a profile allows `image` or `file`, the webhook does not immediately download, upload, or save the attachment. It first requires effective `save_resource` permission, stores a requester/source-scoped pending attachment session, and asks the user to explain the intended category or purpose.

After the requester replies with a supported purpose, the bot downloads the LINE content, checks size, MIME/magic bytes, extension, safe filename, hash, target source write capability, and virus scan status. If the scanner is missing, times out, or returns anything other than `clean`, the save fails closed. A clean file is previewed and still requires the user to reply `保存` before upload. Only after confirmation does the bot upload to the configured OneDrive folder and write catalog metadata.

Supported attachment targets in this flow:

- `投影片`: writes to the `ppt_slides` OneDrive root and indexes `ppt_slide`.
- `流行歌譜`: writes to the `pop_sheet_music` OneDrive root and indexes `pop_sheet`.
- `詩歌歌譜`: writes to the `hymn_sheet_music` OneDrive root and indexes `hymn_sheet`.
- `小哈資料庫` / `教會資料`: writes to `xiaoha_database` subfolders and indexes `church_document`, `church_image`, or `church_other` with 90-day retention.

Set `VIRUS_SCAN_ENDPOINT` to enable attachment publishing. The endpoint receives a JSON payload with file metadata plus `dataBase64` and must reply with `{"status":"clean"}` or `{"status":"infected"}`. If `VIRUS_SCAN_ENDPOINT` is unset, attachment publishing is intentionally unavailable.

## Runtime Secrets

Do not commit real `.env` files. In Azure Container Apps, store only real credentials in ACA secrets:

- `LINE_HELPER_CHANNEL_SECRET`, `LINE_HELPER_CHANNEL_ACCESS_TOKEN`, and `LINE_HELPER_ADMIN_USER_ID`
- `OLLAMA_BASE_URL`
- `DEEPSEEK_API_KEY`
- `DATABASE_URL` and `REDIS_URL`
- `NOTION_TOKEN`
- `GRAPH_CLIENT_SECRET`
- `VIRUS_SCAN_API_KEY` if the configured scanner endpoint requires one

`config/profiles.json` is intentionally non-sensitive and is packaged in the image. Do not create or update `BOT_PROFILES_BASE64_JSON` in production.

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

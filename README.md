# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to controlled functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile access policy, wake words, message type filtering, and function toggles.
- LangChain/LangGraph tool-calling agent for `helper`, using DeepSeek as its sole model; the public `main` profile remains provider-free.
- Action catalog that separates user functions, admin actions, and system actions.
- Policy gate and admin action registry for natural-language admin operations.
- Server-owned tool allowlists, live Account authorization, strict schemas, and existing write confirmations around every helper tool call.
- LINE Quick Reply suggestions for clarification and result selection.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Server-owned latest defaults and focused clarification only for genuine ambiguity or missing business input.
- Friendly intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts without exposing internal function names or backing services.
- Requester-scoped helper checkpoints plus explicit text/resource memories and typed domain handlers.
- Requester-scoped short conversation windows, so group follow-up messages can continue naturally without letting other users inherit context.
- Long-running task handoff: slow turns can reply with a "check result" postback instead of using LINE push quota.
- Free Wikipedia-only lookup: Chinese Wikipedia first, English fallback, then source-bounded summary generation.
- Catalog-driven resource search foundation: OneDrive-style sources can be registered as catalog sources and indexed into a unified item table abstraction. User-facing lookup functions do not expose whether data came from OneDrive, Notion, PostgreSQL, or a future source.
- Optional Redis backend for sessions, cache, recent errors, rate limiting, and one-time registration invite codes.
- Per-profile access policy with PostgreSQL-backed user/group registration.
- Shared public help (`/help`, `幫助`, `說明`, `功能`, `可以做什麼`), account identity, and login surfaces.
- Direct-chat admin commands authorized by the linked HHC account and Account roles.
- HHC account linking from the exact direct-chat phrases `登入`, `登入帳戶`, `登入 HHC 帳戶`, `連結帳戶`, `綁定帳戶`, or `login`; signed completion messages and the rollback-only LINE `accountLink` event finalize locally without entering the LLM router.
- Admin natural language for selected management actions such as invite-code creation.
- Minimal `/healthz`, data-layer `/readyz`, and admin-only `/diag` diagnostics.
- Destructive admin-action confirmation infrastructure through `/confirm <code>`.
- Function handlers:
  - `find_ppt_slides`: searches a configured presentation folder, fuzzy-matches `.pptx`, `.ppt`, `.key`, and `.odp` names, and returns 24 hour sharing links.
  - `download_weekly_paper`: returns a LINE download action for the latest or an explicitly numbered public Weekly Paper through the fixed HHC web API boundary.
  - `update_own_profile`: collects first and last name in direct chat, previews them, and updates only the linked caller's HHC Account after explicit confirmation.
  - `query_schedule`: one user-facing service-schedule query that selects configured sources without exposing them.
  - `query_knowledge`: searches admin-registered, profile-shared Notion knowledge with grounded hybrid retrieval.
  - `find_sheet_music`: canonical sheet-music lookup for configured pop and hymn sheet sources.
  - `find_resource`: generic authorized church catalog lookup for non-schedule, non-slide, non-sheet-music resources such as future weekly report audio.
  - `query_wikipedia`: reads a matching Wikipedia introduction and returns a source-bounded summary.
  - `save_schedule`: previews and manages the helper profile's shared canonical text-only service schedules with one-year retention.
  - `save_resource`: validates, scans, confirms, publishes, and indexes authorized LINE attachments.

The helper production profile enables the controlled church lookup functions, structured schedule management, `retrieve_memory`, and write-gated `save_memory`/`save_resource`. Registered sources receive profile-global reads. A configured write outside that public read projection requires the same Account response to report `administrator: true`; a function explicitly listed in `permissionRequiredFunctions` instead requires its name in Account `allowedFunctions`. Local grant and role-capability rows no longer expand effective functions.

Disabled, unknown, unclear, or explicitly denied actions are denied. There is no Azure OpenAI chat fallback in this version.

## Architecture

The service is one modular monolith. `src/transport/line/webhook-routes.ts` owns signed LINE ingress, access, commands, postbacks, and exceptional deterministic workflows. `src/runtime/profile-runtime.ts` selects exactly one profile runtime: `src/helper-agent/runtime.ts` for helper or `src/runtime/main-runtime.ts` for provider-free main.

Helper uses one LangChain `createAgent` composition in `src/helper-agent/agent.ts`. `src/helper-agent/state.ts` owns checkpoint scope and lifetime; `src/helper-agent/policy-gateway.ts` owns strict validation and live authorization; `src/runtime/action-executor.ts` owns side effects. Capability metadata lives in `src/capabilities/catalog.ts`. Attachment intake remains isolated in `src/transport/line/attachment-intake.ts`.

Run `pnpm architecture:check` to enforce dependency direction. Production construction requires PostgreSQL and Redis and never silently falls back to in-memory stores; tests use explicit builders under `src/testing`.

## Local Setup

```powershell
pnpm install
Copy-Item .env.example .env
# Edit .env with real local values. Do not commit it.
pnpm dev
```

Set the LINE webhook URL per bot profile, for example:

- `/api/line/webhook/helper`
- `/api/line/webhook/main`
- `/api/line/webhook/slides`

Provider auth callbacks are not exposed by this service. LINE webhook traffic should only use the canonical profile paths above.

Local development starts only the webhook service. Semantic generation and
embeddings use the configured remote providers; external search and attachment
scanning are production ACA workloads, not workstation services.

In production, the public API Gateway forwards those webhook paths through Dapr service invocation to app id `hhc-line-function-bot`. The bot Container App therefore keeps Dapr enabled on HTTP app port 3000 while its own ingress remains internal.

The consent-only sheet-music fallback uses the separate `hhc-searxng` Container App with `0.25` CPU and `0.5Gi` memory. Its ingress is internal-only; the release script deploys it before the bot and supplies `SEARXNG_BASE_URL` from its ACA internal FQDN. Do not configure production with an office-network or public SearXNG endpoint.

Health and readiness:

```text
GET /healthz
GET /readyz
```

`/healthz` is minimal liveness. `/readyz` checks only Postgres and Redis. Use admin direct-chat `/diag` for detailed dependency status.

## Bot Profiles

Production profiles are configured by the checked-in [`config/profiles.json`](config/profiles.json) file. The image loads it through `PROFILE_CONFIG_PATH=/app/config/profiles.json`; its root is always a JSON array, even when only one profile is active.

`PROFILE_CONFIG_PATH` is the only supported profile source. Legacy `BOT_PROFILES_JSON` and `BOT_PROFILES_BASE64_JSON` are rejected in every environment, so profile personality and function policy cannot drift through an env var or ACA secret edit.

Each profile controls:

- LINE channel secret and access token, preferably through env references.
- Webhook path. It must be the canonical `/api/line/webhook/{profileName}` path.
- Direct and group access policy.
- Optional registration flow.
- Wake keywords and mention handling.
- Enabled functions.
- Optional HHC Account presentation and the permission-required subset of enabled functions.
- HHC account binding for administrator authorization.

The checked-in [`config/profiles.json`](config/profiles.json) is the sole complete
production example and source of truth. It contains the managed `helper` and public
direct-only `main` profiles; each has separate LINE credential secret references.
Provision both credential pairs in ACA before deployment and require
`pnpm config:validate` to pass.
Profile names must use lowercase letters, numbers, dash, or underscore. The `webhookPath` must match the profile name exactly; for example, profile `helper` must use `/api/line/webhook/helper`.

`channelSecretEnv` and `channelAccessTokenEnv` resolve LINE credentials from ACA secrets at startup. Admin authorization is not profile configuration: the bot calls account-api through Dapr and trusts the linked account's `admin` role. The helper profile loads its checked-in [`PERSONA.md`](config/agents/helper/PERSONA.md) and [`MEMORY.md`](config/agents/helper/MEMORY.md) through restricted profile-relative paths. These files define behavior and memory policy only; runtime conversation and saved memory never write back to them. Legacy LINE admin settings and static allowlists are rejected.

`accountLink` keeps only public display copy plus environment references in the
profile file. The bot runtime resolves each canonical `@` LINE account ID and
the shared LINE Developers Provider ID; account-link-enabled profiles with
different Provider IDs fail startup. These identifiers are injected only into
the bot container, not attachment, catalog, probe, or assurance jobs.
Production profiles also declare `permissionRequiredFunctions` explicitly; it
must contain unique known functions and remain a subset of `enabledFunctions`.

## Access Control

Profiles can choose separate policies for direct chat and groups:

- `directAccessPolicy: "managed"`: registered DB users and Account-authorized admins can use functions. If `registration.enabled=true`, unknown direct users receive a registration prompt.
- `directAccessPolicy: "public"`: any direct user can use the profile. The official `main` profile uses this direct-only policy.
- `directAccessPolicy: "blocked"`: direct users are blocked except slash diagnostics such as `/whoami` and admin authorization checks.
- `groupAccessPolicy: "managed"`: groups must be added through DB access management.
- `groupAccessPolicy: "blocked"`: group events are ignored.

Registration is profile-scoped. The current intended split is:

- `helper`: managed direct users, managed groups, invite-code registration enabled.
- `main`: public direct users, groups blocked, registration disabled, and provider-free, with Weekly Paper download plus Account-authorized `/profile` name updates.

Users and groups register with the same command:

```text
/registry <code>
```

Admins create one-time invite codes with `/invite-code-create`. The reply includes a standalone `/registry <code>` line that can be copied to a user or group. When the code is used within its TTL, the direct user or current group is opened immediately. Display names are resolved through the LINE SDK; users should not type names into the registration command.

An already registered `helper` group can bind its assigned media collection with the Admin Console's
one-time code: `/media-sync <code>`. The binding code expires after 60 minutes and is consumed only
when the atomic group-to-collection binding succeeds.

After registration commits, the bot recomputes the new user or group's effective access and offers up to three deterministic, currently authorized read examples as LINE Quick Replies. The preferred order is the next service schedule, sheet music, then presentation slides; unavailable reads are replaced by the next authorized read. Registration replies never print the LINE user or group ID.

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
- Ordinary users receive profile-global read functions that do not require Account permission.
- `permissionRequiredFunctions` is the explicitly Account-granted subset of `enabledFunctions`; Account must return its names in `allowedFunctions` even for administrators. A configured write omitted from the public effective projection is available only when the same Account response reports `administrator: true`. Only the currently requested restricted tools or pending continuations are sent to Account API, and denied or unavailable permissions fail closed before handler execution.
- `main/update_own_profile` is the single self-service exception: Account resolves the caller's bound LINE identity and active state at confirmation, and accepts only first/last-name updates. It is not an RBAC permission.
- Access principals and group registration still authorize the LINE source. Historical user/group grant and role-capability tables remain for rollback compatibility but do not add functions.
- The retired `/function-grant`, `/function-user-grant`, revoke/list variants, and matching natural-language actions are hidden or rejected. Function permissions are managed by HHC Account.
- Admin actions are not `enabledFunctions` and cannot be granted to groups. They are gated separately by admin identity, source policy, and audit rules.

The application resolves this authority once and projects the exact effective capability set plus direct-only public account login into `/help`, natural-language capability introduction, and Quick Replies. `/help` lists every currently effective read and write; its command section is source-, registration-, and capability-aware, so group help omits `/whoami` and protected memory commands are hidden unless currently usable. Onboarding Quick Replies are capped at three. Ordinary users never see internal function names or implementation services, and a write is omitted unless it is effective for that requester in that LINE source. Identity-only introduction uses the current profile's configured identity line; helper remains `我是小哈，家教會的小幫手。`

`main` sets `allowedProviders: []` and uses narrow direct handlers without an agent or provider call. It can execute an explicit `download_weekly_paper` request, while one of the exact `/profile`, `修改個人資料`, `修改姓名`, or `更新姓名` intents may enter the shared first-name/last-name collection and preview flow. The profile update rechecks live Account permission at confirmation and never executes from routing alone. Weekly download uses Dapr to call `hhc-web-api`, accepts only the canonical root-relative asset path or its exact `https://www.alive.org.tw` absolute form, and places the validated URL only in a LINE URI action; it is never stored in task state, memory, resource metadata, or reply text.

## Routing

The helper profile has one semantic path: `src/helper-agent/runtime.ts` constructs the effective tool set and invokes the sole LangChain/LangGraph agent in `src/helper-agent/agent.ts`. DeepSeek is the only helper model. The main profile uses `src/runtime/main-runtime.ts` and makes zero model and embedding requests.

LINE ingress validates the signature, profile, access, engagement, commands, postbacks, and deterministic attachment/selection flows before `src/runtime/profile-runtime.ts` dispatches the turn. There is no compatibility agent, semantic fallback, shadow route, generic pending-function engine, or model router.

Helper read tools have separate authority and source types:

- `get_official_schedule`: formal schedules. Omitted date/period means the domain resolves the latest valid canonical schedule.
- `find_presentation`, `find_sheet_music`, and `find_resource`: the latest authorized catalog/provider evidence.
- `search_knowledge`: current promoted knowledge snapshots.
- `search_saved_notes`: only notes visible to this requester/source; a note never becomes an official schedule.
- `query_wikipedia`: the fixed Wikipedia client, without arbitrary web access.

`src/helper-agent/policy-gateway.ts` validates strict arguments, source policy, current capability enablement, and live Account authorization on every call. Typed model evidence is capped at 2,000 characters or 10 records and excludes internal identifiers, URLs, prompts, provider payloads, and temporary links. The transport renders authoritative domain reply data separately.

Helper side effects are proposal tools. LangGraph pauses before execution, LINE shows the server-rendered preview, and opaque requester/source-scoped review state permits approve, reject, or natural revision. Approval is one-shot and `src/runtime/action-executor.ts` rechecks authorization, policy, argument hash, domain revision, idempotency, and durable job state before commit. A committed result is persisted before LINE reply and can be recovered without re-execution if delivery fails.

Thread IDs are HMAC-derived from profile, LINE source, and requester. Direct threads expire after 30 minutes idle; group/room threads after 15 minutes. `/reset` and `忘記這段對話` delete only that requester's current checkpoint. At about 8K input tokens old tool outputs clear while retaining the two newest; at about 16K the same DeepSeek provider creates a bounded summary while retaining six recent messages; at 24K after reduction the run stops and asks the requester to narrow or reset. Normal turns allow four model and four tool calls; consented sheet-music research allows six of each.

A local sheet-music miss may create requester-scoped consent. Only after atomic consent does the helper receive `search_sheet_music_web` and `read_sheet_music_page`; it receives no unrelated write tools. Search returns opaque invocation-local refs, the reader treats bounded public page text as untrusted, and only detected direct PDF/JPEG/PNG candidates can enter the existing import review. The agent and bot process never download the binary. `src/transport/line/attachment-intake.ts`, the durable outbox, finite worker, Asset scan, clean-only publication, and catalog upsert remain the sole attachment path.

`pnpm eval:agent`, `pnpm eval:sdk-agent`, and `pnpm eval:kernel` run the same 17-case deterministic fake-model evaluator. `pnpm eval:sdk-agent --live` is the manual nine-case bounded DeepSeek suite and prints only aggregate case/call/token/latency fields. `pnpm eval:kernel:integration` owns disposable Redis/PostgreSQL dependencies and verifies checkpoint restart, expiry, and cleanup.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

Each profile may declare `schedulePolicy.meetingWindows` with meeting-name aliases and local start/end times, plus `schedulePolicy.domains` for the profile's schedule-domain registry. A domain contract declares its stable key, user-facing name, aliases and routing hints, input schema, canonical or saved-schedule binding, permitted origins and writes, priority, revision, occurrence policy, and freshness behavior. `下一場` uses the shared meeting-window policy across synchronized, saved, and live schedule sources: a same-day meeting is eligible only before its configured end time, so a 16:40 Taipei query does not return that morning's 晨更. Future dates without a configured window remain eligible; unknown same-day times fail closed instead of pretending the meeting is still upcoming.

## State

Redis and PostgreSQL have explicit ownership:

- Redis stores restart-safe requester-scoped sessions, one-shot postbacks, webhook deduplication, research consent, recent errors, rate limits, and long-running/durable review results. Without Redis these guarantees are process-local.
- PostgreSQL stores access/audit, catalog/schedule/knowledge/memory data, the official LangGraph checkpoint, and `agent_sdk_threads` TTL metadata. Helper same-thread execution uses a dedicated PostgreSQL advisory-lock pool.
- Helper checkpoint idle TTL is fixed at 30 minutes for direct chat and 15 minutes for group/room. Cleanup runs every five minutes. Policy/tool-contract changes and explicit reset delete the checkpoint before reuse.
- Long-running and reviewed action results are keyed by opaque ID and can be read only by the same profile, LINE source, and requester.
- Selection and attachment sessions remain narrow deterministic state owned by their transport/capability flows. Schedule ambiguity and helper follow-up remain in the requester checkpoint and require a fresh authorized tool call.

Run the disposable state gate with Docker/Compose available:

```powershell
pnpm eval:kernel:integration
```

## Catalog Sources

`catalog_sources` and `catalog_items` are created automatically when `DATABASE_URL` is configured; local single-process development falls back to the in-memory catalog store. `catalog_sources` is the durable source registry and records publication revision, health, last-attempt/success/failure watermarks, and active item count. Full and delta syncs publish item changes, tombstones, cursor, revision, and health atomically; a failed refresh leaves the prior successful snapshot intact and marks it stale instead of reporting a false not-found. Startup and the catalog sync job run an idempotent seed step from environment-backed roots such as `GRAPH_PPT_FOLDER_ITEM_ID`, `GRAPH_POP_SHEET_FOLDER_ITEM_ID`, and `NOTION_SERVICE_DATABASE_ID`; the seed only creates missing rows and does not overwrite existing DB-owned source state such as `enabled`, `rootLocation`, or capabilities.

Item kinds are data values, not a closed TypeScript enum. Existing values include `ppt_slide`, `pop_sheet`, `hymn_sheet`, `church_document`, `church_image`, and `church_other`; a future folder such as weekly report audio can add `weekly_report_audio` by adding a seed/source row plus resolver aliases without schema changes.

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

`src/helper-agent/runtime.ts` is the only helper runtime. It projects the effective capabilities before entering `src/helper-agent/state.ts`, then builds authority-specific reads, proposal-only writes, or the isolated consented sheet-music research tools. Every protected tool call asks Account again; checkpoint content never grants permission or source freshness.

The checked-in helper `PERSONA.md` and `MEMORY.md` are read-only prompt policy. Runtime conversation stays in short-lived requester checkpoints. Long-term text memory remains explicit, previewed, confirmed, PostgreSQL-backed, and 30-day retained. Group-visible memory requires an authorized requester and explicit group sharing; normal group chat is never ingested or used for named-member profiling.

Read results preserve success, not-found, ambiguity, unavailable, source type, freshness, and revision as applicable. Official schedules, saved notes, knowledge, Wikipedia, and catalog resources stay separate. A temporary sharing link is generated only after current authorization and storage-reference validation and is never checkpointed or remembered.

Writes pause for authoritative review and resume through `src/helper-agent/review.ts`; `src/runtime/action-executor.ts` performs the only commit. Admin `/last-agent-turns`, `/last-errors`, and `/last-routes` contain only allowlisted metadata and opaque support IDs.

Useful memory commands:

```text
/memories
/forget-memory <id>
/memory-status
```

`/memories` requires effective `retrieve_memory`; `/forget-memory <id>` requires effective `save_memory` authority in the current LINE scope. `/memory-status` is admin-only. Set `REDIS_URL` for cross-replica workflow state and `DATABASE_URL` for durable access, memory, catalog, and helper checkpoints.

## OneDrive And Graph

Graph access uses app-only Microsoft 365 auth. Configure the main drive id and folder ids/paths through env vars:

- `GRAPH_DRIVE_ID`
- `GRAPH_PPT_FOLDER_ITEM_ID`
- `GRAPH_POP_SHEET_DRIVE_ID` when the pop sheet source is on another drive
- `GRAPH_POP_SHEET_FOLDER_ITEM_ID`
- `GRAPH_HYMN_SHEET_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID`
- `GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID`
- `SHEET_MUSIC_ALLOWED_EXTENSIONS`

Catalog sync recursively scans each registered OneDrive source. Cross-drive shortcuts must register the resolved remote drive and folder item ids as the source root.

## Notion Service Schedule

For the current HHC media service schedule database, use these property mappings:

- `NOTION_DATE_PROPERTY=聚會日期`
- `NOTION_MEETING_PROPERTY=聚會場次`
- `NOTION_ROLE_PROPERTY=服事崗位`
- `NOTION_PERSON_PROPERTY=服事人員`

`NOTION_SERVICE_DATABASE_ID` can be the database id. The app resolves the queryable Notion data source internally.

The production catalog sync job also registers the media team service schedule as a Notion `schedule` source and writes rows into the PostgreSQL `schedule_items` read model. Notion database reads follow every result cursor before syncing, so the read model is not limited to the first page. `query_schedule` checks that read model before any live Notion fallback, so users only ask for a service schedule; they never need to choose Notion or PostgreSQL. LINE-created schedules remain separate write-controlled schedule records and do not write back to Notion.

Schedule lookup combines SDK-provided arguments with a storage-neutral field interpreter and the profile's declarative domain resolver. `query_schedule` remains the only user-facing schedule function. The handler executes one generic domain loop over canonical or saved-schedule bindings, so media, morning prayer, street service, children's Sunday, prayer meeting, and future domains reuse the same flow without SDK branches. `save_schedule` binds previews to the domain key and revision, applies the domain write policy, and rejects confirmation if that contract changed. Notion publication first normalizes the complete source and then atomically replaces the visible snapshot; validation or publication failure leaves the prior snapshot visible.

## Dynamic Knowledge Sources

`query_knowledge` answers from profile-shared pages or databases registered by an admin. An admin adds a shared page by saying `加入知識來源 <page URL> 名稱 <display name>` in direct chat; optional bounded `aliases`, `topics`, and `sampleQueries` improve routing, while `expiresAt` makes it temporary. Administrator core, lifecycle, and routing fields are staged separately from the promoted last-known-good snapshot. A one-time schema marker preserves an intentionally staged permanent (`NULL`) expiry across later startup migrations. Remote fetch, chunking, and embedding preparation finish before one atomic publication replaces documents, chunks, embeddings, lifecycle/core fields, routing metadata, sync health, and the staging revision. A failed synchronization therefore preserves the complete previous live snapshot, and a failure from an older revision cannot mark a newer ready publication failed. Re-adding a disabled or expired source does not reactivate it before successful publication. A source that has never synchronized successfully is never routed or searched. Sources default to permanent, can be listed/synchronized/enabled/disabled, and destructive removal requires `/confirm <code>`. The page must first be shared with the configured integration.

Knowledge synchronization preserves page hierarchy, tables, lists, properties, and order in PostgreSQL. It chunks by heading, stores full-text data, and uses pgvector plus the existing Azure AI Services `text-embedding-3-small` deployment for hybrid retrieval. Exact title/date/ordinal evidence outranks semantic similarity. Embedding failure atomically publishes the complete lexical snapshot as `embedding_pending`. In helper agent mode, `query_knowledge` returns at most eight authorized excerpts with a generic knowledge source kind and does not make its former nested answer-generation call. Internal source/document/section IDs and titles stay out of SDK tool output. Expired temporary sources leave search immediately and are purged after 30 days.

Configure `EMBEDDING_PROVIDER=azure_openai`, `AZURE_OPENAI_EMBEDDING_API_KEY`, `AZURE_OPENAI_EMBEDDING_ENDPOINT=https://bible-text-embedding-resource.cognitiveservices.azure.com/`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small`, `AZURE_OPENAI_EMBEDDING_API_VERSION=2024-10-21`, `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_BATCH_SIZE=16`, and `EMBEDDING_TIMEOUT_MS=30000`. Production deployment reuses the Bible Azure AI Services account and copies an account key directly into a workload-scoped ACA secret without printing or rotating it. The embedding model and its 1536 dimensions are a fixed contract; `EMBEDDING_DIMENSIONS` and retired direct-OpenAI settings are rejected. PostgreSQL must already have the `vector` extension; the app validates it but never installs extensions.

Helper follow-up state is the requester-scoped LangGraph checkpoint described above. It may remember prior questions and bounded tool evidence, but it never grants authority; every later tool is rebuilt and authorized from the current profile/source/requester. Schedule and knowledge follow-ups therefore ask their handlers again with current arguments instead of treating stored content as authoritative. `main` has no agent checkpoint or task frame.

## LINE Attachment Save Gate

Production profiles still allow text messages only unless `allowedMessageTypes` is explicitly expanded. When a profile allows `image` or `file`, the webhook does not immediately download, upload, or save the attachment. Direct chat stores a requester/source-scoped pending attachment session and asks `要我幫忙保存這個檔案嗎？` with `是` and `否` quick replies. Groups first require the requester-scoped two-minute upload activation described above; without it the attachment is ignored without a reply or session.

After opt-in, the bot offers exactly four purposes: `投影片`, `流行歌譜`, `詩歌歌譜`, and `小哈資料庫`. It checks the selected target's write capability, asks the requester to enter a title, and then creates a metadata-only preview with `保存` and `取消`. It does not download or scan the binary during these stages. Only after the requester replies `保存` does the bot atomically claim the pending attachment and persist one opaque work ID in a Redis-backed enqueue outbox. A successful queue send advances that record to `queued`; an ambiguous queue/Redis failure is reported as a scheduled retry, never as a successful queue handoff. The event-driven `hhc-line-bot-attachment-worker` execution leases one queue message and claims the work with a bounded token lease. Expired pre-publication claims are reclaimable and stale claim tokens cannot mutate newer work. A `publishing` lease is not reclaimed: once it expires, the work becomes an observable `publication_abandoned` terminal failure because publication may already have committed externally.

The worker downloads the LINE or authorized external source only until it has durably recorded a non-secret upload descriptor and Asset identity. Redelivery with an Asset identity uses Asset get/wait/grant/download only and validates the persisted checksum, size, and detected MIME before Graph publication. If Asset completion won but recording the identity did not, the worker first replays Asset create with the same work ID and descriptor so Asset idempotency can recover the existing object without another source download. Concurrent duplicate confirmations cannot publish the same session twice. Work completion/failure first wins the fenced terminal state transition and atomically records the bounded requester-job update to apply. Queue deliveries acknowledge only durable completed, permanent-failure, and missing outcomes; transient dependencies, pending scans, and legitimate claim/publication contention remain unacknowledged. The concrete policy is a 10-minute scan deadline, 14-minute publication deadline, 15-minute replica timeout, 1-minute acknowledgement margin, 17-minute queue visibility, 20-minute claim lease, and 60-minute work/job retention. OneDrive upload and catalog upsert remain one logical commit.

The attachment binary is fetched outbound from the finite attachment worker through the LINE Content API; it is not part of the inbound webhook JSON. API Gateway, Dapr, and Fastify webhook body limits therefore remain unchanged.

Supported attachment targets in this flow:

- `投影片`: writes to the `ppt_slides` OneDrive root and indexes `ppt_slide`.
- `流行歌譜`: writes to the `pop_sheet_music` OneDrive root and indexes `pop_sheet`.
- `詩歌歌譜`: writes to the `hymn_sheet_music` OneDrive root and indexes `hymn_sheet`.
- `小哈資料庫` / `教會資料`: writes to `xiaoha_database` subfolders and indexes `church_document`, `church_image`, or `church_other` with 90-day retention.

The finite attachment Job uses a dedicated managed identity to consume the queue and call Asset API through internal ingress. It creates an idempotent `line.group.file` asset, waits for Asset's durable scan result, downloads only a clean granted asset, verifies its persisted descriptor again, then publishes through the existing Graph and catalog path. Pending scans and transient Asset failures leave the queue delivery unacknowledged for retry; infected, invalid, or permanent Asset failures transition durably before acknowledgement. The Job does not receive storage keys, queue connection strings, ClamAV configuration, LINE channel secrets, Account authorization, LLM keys, Notion credentials, or observability secrets. Asset API owns malware scanning, signature freshness, and EICAR assurance.

## Runtime Secrets

Do not commit real `.env` files. In Azure Container Apps, store only real credentials in ACA secrets:

- `LINE_HELPER_CHANNEL_SECRET` and `LINE_HELPER_CHANNEL_ACCESS_TOKEN`
- `DEEPSEEK_API_KEY`
- `AZURE_OPENAI_EMBEDDING_API_KEY`
- `DATABASE_URL` and `REDIS_URL`
- `NOTION_TOKEN`
- `GRAPH_CLIENT_SECRET`
- `ATTACHMENT_SCAN_QUEUE_URL` as the queue-scoped bot producer secret
- `ASSET_API_AUDIENCE` for the attachment Job's managed-identity token

`config/profiles.json` is intentionally non-sensitive and is packaged in the image. Do not set `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`; the runtime rejects both.

## Governance

The app assigns a request id to each handled LINE event and includes it in route observer logs, recent route diagnostics, and recent error records. Basic per-source rate limiting is enabled by default:

- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX_REQUESTS=20`
- `LAST_ERRORS_MAX_ENTRIES=20`

When Redis is configured, rate limits use atomic Redis counters. Recent routes and errors are sanitized before storage and do not include raw user text, function queries, invite codes, LINE reply tokens, credential URLs, or secrets. After the first successful controlled function in a profile/source/requester scope, an atomic 365-day marker emits one allowlisted `first_success` product event containing only the action and `success` result class. Registration, clarification, result-class, write-completion, latency, and retry events follow the same no-raw-content rule; telemetry failure never changes the reply.

## Smoke Testing

Use the signed webhook smoke tool for local or deployed webhook checks:

```powershell
pnpm smoke:webhook -- --url http://localhost:3000/api/line/webhook/helper --secret PLACEHOLDER_LINE_CHANNEL_SECRET --text "小哈"
```

Operational details are in `docs/runbooks/production-operations.md`.

## GitHub pull request and release flow

`main` is protected by a no-bypass GitHub ruleset. Every change—including changes made by administrators or automated agents—must use a pull request and pass the required `PR CI` check. No approving review is required, so an agent may enable auto-merge and GitHub will squash the PR after CI succeeds.

`.github/workflows/ci.yml` runs for every pull request targeting `main`, including documentation-only changes. It installs dependencies and runs formatting, typecheck, lint, tests, production-profile validation, the SDK agent eval, the SDK acceptance gate, the owned real-dependency integration gate, and TypeScript compilation. A validation failure blocks the PR and does not create a production deployment.

`.github/workflows/release.yml` runs only after app, build, or deployment inputs are merged to `main`, or through an explicit manual dispatch. It does not repeat the pnpm validation suite. It authenticates to Azure through a branch-scoped OIDC federated credential, builds the production image with `az acr build`, and publishes these ACR tags:

```text
alive.azurecr.io/alive/hhc-line-function-bot:<branch>-<githubRunId>
alive.azurecr.io/alive/hhc-line-function-bot:latest
```

Bot deployment is manifest-driven: `aca.containerapp.yaml` owns the bot's Dapr, ingress, probe, scale, resource, mount, and environment-variable structure, while `scripts/deploy-aca.sh` owns environment-specific values, secret-reference names and values, image selection, rendering, apply order, and rollout verification. It applies and verifies Dapr configuration. The Terraform-owned attachment Job uses the same immutable runtime image and a dedicated managed identity for ACR, queue consumption, and internal Asset API access.

Documentation-only merges do not trigger `Production Release`. GitHub Actions is the sole CI/CD system for this repository; the former Azure DevOps pipeline and its YAML definition have been removed.

Agents should create a `codex/*` branch, push it, open a PR, and request auto-merge. They must not push directly to `main`, force push the protected branch, or add a ruleset bypass. A failed `PR CI` run is a validation failure; a failed post-merge `Production Release` run is a distinct production build or deployment failure.

### R5.0 release assurance status

R4.1 production verification and R5.0 production acceptance describe the prior controlled-agent release. The authorized helper SDK redesign requires a new PR, release, and production acceptance; it does not add SaaS or a local model.

`Production Release` records its provider-free deployment transaction in `artifacts/release-assurance/report.json`. The `hhc-line-bot-release-probe` sends separately signed empty `events: []` webhooks through the public gateway to `helper` and `main`. It records the explicit `gateway_helper_signed_empty_webhook` and `gateway_main_signed_empty_webhook` checks, while the report attests `providerRequests: { deepseek: 0, embedding: 0 }`. These checks prove the Gateway→Dapr→selected-profile route, configured signature acceptance, and empty-batch early return. They do not prove LINE platform delivery, LINE Console secret correctness, reply-token behavior, or provider availability during normal turns; the provider count is an attestation for this provider-free release path, not runtime telemetry. The weekly `hhc-line-bot-periodic-assurance` job writes `artifacts/release-assurance/periodic-report.json` with dependency evidence independent of release acceptance. Its Asset check uses a fixed tiny clean-text payload with a unique assurance owner and restricted visibility, grants only service read, verifies downloaded bytes, and always revokes and owner-verifies the exact soft-delete. Cleanup failure fails the assurance. It does not publish a public URL or touch LINE, Graph, or the catalog.

Before the first production write, release requires the human-recorded
`LINE_PROVIDER_CONSOLE_VERIFIED_ID` to equal the provider ID already configured
for every account-link-enabled profile. This is a checkpoint, not repository
proof of LINE Console ownership. After the target revision is ready, the
`account_preflight` gate calls Account through the bot's Dapr sidecar. It checks
that every `permissionRequiredFunctions` entry has its exact derived RBAC
record, that a disposable identity remains unbound, and that an unknown binding
challenge is rejected. The gate never creates a permission or binding and its
output contains function names and bounded outcomes only. Failure uses the
existing known-good revision-copy rollback. Public forged-caller rejection is
owned by API Gateway smoke; neither check proves LINE delivery or a real-device
reply.

The accepted baseline is production release [30237001171](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237001171), which deployed revision `hhc-line-function-bot--0000149` with all 15 release checks passing, and weekly assurance [30237568728](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237568728), whose seven dependency checks passed. Both reports attest zero DeepSeek and zero embedding requests.

## Verification

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm config:validate
pnpm eval:admin
pnpm eval:agent
pnpm eval:retrieval-product
pnpm eval:kernel
pnpm eval:kernel:integration
pnpm build
```

Optional live helper agent check:

```powershell
pnpm eval:sdk-agent --live
```

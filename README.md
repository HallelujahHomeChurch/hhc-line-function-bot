# hhc-line-function-bot

LINE webhook service for routing selected church bot requests to controlled functions.

## What It Does

- Fastify webhook server with LINE signature validation.
- Multiple bot profiles in one service, each on its own webhook path.
- Per-profile access policy, wake words, message type filtering, and function toggles.
- Controlled semantic planner that uses DeepSeek as the sole LLM provider.
- Action catalog that separates user functions, admin actions, and system actions.
- Policy gate and admin action registry for natural-language admin operations.
- Deterministic candidate generation and validation when model providers fail, without a second legacy router.
- LINE Quick Reply suggestions for clarification and result selection.
- Postback-based selection state for multi-result flows, currently used by PPT and sheet music search.
- Hermes-compatible numeric selection replies, so users can tap a Quick Reply or reply with `1`, `2`, `3`.
- Definition-driven clarification state for missing slots. A generic capability request such as `查投影片`, `查流行歌譜`, `查維基百科`, or `查服事表` never runs a lookup; the bot asks for the missing value first.
- Friendly intro/help replies for `小哈`, `小哈可以幹嘛`, `help`, and related prompts without exposing internal function names or backing services.
- Contract-driven agent kernel for bounded capability candidates, validated semantic plans, requester-scoped task frames, explicit workflow stages, in-flight locks, focused replies, and explicit text/resource memories.
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
  - `query_knowledge`: searches admin-registered, profile-shared Notion knowledge with grounded hybrid retrieval.
  - `find_sheet_music`: canonical sheet-music lookup for configured pop and hymn sheet sources.
  - `find_resource`: generic authorized church catalog lookup for non-schedule, non-slide, non-sheet-music resources such as future weekly report audio.
  - `query_wikipedia`: reads a matching Wikipedia introduction and returns a source-bounded summary.
  - `save_schedule`: previews and manages the helper profile's shared canonical text-only service schedules with one-year retention.
  - `save_resource`: validates, scans, confirms, publishes, and indexes authorized LINE attachments.

The helper production profile enables the controlled church lookup functions, structured schedule management, `retrieve_memory`, and write-gated `save_memory`/`save_resource`. Read access follows profile and group/user grants; memory and resource writes remain admin or explicit-user-grant only.

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

Local development starts only the webhook service. Semantic generation and
embeddings use the configured remote providers; external search and attachment
scanning are production ACA workloads, not workstation services.

In production, the public API Gateway forwards those webhook paths through Dapr service invocation to app id `hhc-line-function-bot`. The bot Container App therefore keeps Dapr enabled on HTTP app port 3000 while its own ingress remains internal.

The consent-only sheet-music fallback uses the separate `hhc-searxng` Container App. Its ingress is internal-only; the release script deploys it before the bot and supplies `SEARXNG_BASE_URL` from its ACA internal FQDN. Do not configure production with an office-network or public SearXNG endpoint.

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
- `save_schedule` and `save_memory` are user-grant-only writes. Use `/function-user-grant`; group grants and group role capabilities cannot open them for every member.
- Admin actions are not `enabledFunctions` and cannot be granted to groups. They are gated separately by admin identity, source policy, and audit rules.

## Routing

Provider selection is lane-based. Every semantic lane uses DeepSeek as its sole provider, including function routing, admin routing, memory routing, smart talk, general-agent generation, context compression, and web summarization.

The DeepSeek provider calls the OpenAI-compatible `/chat/completions` API with `DEEPSEEK_API_KEY`; it does not require provider login routes, mounted auth state, or PostgreSQL token storage.

Provider access is profile-scoped. Every LLM-enabled profile must list `deepseek` in `allowedProviders`.

Each profile declares lane policy with `providerPolicy`. Every lane has `primary: "deepseek"` and semantic fallbacks are rejected during configuration validation.

The helper profile enables the controlled agent with at most three candidates and a minimum planner confidence of `0.65`. Candidate generation is deterministic and considers only effective, enabled functions with a declarative `agentCapability` contract. Each contract declares semantic scope, required slots, allowed operations, safe evidence providers, output fields, ambiguity behavior, and successful write-to-read handoffs. Evidence can come from explicit current-message intent, declared argument patterns, a live requester-scoped task frame, promoted dynamic-knowledge metadata, or a bounded read-only retrieval probe. No provider may invent a capability or expand the effective function set.

Write capabilities use a narrower path: they enter the candidate set only from explicit, unnegated current-message intent after requester grants are resolved. Natural shorthand such as `幫我記服事表` and `記服事表` is write intent; passive recall such as `你記得服事表嗎` is not. Domain writes such as `save_schedule` suppress both read candidates and the generic `save_memory` fallback when both match. The validator grounds the payload in the current message, and the handler still requires requester-scoped preview and confirmation.

DeepSeek is the sole `function_routing` planner. The model proposes only semantics over a bounded candidate set; it does not own workflow state or execute tools. The server then revalidates the proposal against the candidate set, source policy, function toggle, side-effect policy, current-message evidence, active-task authority, required slots, argument schema, and the `0.65` threshold. A missing required slot becomes the deterministic `collect` state even if the model proposed execute, clarify, chat, low confidence, or no plan. Unsupported or ungrounded values are discarded, ambiguity becomes clarification, and disabled or unauthorized capabilities are denied. When DeepSeek is unavailable, an unambiguous explicit request may still use the deterministic definition contract; unresolved evidence fails closed to clarification rather than guessing.

Read capabilities may declaratively opt into a bounded retrieval-evidence provider. Before probing, the contract removes only declared wake words, request wrappers, and capability nouns while preserving the user's identity, date, and topic conditions. The knowledge provider probes at most 20 promoted sources in the current profile and returns only a candidate reason to the planner—never source IDs/names, titles, URLs, or content. Provider failure is distinct from no-match and returns a temporary-unavailable reply instead of pretending the request was unclear. Every non-explicit knowledge-evidence path—task-frame entities, routing metadata, knowledge capability hints, and retrieval evidence—uses the same conservative small-talk and write-intent guard. Explicit knowledge queries remain eligible. DeepSeek proposals remain advisory: they never bypass deterministic profile policy, function toggles, argument validation, clarification, access control, or registered handler execution.

Controlled routing is always authoritative. The removed `controlledAgent.enabled` and `controlledAgent.shadow` fields are rejected during configuration validation so production cannot silently return to a second routing flow. Keep every semantic lane on DeepSeek-only policy.

If DeepSeek returns invalid JSON, times out, or is unavailable, the runtime does not invoke a second semantic model. Only one unambiguous, revalidated high-confidence capability may be recovered from the same declarative contract; unresolved evidence fails closed. Small talk generation is bounded by `LLM_GENERAL_MAX_OUTPUT_TOKENS`.

Relevant env vars:

```text
LLM_PROVIDER=deepseek
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

Deterministic capability hints are intentionally narrow:

- `find_ppt_slides`: `投影片`, `ppt`, `powerpoint`, `slides`, `keynote`, `odp`
- `query_schedule`: `服事表`, `服事`
- `find_sheet_music`: `流行歌譜`, `詩歌歌譜`, `樂譜`, `歌譜`, `sheet music`
- `find_resource`: `教會資料`, `小哈資料庫`, and explicit catalog aliases such as `週報音檔`
- `save_schedule`: `記住晨更`, `記住舉牌`, or pasted text schedules with date rows.

Candidate generation does not treat `詩歌` or `流行歌` alone as PPT requests. PPT fuzzy matching happens inside `find_ppt_slides`; for example, `奇易恩點` can match `奇異恩典.pptx`.

For sheet music requests, the planner can extract the song title, optional artist, requested file type, and fuzzy/exact match preference. Candidate generation stays conservative and only offers this capability when current-message evidence supports it.

Sheet music lookup remains catalog/local-first. If no local sheet music matches and `SEARXNG_BASE_URL` is configured, the bot asks the requester whether to search public web results. It calls SearXNG only after explicit consent, sends only the query to SearXNG, and passes only returned title/snippet/url fields to the `web_summarization` provider. Results are never fetched or saved automatically. An authorized requester with effective `save_resource` permission may explicitly select and confirm one direct HTTPS PDF/JPEG/PNG result for import into the shared pop or hymn catalog. Confirmation queues an opaque work ID; only the finite scan worker performs the SSRF-safe download, ClamAV scan, and shared binary publication. HTML pages, authenticated downloads, and crawling remain prohibited.

The candidate generator and validator guard model output when the user names an explicit domain. For example, `查維基百科` with no topic asks for the missing topic instead of letting a model invent one, and `查週報音檔` resolves to internal catalog search rather than Wikipedia when `find_resource` is enabled.

The controlled planner has a separate acceptance corpus. `pnpm eval:agent` runs offline with deterministic stub proposals and exercises the real candidate generator and plan validator, including schedule continuation, dynamic knowledge, cross-function switching, ambiguity, disabled functions, stale state, and argument-injection rejection. `pnpm eval:kernel` runs the deterministic R0-R3 product gate through the real controlled turn runtime and writes privacy-safe reports to `artifacts/kernel-v1/report.json` and `artifacts/kernel-v1/report.md`; exit code `0` means every required metric passed, while a non-zero exit means at least one metric, case, or corpus-completeness rule failed. `pnpm eval:kernel:integration` owns a disposable loopback-only Redis AOF and pgvector PostgreSQL Compose project, exercises two real clients, restarts the actual Redis server, and writes the allowlisted result to `artifacts/kernel-v1/integration-report.json`. It fails rather than skipping when Docker, a dependency, restart, or cleanup is unavailable. `case_execution_failed` identifies a case whose evaluator could not complete, not a user-facing result. `pnpm eval:agent:live` uses the configured `helper` (or `AGENT_EVAL_PROFILE`) DeepSeek-only `function_routing` policy and reports semantic proposal accuracy separately from final validated-plan accuracy. The live command exits non-zero when any final validated case fails and is intentionally not part of CI.

## Time Zone

Set `TIME_ZONE` for all calendar date range decisions, including `今天`, `明天`, `後天`, and upcoming service schedule queries. The default is `Asia/Taipei`.

Each profile may declare `schedulePolicy.meetingWindows` with meeting-name aliases and local start/end times, plus `schedulePolicy.domains` for the profile's schedule-domain registry. A domain contract declares its stable key, user-facing name, aliases and routing hints, input schema, canonical or saved-schedule binding, permitted origins and writes, priority, revision, occurrence policy, and freshness behavior. `下一場` uses the shared meeting-window policy across synchronized, saved, and live schedule sources: a same-day meeting is eligible only before its configured end time, so a 16:40 Taipei query does not return that morning's 晨更. Future dates without a configured window remain eligible; unknown same-day times fail closed instead of pretending the meeting is still upcoming.

## State

Redis and PostgreSQL durability have explicit boundaries:

- With `REDIS_URL`, app-process restart and cross-replica workflow state are supported until each record's TTL. A configured production Redis that is unavailable at startup fails readiness/startup policy instead of silently becoming durable in memory.
- Without Redis, state is only supported for single-process local development and is lost on restart. Webhook deduplication and one-shot selection are then process-local, not multi-replica safe.
- The integration gate proves Redis server restart against its owned AOF volume. Production Redis server recovery and data-loss guarantees still depend on the deployed persistence, replication, backup, and failover configuration.
- With `DATABASE_URL`, catalog, schedules, knowledge, access records, and explicit memory survive app restart. Without PostgreSQL, in-memory catalog and memory implementations are development-only and are lost on restart.

Run the complete disposable dependency gate with Docker/Compose available:

```powershell
pnpm eval:kernel:integration
```

The command selects random loopback ports, creates a unique Compose project, supplies its private `KERNEL_REDIS_URL` and `KERNEL_POSTGRES_URL` only to the matrix worker, and removes containers and volumes in `finally`. Directly running the low-level integration Vitest files for debugging requires those two URLs to point only to disposable test dependencies.

When `generalAgent.enabled=true`, group conversations get a short requester-scoped follow-up window. The default is 60 seconds. If one user has just addressed the bot, that same user can send the next related message without repeating the wake word. Each handled reply records the latest turn and refreshes the window. Other group members do not inherit that window.

When `longRunningJobs.enabled=true`, slow text turns race against `inlineReplyTimeoutMs`. If the turn is still running, the bot replies with a Quick Reply postback to check the result later. The stored result is scoped by profile, LINE source, and requester user id, and should use Redis in production.

Multi-result PPT and sheet music searches store short-lived in-memory sessions and reply with LINE postback Quick Replies. Users can also reply with a plain number such as `1` to select from the latest active candidate list for the same profile, LINE source, and requester. Numeric replies without an active selection session are ignored instead of being routed or answered.

If any enabled function is missing a required slot, the bot stores a short-lived pending function session and asks for one value at a time. The same requester can answer without repeating the function name; cancellation clears the task, while an explicit new-function request releases it and starts a new plan. Multi-slot functions continue collecting until their declarative contract is complete, then call the registered handler. Group sessions remain requester-scoped.

If a request only selects a capability—such as `查投影片`, `查流行歌譜`, `查維基百科`, or `查服事表`—the bot asks for the required title, topic, date, meeting, or schedule type before any lookup runs. This rule is declared on the function's required slot, so it also overrides a model-inferred query that the user did not supply.

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

The agent turn runtime centralizes natural-language task execution after LINE entrance checks. Every text continuation handler declares a controlled workflow stage; the kernel sorts those stages explicitly instead of relying on registration or object iteration order. Its precedence is pending confirmation/cancellation or slot collection, capability/entity selection, attachment workflow, an explicit function switch, task-frame continuation, then a new plan. There is no pre-route recent-file shortcut. `再給我一次`, `剛剛那份`, declared response-field requests such as `連結呢`, and schedule/knowledge follow-ups all pass bounded candidate generation, planner advice, deterministic validation, and exact task-frame references. A bare `保存` therefore confirms the current write instead of starting generic text memory, and a resolver answer resumes the grounded original arguments without asking the LLM to plan again.

Admin `/last-agent-turns` diagnostics include controlled phases for task-frame state, bounded capability names/count, planner provider/disposition/confidence bucket, validator reason, result-envelope status/anchor count/entity types, task-frame lifecycle outcome, and retrieval execution mode/age/freshness. `/last-errors`, `/last-routes`, and `/last-agent-turns` share a stable opaque support ID; function failures return that support code to the requester. With `REDIS_URL`, the bounded trace and route lists survive replica changes and restarts; local development otherwise uses in-memory stores. These diagnostics never retain raw messages, people, prompts, filenames, URLs, evidence, tokens, source titles/IDs, LINE IDs, or temporary sharing links. See `docs/operations/controlled-agent-support.md`.

Successful read handlers return an `agentResult` envelope in addition to their user-facing reply. The envelope has a controlled status (`success`, `not_found`, `ambiguous`, or `unavailable`) and may contain only declared entity types, canonical anchors, opaque evidence references, supported continuation operations, and a clarification payload. Ephemeral reply data is projected through the capability contract: the default is only the field the user requested, while `完整`, `全部`, `整份`, or `全文` requests the full reply. Only a successful envelope can create or replace a version-2 task frame. Not-found, unavailable, failed, or missing envelopes preserve the last valid frame unless an explicit function switch requires clearing it. Task frames have their own 600-second absolute TTL and are scoped by profile, LINE source, and requester, so a second group member cannot inherit another member's context.

This keeps new functions on one generic contract: declare `agentCapability`, normalize and schema-check arguments, define any required slots and active-evidence rules, register the handler, and return a structured `agentResult` for successful reads. A genuinely new source technology may need an adapter behind an existing capability, and genuinely separate product behavior may need a new capability contract. Arbitrary administrator-added knowledge topics do neither: trips, SOPs, policies, ministry material, and other church knowledge all reuse dynamic-source metadata and `query_knowledge`. No adapter may leak source parsing back into the router as one-off keywords or top-level continuation branches.

The memory layer adds controlled memory without making the bot an unrestricted chat recorder. Explicit group memories are private to the requester by default; group sharing must be explicit. Writes are confirmed and audited, owner/admin deletion is enforced, and expired records are physically purged.

- Recent PPT and sheet music results store only resource metadata: profile, LINE scope, requester, file title, Graph drive id, and item id.
- This automatic resource metadata is a controlled read-function exception for recall and aliasing. It is not the same as a user explicitly asking the bot to remember or save content.
- Users can explicitly ask the bot to remember an external PPT or sheet-music link. These remain scoped resource memories, but ordinary file lookup does not treat remembered metadata as current storage evidence.
- Temporary sharing links are never stored. While the requester-scoped task frame is live, a follow-up for the same item uses its opaque catalog/Graph reference, verifies that the current item still exists and is authorized, and then creates a fresh 24 hour Graph link. Resource memory only ranks current catalog/provider candidates; it cannot answer by itself or revive a tombstoned resource.
- External links are stored as user-provided links. The bot does not verify whether those links remain accessible.
- Task-frame continuation is requester-scoped. In a group, another user cannot inherit or replay someone else's result.
- Resource aliases are scope-scoped ranking hints. They never bypass a current catalog/provider search or reference validation.
- Text memories are saved only when the user clearly asks the bot to remember, save, or store content. Normal group chatter is not saved.
- The helper profile enables `retrieve_memory` for registered users and keeps `save_memory` admin/explicit-user-grant only. In a registered group, a granted requester may explicitly choose group sharing; otherwise the memory stays private to that requester in that group.
- Explicit text-memory retrieval uses OpenAI `text-embedding-3-small` and PostgreSQL `vector(1536)`. Profile/source/requester visibility, deletion, and expiry are filtered before lexical/semantic ranking. Embedding failure falls back to lexical search, answer generation receives only authorized results, and a bounded non-blocking startup batch fills vectors for older records.
- Text-memory previews state the private/group visibility and 30-day retention before confirmation. Direct-chat memories are always private, and group memories never cross into direct chat or another group.
- Structured schedule memories are separate from plain text memories. They store a schedule header plus date-based entries, are shared across the helper profile, and expire after one year.
- Saving another schedule of the same type and month replaces the previous canonical schedule after confirmation. Entry add, update, delete, and whole-schedule delete use the same preview-and-confirm flow.
- A requester with a `save_schedule` user grant may replace a schedule or add an entry from direct chat or a registered group. Updating or deleting existing entries or whole schedules remains admin-only.
- Queries such as `下次世緯家園服事是什麼時候？` and `下一次中平家族什麼時候舉牌？` search these shared entries. Identity-based `我下一次服事是什麼時候？` remains out of scope until LINE identity is bound to the church login system.
- Structured schedule memory is text-only in this version. The bot should ask for pasted text instead of trying to store or parse schedule images.
- Text memories currently expire after 30 days.
- LINE image/file attachment saving is supported only through the controlled `save_resource` flow. The requester must have effective `save_resource` permission, opt in, select one of four purposes, enter a title, review the preview, and confirm before the bot downloads, validates, scans, uploads to OneDrive, and upserts catalog metadata. In a group, the same requester must first say `小哈我要上傳檔案`, `小哈要上傳檔案`, or `小哈幫我存檔案`; only that requester's next attachment within two minutes is accepted, and unrelated group attachments remain silent.

Useful memory commands:

```text
/memories
/forget-memory <id>
/memory-status
```

`/memories` and `/forget-memory <id>` work in the current LINE scope. `/memory-status` is admin-only.
`/memories` lists both text memories and resource memories. `/forget-memory <id>` can remove either kind.

New explicit file lookups always run retrieval. Prior resources can be replayed only through a validated explicit continuation such as `剛剛那份`; legacy automatic aliases no longer short-circuit handlers.

Redis provides cross-replica atomic selection consumption and seven-day LINE `webhookEventId` deduplication. Without Redis those guarantees are limited to one process and are lost on restart.

Set `REDIS_URL` to move sessions, cache, recent errors, rate-limit state, conversation windows, webhook idempotency, and long-running job results to Redis. If `REDIS_URL` is unset, the app uses in-memory stores. If `REDIS_URL` is set but Redis cannot connect, startup fails.

Set `DATABASE_URL` to persist access state and agent memory. If PostgreSQL is configured, the app creates both access tables and agent memory tables on startup. Agent resource storage supports Graph file metadata and user-provided external links. If PostgreSQL is missing, agent memory falls back to in-memory and is lost on restart.

Sheet music search reads a fresh PostgreSQL catalog snapshot when available. A proven fresh miss can proceed to the existing consent-based web fallback; a never-published or unavailable snapshot may perform a current provider lookup instead of treating stale state as a definitive miss. The old unversioned 30-minute provider index cache is removed, so a later query can see newly added files.

Admin commands use slash syntax and are gated by each profile's bootstrap `adminUserId` or DB-managed admin principals. `/help` lists public commands and enabled functions. `/help admin` lists common admin commands by group, and `/help admin all` includes advanced and diagnostic commands.

Admins can also use natural language for selected admin actions: invite-code creation and function-scope management. Invite-code creation is direct-chat only. Function scope grant/revoke/list is the only group natural-language exception, and only when an admin clearly asks to manage the current group.

`/registry <code>` remains a deterministic slash command and is not routed through the LLM. Admin natural-language requests pass through a conservative local hint check, the admin action router, the policy gate, and the admin action registry. `/last-routes` records sanitized admin route/action outcomes without raw message text or invite codes. Use `pnpm eval:admin` when changing admin intent hints or adding admin actions.

Destructive admin actions must be confirmed with `/confirm <code>`. Invite-code creation is a `security_change` action and remains admin direct-chat only plus audited, but does not require confirmation.

The role/capability model is documented in [`docs/rbac-capability-model.md`](docs/rbac-capability-model.md). Role tables and additive `function:<name>:execute` resolution are active, but no production roles are seeded. Existing user/group function grants remain supported; source and item-kind capability enforcement remains an extension point for future role administration.

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
/catalog-sources
/catalog-source-status <sourceKey>
/catalog-source-enable <sourceKey>
/catalog-source-disable <sourceKey>
/catalog-sync-now [sourceKey]
```

Registered function modules may add more admin commands, such as `/llm-status`, `/functions`, `/sessions`, `/cache`, `/clear-sessions`, and catalog source operations. `/catalog-sources` lists DB-owned source registry rows for the current profile. `/catalog-source-enable <sourceKey>` and `/catalog-source-disable <sourceKey>` toggle source availability without changing root metadata or capabilities. `/catalog-sync-now [sourceKey]` runs the catalog sync service manually for one source or all current-profile sources and records access audit events. `/route-test <text>` reports the selected provider, action, arguments, and any fallback reason. `/last-routes` reports recent sanitized route/function outcomes, including whether a query was present, without echoing the raw query. `/last-agent-turns` shows the latest sanitized agent runtime phases so admins can debug whether a request stopped at memory, clarification, routing, in-flight locking, or function execution.

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

Schedule lookup combines validated planner arguments with a storage-neutral field interpreter and the profile's declarative domain resolver. `query_schedule` remains the only user-facing schedule function. The resolver uses only current-message aliases/hints, an explicit selection, or a valid requester-scoped task frame; one match selects, multiple matches always clarify, and no match queries eligible domains before deciding whether clarification is needed. The handler then executes a generic domain loop over canonical or saved-schedule bindings, so media, morning prayer, street service, children's Sunday, prayer meeting, and future domains reuse the same flow without router branches. The selected `domainKey` is stored in the requester-scoped task frame. `save_schedule` binds previews to the domain key and revision, applies the domain's write policy, and rejects confirmation if that contract changed. Notion publication first normalizes the complete source and then atomically replaces the visible snapshot; validation or publication failure leaves the prior snapshot visible. Only a new storage technology or genuinely separate product behavior should add an adapter or capability.

## Dynamic Knowledge Sources

`query_knowledge` answers from profile-shared pages or databases registered by an admin. An admin adds a shared page by saying `加入知識來源 <page URL> 名稱 <display name>` in direct chat; optional bounded `aliases`, `topics`, and `sampleQueries` improve routing, while `expiresAt` makes it temporary. Administrator core, lifecycle, and routing fields are staged separately from the promoted last-known-good snapshot. A one-time schema marker preserves an intentionally staged permanent (`NULL`) expiry across later startup migrations. Remote fetch, chunking, and embedding preparation finish before one atomic publication replaces documents, chunks, embeddings, lifecycle/core fields, routing metadata, sync health, and the staging revision. A failed synchronization therefore preserves the complete previous live snapshot, and a failure from an older revision cannot mark a newer ready publication failed. Re-adding a disabled or expired source does not reactivate it before successful publication. A source that has never synchronized successfully is never routed or searched. Sources default to permanent, can be listed/synchronized/enabled/disabled, and destructive removal requires `/confirm <code>`. The page must first be shared with the configured integration.

Knowledge synchronization preserves page hierarchy, tables, lists, properties, and order in PostgreSQL. It chunks by heading, stores full-text data, and uses pgvector plus OpenAI `text-embedding-3-small` embeddings for hybrid retrieval. Exact title/date/ordinal evidence outranks semantic similarity. Embedding failure atomically publishes the complete lexical snapshot as `embedding_pending`; answer generation failure returns a controlled source excerpt. A body-only question may create a controlled candidate through the content-free retrieval probe, then searches only the deterministic capped eligible source set. Retrieval first keeps one top result per eligible source, using the same ordinal boost as final retrieval, before applying the eight-chunk answer-context limit. A unique highest-evidence source is answered directly; a genuine top-score cross-source tie creates a requester-scoped numeric/postback selection whose persisted mapping contains opaque source IDs. Expired temporary sources leave search immediately and are purged after 30 days.

Configure `OPENAI_API_KEY`, `OPENAI_BASE_URL=https://api.openai.com/v1`, `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_BATCH_SIZE=16`, and `EMBEDDING_TIMEOUT_MS=30000`. The embedding model and its 1536 dimensions are a fixed contract; `EMBEDDING_DIMENSIONS` is rejected instead of acting as an override. PostgreSQL must already have the `vector` extension; the app validates it but never installs extensions.

Requester-scoped task-frame state records the last successful capability plus canonical anchors, declared entities, safe references, supported operations, and available response fields returned by the handler. `currentCapability` is the single authority field; the deprecated duplicate capability field and version-1 behavior are removed. Schedule follow-ups therefore keep the confirmed date, meeting, source, and role evidence from read-model, saved-schedule, or live Notion results. Short role questions such as `導播` or `音控是誰` are resolved against those entities instead of being treated as small talk, and unlisted roles do not require a hard-coded vocabulary. A focused single-meeting role answer is compact (`直播：銹姐、家睿`); multiple matching meetings retain date and meeting context per line. Only current-message evidence or declaratively bound task-frame evidence may fill arguments. `那下一場呢` advances after the returned date, while a complete request such as `下一場服事表的前攝影是誰` resolves from now. Knowledge follow-ups search the opaque section key first, then the same document, then the same source; missing or stale sources fail closed. Task frames have the profile-configured independent absolute expiry (600 seconds in helper), and group state is isolated by profile, group, and requester.

## LINE Attachment Save Gate

Production profiles still allow text messages only unless `allowedMessageTypes` is explicitly expanded. When a profile allows `image` or `file`, the webhook does not immediately download, upload, or save the attachment. Direct chat stores a requester/source-scoped pending attachment session and asks `要我幫忙保存這個檔案嗎？` with `是` and `否` quick replies. Groups first require the requester-scoped two-minute upload activation described above; without it the attachment is ignored without a reply or session.

After opt-in, the bot offers exactly four purposes: `投影片`, `流行歌譜`, `詩歌歌譜`, and `小哈資料庫`. It checks the selected target's write capability, asks the requester to enter a title, and then creates a metadata-only preview with `保存` and `取消`. It does not download or scan the binary during these stages. Only after the requester replies `保存` does the bot atomically claim the pending attachment and persist one opaque work ID in a Redis-backed enqueue outbox. A successful queue send advances that record to `queued`; an ambiguous queue/Redis failure is reported as a scheduled retry, never as a successful queue handoff. The event-driven `aca.attachment-scan-job.yaml` execution leases one queue message and claims the work with a bounded token lease. A crashed pre-publication claim becomes reclaimable after expiry. Immediately before calling the shared publisher, the worker must atomically advance its live claim to the fenced `publishing` state. That state is never reclaimed for another upload; its expiry is clamped to the execution's absolute 900-second replica deadline, after which redelivery terminal-fails an abandoned publication or safely discards a work ID whose retention has expired.

The worker downloads the LINE content once with `MAX_ATTACHMENT_BYTES` (default 25 MiB) and `LINE_CONTENT_DOWNLOAD_TIMEOUT_MS` (default 30 seconds), checks actual size, MIME/magic bytes, extension, safe filename, and hash, then publishes only after a local ClamAV `clean` result with a current signature manifest. Each execution has one replica, bounded runtime, 1 vCPU/4 GiB, no ingress, and a read-only signature mount. Concurrent duplicate confirmations cannot publish the same session twice. If the worker, scanner, or signatures are unavailable or stale, the save fails closed. Work completion/failure first wins the fenced terminal state transition and atomically records the bounded requester-job update to apply. It then updates the requester-scoped result job and clears that marker; a crash between those writes is reconciled idempotently on queue redelivery before acknowledgement. Queue claims distinguish active, terminal, and missing/expired work: active deliveries remain for redelivery, while terminal or retained-work-expired opaque deliveries are acknowledged so an outage longer than work retention cannot poison the queue. OneDrive upload and catalog upsert form one logical commit: catalog failure compensates by deleting the uploaded Graph item. A successful commit returns the exact catalog item reference so immediate follow-up lookup does not depend on fuzzy title search.

The attachment binary is fetched outbound from the finite scan worker through the LINE Content API; it is not part of the inbound webhook JSON. API Gateway, Dapr, and Fastify webhook body limits therefore remain unchanged.

Supported attachment targets in this flow:

- `投影片`: writes to the `ppt_slides` OneDrive root and indexes `ppt_slide`.
- `流行歌譜`: writes to the `pop_sheet_music` OneDrive root and indexes `pop_sheet`.
- `詩歌歌譜`: writes to the `hymn_sheet_music` OneDrive root and indexes `hymn_sheet`.
- `小哈資料庫` / `教會資料`: writes to `xiaoha_database` subfolders and indexes `church_document`, `church_image`, or `church_other` with 90-day retention.

The always-on bot process has no TCP or HTTP scanner endpoint configuration. The finite attachment-scan worker uses a dedicated minimal configuration loader: profile name and LINE access token, PostgreSQL, Redis, Graph publication, bounded download limits, queue access, and ClamAV paths only. It does not require LINE channel secrets, bootstrap admin IDs, LLM keys, Notion credentials, or observability secrets. The worker runs local ClamAV and requires `CLAMAV_DATABASE_DIRECTORY` plus `CLAMAV_SIGNATURE_MANIFEST_PATH` (defaulting to `manifest.json` in that directory). The manifest selects an immutable versioned database directory beneath the configured root, so a refresh cannot create a reader-visible gap. `CLAMAV_SCAN_TIMEOUT_MS` controls its bounded scan duration. It revalidates the same signature version immediately before publication and fails closed when the manifest is missing, malformed, changed during the scan, from the future, or more than 72 hours old.

`aca.clamav-signature-refresh-job.yaml` runs at `10 19 */2 * *` UTC. It mounts the same Azure Files share through a separate read/write environment storage definition, downloads into a private staging directory, requires `main`, `daily`, and `bytecode` databases, validates each with ClamAV tooling, moves the set into an immutable versioned directory, and atomically replaces the sanitized manifest last. Deployment also starts and waits for one refresh execution before enabling the queue scanner, so a newly provisioned share is never left empty until the first scheduled run. Any download, completeness, validation, or promotion failure exits non-zero and retains the prior active set.

## Runtime Secrets

Do not commit real `.env` files. In Azure Container Apps, store only real credentials in ACA secrets:

- `LINE_HELPER_CHANNEL_SECRET`, `LINE_HELPER_CHANNEL_ACCESS_TOKEN`, and `LINE_HELPER_ADMIN_USER_ID`
- `DEEPSEEK_API_KEY`
- `OPENAI_API_KEY`
- `DATABASE_URL` and `REDIS_URL`
- `NOTION_TOKEN`
- `GRAPH_CLIENT_SECRET`
- `ATTACHMENT_SCAN_QUEUE_URL` as the queue-scoped bot producer secret
- the attachment queue connection string used only by the finite scan job

The release script obtains the ClamAV Azure Files account key directly from the storage account while provisioning the Container Apps environment storage, then discards it. It is never copied into the bot app or the scan-job secret set.

`config/profiles.json` is intentionally non-sensitive and is packaged in the image. Do not set `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`; the runtime rejects both.

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

## GitHub pull request and release flow

`main` is protected by a no-bypass GitHub ruleset. Every change—including changes made by administrators or automated agents—must use a pull request and pass the required `PR CI` check. No approving review is required, so an agent may enable auto-merge and GitHub will squash the PR after CI succeeds.

`.github/workflows/ci.yml` runs for every pull request targeting `main`, including documentation-only changes. It installs dependencies and runs formatting, typecheck, lint, tests, production-profile validation, the deterministic controlled-agent eval, the Kernel v1 acceptance gate, the owned real-dependency integration gate, and TypeScript compilation. A validation failure blocks the PR and does not create a production deployment.

`.github/workflows/release.yml` runs only after app, build, or deployment inputs are merged to `main`, or through an explicit manual dispatch. It does not repeat the pnpm validation suite. It authenticates to Azure through a branch-scoped OIDC federated credential, builds the production image with `az acr build`, and publishes these ACR tags:

```text
alive.azurecr.io/alive/hhc-line-function-bot:<branch>-<githubRunId>
alive.azurecr.io/alive/hhc-line-function-bot:latest
alive.azurecr.io/alive/hhc-line-function-bot-scan:<branch>-<githubRunId>
alive.azurecr.io/alive/hhc-line-function-bot-scan:latest
```

`scripts/deploy-aca.sh` deploys internal SearXNG first, updates the bot, restores the required Dapr configuration, waits for the new bot revision to be healthy, and then updates the signature-refresh, attachment-scan, and catalog-sync jobs. The script binds the same Azure Files share read/write for refresh and read-only for scanning, provisions the storage key and scan queue connection directly from their Azure resources, and copies only the exact preconfigured ACA secrets needed by each job.

Documentation-only merges do not trigger `Production Release`. GitHub Actions is the sole CI/CD system for this repository; the former Azure DevOps pipeline and its YAML definition have been removed.

Agents should create a `codex/*` branch, push it, open a PR, and request auto-merge. They must not push directly to `main`, force push the protected branch, or add a ruleset bypass. A failed `PR CI` run is a validation failure; a failed post-merge `Production Release` run is a distinct production build or deployment failure.

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

Optional live DeepSeek planner check:

```powershell
pnpm eval:agent:live
```

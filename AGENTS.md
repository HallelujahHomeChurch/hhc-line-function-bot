# AGENTS.md

## Startup Context

- This repo is `hhc-line-function-bot`, a TypeScript/Fastify LINE webhook service.
- The bot is a restricted church helper, not an open-ended chat bot.
- It should feel smart inside explicitly enabled functions, but deny or clarify requests outside those functions.
- Runtime behavior is controlled by bot profiles, function toggles, access control, and state stores.
- The helper controlled planner uses DeepSeek as primary `function_routing` with Ollama fallback; other profiles may remain Ollama-only. Remote DeepSeek access uses `DEEPSEEK_API_KEY`.
- Group follow-up context is requester-scoped and short-lived; never feed raw whole-group chat into the model.
- Slow tasks may be stored as long-running jobs and returned through a LINE postback button; do not use LINE push quota for those results.
- Public `/healthz` is minimal liveness. Public `/readyz` checks only Postgres and Redis.
- Detailed dependency status belongs in admin-only direct-chat `/diag`, not public endpoints.
- Keep public repo safety in mind: never commit real `.env` files, tokens, IDs, or secrets.

Read these first when starting work:

1. `README.md` for product behavior, configuration, commands, and deployment context.
2. `docs/architecture-context.md` for the request flow, subsystem map, and debug entry points.
3. `src/server.ts` for LINE entrance behavior, admin commands, access checks, and postback routing.
4. `src/agent/capability-candidates.ts`, `src/agent/controlled-agent-router.ts`, `src/agent/plan-validator.ts`, and `src/function-arguments.ts` for controlled routing and argument handling.
5. `src/functions/definitions.ts`, `src/functions/registry.ts`, and `src/functions/modules.ts` for function registration.
6. `src/access/*` for managed user/group/admin registration and PostgreSQL/in-memory stores.
7. `src/state/*`, `src/cache/*`, and `src/redis.ts` for session/cache persistence.
8. `src/__tests__/*` before changing behavior; tests are the best executable map of expected bot behavior.

## Current Product Shape

- One service can host multiple LINE bot profiles on canonical webhook paths, for example `/api/line/webhook/helper`.
- Profile names must be lowercase URL-safe names, and `webhookPath` must equal `/api/line/webhook/{profileName}`. Do not reintroduce `/line/{profile}/webhook`.
- Each profile has its own LINE credential references, access policy, wake-word behavior, enabled functions, and bootstrap `adminUserId`.
- The intended split is:
  - `helper`: managed direct users, managed groups, registration enabled.
  - future `main`: public direct users, groups blocked, registration disabled.
- Access registration is profile-scoped. Do not make user/group registration global unless the user explicitly asks.
- `adminUserId` is the single bootstrap superadmin. Legacy `adminUserIds`, `allowedUserIds`, and `allowedGroupIds` should not be reintroduced.
- Production profile source is `config/profiles.json`, loaded from `PROFILE_CONFIG_PATH=/app/config/profiles.json`. It must use `channelSecretEnv`, `channelAccessTokenEnv`, and `adminUserIdEnv`; do not put real LINE credentials or bootstrap user IDs in the file.
- The LINE bot must not expose provider OAuth callback routes. Do not add `/api/line/llm-auth/*`; use API keys from ACA/local secrets for remote providers.
- Remote API providers such as `deepseek` are profile-scoped; future `main` official profiles should define their own provider allowlist.
- Small-talk prompt behavior is profile config, not code personality. Production LLM profiles require `smallTalk.prompting.personaPrompt`, `conversationRulesPrompt`, `safetyRulesPrompt`, and `formatRulesPrompt`; do not add helper persona/safety fallback prompts in code. Keep house-church quote/golden-sentence behavior out of small talk; it should become a separate function if needed.

## Function Surface

The first-class functions are:

- `find_ppt_slides`: search configured `.pptx`, `.ppt`, `.key`, or `.odp` presentation files and return temporary sharing links.
- `query_schedule`: query configured service schedule sources and return a focused service list without exposing the source.
- `find_sheet_music`: search the catalog-backed pop and hymn sheet-music sources and return temporary sharing links.
- `find_resource`: search authorized general church catalog sources without competing with explicit schedule, slide, or sheet-music intent.
- `query_wikipedia`: query Wikipedia for supported factual lookups.
- `query_knowledge`: query admin-registered, profile-shared Notion knowledge through PostgreSQL full-text plus pgvector retrieval and a grounded LLM answer; do not create travel/SOP-specific variants.
- `save_schedule`: preview and manage profile-shared structured service schedules with one-year retention.
- `save_resource`: controlled LINE image/file attachment intake with purpose, validation, ClamAV scanning, confirmation, OneDrive publication, catalog upsert, and audit. It is enabled on `helper`, but write-function policy keeps it admin/explicit-grant only.
- `save_memory`: explicit 30-day text memory with preview/confirmation. It is enabled on `helper`, but only admins or explicit user grants can write; a granted requester may explicitly create group-visible memory in a registered group.
- `retrieve_memory`: query visible explicit text memories in the current LINE source. It is enabled as a profile-global read function on `helper`.
- Intro/help behavior is not a normal function execution path; keep it friendly and do not expose implementation details such as OneDrive or Notion to ordinary users.
- User functions, admin actions, and system actions are separate action kinds. Do not add management behavior to `enabledFunctions`.
- Admin natural language is direct-chat only. It may route to selected admin actions, currently invite-code creation, after admin identity and source policy checks.
- Admin actions must go through the action catalog, policy gate, admin action registry, audit, and sanitized route observability.
- Destructive admin actions must use `/confirm <code>`. `security_change` actions such as invite-code creation remain admin direct-only and audited unless explicitly reclassified.

When adding or changing a function:

- Add or update the function definition.
- Include capability metadata: `displayName`, `shortDescription`, `examples`, `requires`, `scope`, `sideEffectLevel`, `allowedSources`, `requiredSlots`, `resourcePolicy`, `memoryPolicy`, and `clarificationPrompt`.
- Every enabled read function must declare an `agentCapability` contract with bounded intents/hints, allowed operations, entity types, refinable fields, ambiguity policy, and field-local active-evidence rules. Retrieval-evidence providers must be declarative, read-only, bounded, and content-free.
- Read handlers must return a structured `agentResult` envelope for success, not-found, ambiguity, and unavailable outcomes. Successful envelopes may expose only declared safe entity types, canonical anchors, opaque references, supported operations, clarification metadata, and reply data.
- Arbitrary administrator-added knowledge domains—including trips, SOPs, policies, and ministry material—must reuse dynamic-source metadata plus `query_knowledge`; do not add per-domain adapters or capabilities. Add a source adapter only for a genuinely new storage/API technology behind the existing product capability, and add a new capability contract only for genuinely separate product behavior. Never add function-specific branches to the generic controlled router, planner, validator, or top-level active-task flow.
- For a required value that users can omit by naming only the capability, declare `genericRequest.phrases` on that required slot (and `clearArguments` for related model-inferred fields). Do not add function-specific generic-request checks in routers or handlers.
- Register the function module.
- Update routing and argument extraction.
- Add clarification behavior for missing required slots.
- Add postback/numeric selection behavior if multiple results are possible.
- Add tests for enabled, disabled, unclear, deny, missing-slot, and multi-result cases.
- Add controlled-agent tests for candidate generation, argument/reference grounding, validator rejection, result-envelope lifecycle, stale active tasks, and group requester isolation.
- Update README and this file if the behavior changes how agents should work.

When adding or changing an admin action:

- Add the action name and metadata to the action catalog.
- Add or update policy tests for auth, source policy, side effect, and confirmation behavior.
- Register the handler in the admin action registry instead of adding execution logic to `server.ts`.
- Add admin router/eval cases and run `pnpm eval:admin`.
- Add observability tests that verify `/last-routes` does not expose raw messages or secrets.
- Keep telemetry, last routes, and last errors sanitized by construction.

## Architecture Map

- `src/index.ts`: app bootstrapping and dependency wiring.
- `src/config.ts`: env parsing and profile validation.
- `src/profile-path.ts`: canonical profile name and webhook path contract.
- `src/server.ts`: Fastify routes, LINE webhook entrance, access gates, admin commands, and postbacks.
- `src/router.ts`: primary model routing and router result model.
- `src/llm/provider-runtime.ts` and `src/llm/provider-metadata.ts`: provider allowlist/runtime metadata.
- `src/agent/capability-candidates.ts`, `src/agent/controlled-agent-router.ts`, and `src/agent/plan-validator.ts`: bounded candidates, advisory model planning, and deterministic authority validation.
- `src/function-arguments.ts`: argument extraction and slot handling.
- `src/functions/*`: function definitions, modules, and implementations.
- `src/agent/turn-runtime.ts`: shared text-turn pipeline after LINE entrance checks.
- `src/agent/capability-candidates.ts`, `src/agent/planner.ts`, and `src/agent/plan-validator.ts`: deterministic candidate generation, advisory semantic planning, and the server-owned authority boundary.
- `src/agent/active-task.ts` and `src/agent/active-task-transition.ts`: compatibility filenames for requester-scoped version-2 task-frame state derived from successful structured results; do not add version-1 behavior.
- `src/agent/context-manager.ts`: runtime context budget/compression plus requester-scoped conversation windows.
- `src/agent/jobs.ts`: long-running job results scoped by profile/source/requester.
- `src/agent/slot-clarification.ts`: definition-driven required-slot clarification.
- `src/agent/resolution.ts` and `src/functions/pending-resolution.ts`: reusable multi-domain resolution and requester-scoped continuation with grounded arguments.
- `src/agent/trace-store.ts`: sanitized recent agent turn diagnostics for `/last-agent-turns`.
- `src/agent/*`: controlled agent runtime, resource metadata memory, explicit text memory, aliases, and Postgres/in-memory stores.

The controlled turn state machine owns workflow state; model output does not.
Every text continuation handler must declare a `turnStage`; execution order is
the stage order, never registry insertion order.
Its precedence is pending confirmation/cancellation, resolver selection,
required-slot collection, attachment workflow, explicit function switch,
active-task continuation, then a new plan. A bare confirmation such as `保存`
belongs to the current pending write and must not switch to generic memory. A validated function
with missing required slots produces `collect`, never `execute`, even when the
planner returns chat, clarify, low confidence, or no plan. Keep this behavior
definition-driven and do not add function-specific collection branches to
routers.

- `src/clients/*`: external service clients for LINE, Ollama, DeepSeek, Graph, and Notion.
- `src/access/*`: access principals, Redis-backed registration invite codes, audit events, and stores.
- `src/state/*`: short-lived user sessions and selection state.
- `src/cache/*`: shared cache abstractions, including Redis-backed cache.
- `src/observability/*`: recent errors and route diagnostics used by admin commands.
- `src/diagnostics/*`: public data-layer readiness and admin-only dependency diagnostics.
- `src/tools/*`: local verification helpers such as router eval, Notion checks, and signed webhook smoke tests.

## Access And Admin Model

- Ordinary users should use natural language, `/registry <code>`, `/help`, or `/whoami`.
- Slash admin commands are gated by `adminUserId` or DB-managed admin principals.
- Natural-language admin actions are gated the same way and must not run in groups.
- `adminDirectOnly` means admin commands should only run from direct chat except explicitly group-scoped commands.
- Registration is invite-code based:
  - Admins create one-time codes with `/invite-code-create`.
  - Admins may also create one-time codes through direct-chat natural language.
  - The reply must include a standalone `/registry <code>` line for copy/paste.
  - A direct user or group sends `/registry <code>` and is opened immediately.
  - Display names come from the LINE SDK, not typed command arguments.
  - Do not reintroduce pending approval commands or admin group self-registration.
- Use `/help` for public command/function help.
- Use `/help admin` for common grouped admin commands and `/help admin all` for advanced diagnostics.
- Prefer consistent names such as `/user-remove`, `/group-remove`, `/access-list`, and `/invite-code-create`.
- Do not bring back old `allow-*`, `/remove-group`, `/help-admin`, `/admin-help`, `/commands`, `/register`, `/access-requests`, `/access-approve`, `/access-deny`, `/invite-code-list`, `/invite-code-disable`, or `/register-this-group` commands unless the user explicitly reverses this decision.

## Function Scoping

- `profile.enabledFunctions` means profile-global functions for that profile only, not service-global functions.
- Direct users receive profile-global read functions plus DB-managed `profileName/userId/functionName` grants.
- Groups receive profile-global read functions plus DB-managed `profileName/groupId/functionName` grants and `profileName/userId/functionName` grants for the requester.
- User and group grants are additive when the function definition allows that principal type. To make a read function group-only, remove it from `enabledFunctions` and grant it to selected groups with `/function-grant`.
- Write functions are admin-only by default even when present in `profile.enabledFunctions`. `save_schedule` and `save_memory` are user-grant-only; grant them with `/function-user-grant`. Do not open them through group grants or group role capabilities.
- A `save_schedule` user grant permits schedule replacement and entry addition from direct chat or a registered group; update/delete operations remain admin-only.
- A `save_memory` user grant permits private memory and explicitly confirmed group-visible memory in the current registered group. It never records ordinary group chat automatically.
- Use `/function-grant <functionName> [groupId]`, `/function-revoke <functionName> [groupId]`, and `/function-scopes [groupId]` for group function scope management.
- Use `/function-user-grant <functionName> <userId>`, `/function-user-revoke <functionName> <userId>`, and `/function-user-scopes <userId>` for user function scope management.
- In a group, admins can omit `groupId` for those function-scope commands. In direct chat, admins must provide `groupId`.

## Function Module Contract

- Every `FUNCTION_NAMES` entry must have a matching `FUNCTION_MODULES` module and function definition.
- Every enabled read definition must have an `agentCapability`, and every entity type emitted by its `agentResult` must be declared by that contract.
- A planner proposal never grants authority. Deterministic validation must recheck the effective enabled-function set, LINE source, side-effect policy, current-message evidence, active-task authority, confidence, schema, and required slots before execution.
- Active tasks are profile/source/requester scoped, expire independently of conversation turns, and may be created or replaced only by successful structured results whose operations intersect the definition contract.
- Each module owns its router eval cases. Include positive, missing-slot, typo, negative, disabled, and cross-function cases.
- Use `expected: { type: "execute", ... }` or `expected: { type: "deny", ... }` so evals can check both allowed and blocked behavior.
- Keep `pnpm eval:agent` deterministic and offline. Use `pnpm eval:agent:live` only for manual live-model checks.

## State And Persistence

- In-memory stores are acceptable for single-replica local/dev behavior.
- `REDIS_URL` moves sessions, cache, recent errors, rate-limit state, and registration invite codes to Redis.
- `REDIS_URL` also moves destructive-action confirmation codes to Redis.
- `REDIS_URL` also moves requester-scoped conversation windows, independently expiring active-task state, and long-running job results to Redis.
- Redis rate limiting must use atomic counters, not read-modify-write JSON buckets.
- PostgreSQL backs managed access principals and audit events when registration is enabled.
- PostgreSQL backs agent memory when configured. The app creates access and agent memory tables on startup.
- PostgreSQL must not store remote provider API keys, access tokens, or refresh tokens. Use it only for policy, registry, audit, and memory/catalog metadata.
- Remote provider API keys belong in ACA secrets or local `.env`, never in PostgreSQL or committed files.
- Agent memory must not store temporary sharing links. Store Graph drive/item metadata and regenerate short-lived links on demand.
- Successful PPT and sheet-music lookup metadata is a controlled `read`-function exception: it may store short-lived, scope-local resource metadata for recall, but it is not user-authored saved content and must not store raw files or generated sharing links.
- External resource memories may store user-provided URLs, but only when the user explicitly asks the bot to remember/save/store that resource.
- Recent resource recall is requester-scoped. Resource aliases and explicit text memories are scoped to the current profile and LINE source.
- Structured schedules are profile-shared, not requester/source-scoped. The same helper schedule can be queried from managed direct chats and groups.
- Dynamic knowledge sources are profile-shared. They default to permanent; an explicit expiry disables search immediately and schedules purge after 30 days. The private Ollama host owns `bge-m3`; PostgreSQL stores embeddings, not model files.
- Dynamic knowledge core/lifecycle fields and routing metadata are staged and promoted only by a successful atomic snapshot publication after fetch, chunk, and embedding preparation. Document/node/chunk replacement, tombstones, embeddings, promoted routing metadata, live core/lifecycle fields, sync health, and a rotated staging revision become visible in one memory operation or PostgreSQL transaction; failure health updates require the invocation's expected revision, so stale admin/scheduled sync failures do not overwrite a newer ready snapshot. The staging migration marker must preserve a later staged permanent (`NULL`) expiry across restarts. A failed sync preserves the prior live snapshot, and re-adding a disabled/expired source does not reactivate it before promotion. Never-successfully-synced sources cannot route, anchor, or search. Never expose display names, aliases, titles, headings, chunks, URLs, answer content, or person values through knowledge result/active-task envelopes or the controlled planner; use opaque source/document/hashed-section IDs and generic labels. A body-only pre-planner retrieval probe must remain declarative, read-only, profile-scoped, and capped at 20 eligible sources. Every non-explicit knowledge-evidence path (active-task entity, metadata, knowledge hint, and retrieval evidence) must use the same engagement small-talk classifier and centralized write-intent guard; explicit knowledge intent remains authoritative. Follow-ups fall back section to document to source, never profile-wide, and switch only on one unique match from the same capped eligible metadata provider used for candidates. Initial body-only queries compare one top result per capped eligible source with the same ordinal boost as final retrieval before applying the answer-context limit; answer unique top-source evidence and use the existing requester-scoped numeric/postback selection state for genuine cross-source ties.
- Structured schedule replacement and entry add/update/delete require preview and confirmation. The same schedule type and month has one active canonical record.
- Do not add automatic group-chat recording. Text memory must be explicit user intent.
- LINE attachment download/storage is allowed only through the controlled `save_resource` pending-attachment flow. Direct chat may create a short-lived requester/source-scoped pending attachment session. A group must first receive a requester-scoped, two-minute, one-shot upload intent from an explicit activation phrase; unrelated group attachments remain silent. The requester must opt in, choose one of the four declared purposes, enter a title, review the preview, and explicitly confirm. The later text handler may download only after final confirmation, must check target source write capability, size, MIME/magic bytes, extension, safe filename, hash, and virus scan, and must fail closed when scanning is unavailable or not clean before uploading to OneDrive and upserting catalog metadata. Do not add another binary publish path.
- Agent turn traces are diagnostic metadata only. Do not store raw user text, file names, invite codes, secrets, or generated sharing links in traces.
- Controlled-agent traces are allowlist-only. Record phases, bounded capability names/counts, provider/disposition/confidence bucket, validator reason, result status/anchor count/entity types, and lifecycle outcome. Never fall back to serializing raw prompts, messages, people, URLs, source titles/IDs, retrieval evidence, or provider payloads.
- Do not assume multi-replica safety without Redis for sessions/cache/invite codes.
- Group and room clarification/selection sessions are requester-scoped. They require the same `source.userId` to continue, and should not be created or matched when LINE does not provide a requester user id.
- Long-running job result retrieval follows the same requester/source rule. A group user must not be able to fetch another user's job result.
- Soft display-name personalization is for task-state replies such as "what title?" or "please choose"; avoid adding names to final data-heavy function results unless the user asks.
- Conversational bot-authored self-reference uses first person (`我`), not third-person `小哈`. Keep `小哈` only where it is the product identity (`我是小哈`), a wake word or user-facing example, a registration phrase, or a proper destination name such as `小哈資料庫`.
- SearXNG is only a sheet-music not-found fallback after requester consent. It must not become a general web browsing function and must not save results automatically. An authorized requester with effective `save_resource` permission may explicitly select and confirm a direct HTTPS PDF/JPEG/PNG result; the safe downloader must reject HTML, private/reserved addresses, unsafe redirects, and authenticated downloads, then publish through the sole shared binary publisher.

## Workflow

- Use `pnpm` for package scripts.
- Prefer small, targeted changes that follow the existing module boundaries.
- Before pushing behavior changes, run:
  - `pnpm format:check`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
- For controlled routing behavior changes, also run `pnpm eval:agent` when relevant.
- For controlled-agent candidate/planner/validator/result changes, also run `pnpm eval:agent`.
- Run `pnpm eval:agent:live` manually when DeepSeek credentials and the configured Ollama endpoint are available; do not add it to CI.
- For live planner validation, run `pnpm eval:agent:live` manually; do not add it to CI.
- For admin natural-language routing changes, also run `pnpm eval:admin`.
- For webhook entrance changes, consider `pnpm smoke:webhook` against a local dev server or deployed URL.
- Update tests when changing routing, LINE webhook entrance behavior, access control, admin commands, or function execution behavior.
- Keep `README.md` aligned when changing user-facing or admin-facing commands.

Testing map:

- Entrance/access/admin behavior: `src/__tests__/entrance.test.ts`.
- Router and fallback behavior: `src/__tests__/router.test.ts`, `src/__tests__/router-evals.test.ts`, and fixtures.
- Function implementations: `src/__tests__/functions.test.ts`, `src/__tests__/sheet-music.test.ts`, and Graph/Notion-related tests.
- Store behavior: `src/__tests__/access-store.test.ts`, `src/__tests__/stores.test.ts`.
- Config validation: `src/__tests__/config.test.ts`.

## Deployment Rule

- `main` is protected by a no-bypass repository ruleset. Administrators and automated agents must use a pull request; never push or force push directly to `main` and never add a bypass actor for routine or emergency work.
- Before starting any task, inspect the current branch, worktree status, and matching GitHub pull request. If an open PR belongs to the same unfinished task, continue that branch. If its PR is merged or closed, or the new work is a different task, do not reuse or branch from it: switch to and synchronize the latest `main`, then create a new `codex/*` branch.
- Preserve unrelated uncommitted or unmerged work. Do not overwrite it, discard it, mix it into a new task, or create a new task branch from a stale feature branch; isolate the new task from the latest `main` instead.
- Work on a `codex/*` branch, open a pull request, and wait for the required `PR CI` check. The required approving-review count is zero, so an agent may enable auto-merge and GitHub will squash the PR after CI succeeds.
- `.github/workflows/ci.yml` is the pull-request validation boundary. A CI failure blocks merge and is not a production deployment failure.
- `.github/workflows/release.yml` is the post-merge production boundary. It builds the ACR image and deploys ACA without repeating pnpm validation. App/build/deploy path changes merged to `main` trigger it; `AGENTS.md`, `README.md`, and `docs/**`-only merges do not.
- Treat merging a deploy-triggering pull request as a production deployment action. Do not enable auto-merge for deploy-triggering changes unless the user asked to deploy or confirmed that deploying is acceptable.
- If the user asks for code changes but not deployment, leave the verified branch/PR unmerged and report that production release is intentionally pending.
- GitHub Actions is the sole CI/CD system. Do not restore Azure DevOps or add a second automatic deployment path.
- Controlled routing is always authoritative. Do not reintroduce runtime switches, shadow routing, or a second router; roll back through a reviewed application deployment while retaining the DeepSeek-primary/Ollama-fallback lane policy.

## Deployment Context

- Pull-request CI is defined in `.github/workflows/ci.yml`. Production image build and deployment are defined in `.github/workflows/release.yml`; `scripts/deploy-aca.sh` owns the shared Azure Container Apps deployment sequence.
- Images are built for `alive.azurecr.io`.
- Runtime configuration and secrets belong in Azure Container Apps/Azure secrets, not in the repository.
- This repository is public. Never commit real `.env` files, credentials, tokens, sensitive LINE or church user data, private operational exports, or secrets in source, tests, fixtures, documentation, commits, pull requests, issues, or Actions output.
- Production LINE callback traffic enters through the public `api-gateway`, whose Nginx route invokes Dapr app id `hhc-line-function-bot` at `/v1.0/invoke/hhc-line-function-bot/method/api/line/webhook/{profileName}`. The bot Container App must keep Dapr enabled with `appId=hhc-line-function-bot`, `appPort=3000`, and `appProtocol=http`; do not disable Dapr while this gateway route exists.
- Keep the bot's own ingress internal. After any Dapr or ingress change, POST an unsigned JSON body through the public API Gateway webhook path and verify the response comes from the bot as `400 {"ok":false,"error":"missing_line_signature"}`.

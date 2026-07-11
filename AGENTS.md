# AGENTS.md

## Startup Context

- This repo is `hhc-line-function-bot`, a TypeScript/Fastify LINE webhook service.
- The bot is a restricted church helper, not an open-ended chat bot.
- It should feel smart inside explicitly enabled functions, but deny or clarify requests outside those functions.
- Runtime behavior is controlled by bot profiles, function toggles, access control, and state stores.
- LLM routing defaults to Ollama, with optional `deepseek` support through `DEEPSEEK_API_KEY`.
- Group follow-up context is requester-scoped and short-lived; never feed raw whole-group chat into the model.
- Slow tasks may be stored as long-running jobs and returned through a LINE postback button; do not use LINE push quota for those results.
- Public `/healthz` is minimal liveness. Public `/readyz` checks only Postgres and Redis.
- Detailed dependency status belongs in admin-only direct-chat `/diag`, not public endpoints.
- Keep public repo safety in mind: never commit real `.env` files, tokens, IDs, or secrets.

Read these first when starting work:

1. `README.md` for product behavior, configuration, commands, and deployment context.
2. `docs/architecture-context.md` for the request flow, subsystem map, and debug entry points.
3. `src/server.ts` for LINE entrance behavior, admin commands, access checks, and postback routing.
4. `src/router.ts`, `src/keyword-router.ts`, and `src/function-arguments.ts` for LLM/keyword routing and argument handling.
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
- `find_pop_sheet_music`: search Microsoft Graph/OneDrive sheet music folders, including shortcut folders, and return temporary sharing links.
- `query_wikipedia`: query Wikipedia for supported factual lookups.
- `save_schedule`: preview and manage profile-shared structured service schedules with one-year retention.
- Generic `save_memory`, `save_resource`, and `retrieve_memory` modules are not enabled on the helper production profile.
- Intro/help behavior is not a normal function execution path; keep it friendly and do not expose implementation details such as OneDrive or Notion to ordinary users.
- User functions, admin actions, and system actions are separate action kinds. Do not add management behavior to `enabledFunctions`.
- Admin natural language is direct-chat only. It may route to selected admin actions, currently invite-code creation, after admin identity and source policy checks.
- Admin actions must go through the action catalog, policy gate, admin action registry, audit, and sanitized route observability.
- Destructive admin actions must use `/confirm <code>`. `security_change` actions such as invite-code creation remain admin direct-only and audited unless explicitly reclassified.

When adding or changing a function:

- Add or update the function definition.
- Include capability metadata: `displayName`, `shortDescription`, `examples`, `requires`, `scope`, `sideEffectLevel`, `allowedSources`, `requiredSlots`, `resourcePolicy`, `memoryPolicy`, and `clarificationPrompt`.
- For a required value that users can omit by naming only the capability, declare `genericRequest.phrases` on that required slot (and `clearArguments` for related model-inferred fields). Do not add function-specific generic-request checks in routers or handlers.
- Register the function module.
- Update routing and argument extraction.
- Add clarification behavior for missing required slots.
- Add postback/numeric selection behavior if multiple results are possible.
- Add tests for enabled, disabled, unclear, deny, missing-slot, and multi-result cases.
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
- `src/keyword-router.ts`: conservative fallback routing when configured model providers are unavailable or invalid.
- `src/function-arguments.ts`: argument extraction and slot handling.
- `src/functions/*`: function definitions, modules, and implementations.
- `src/agent/turn-runtime.ts`: shared text-turn pipeline after LINE entrance checks.
- `src/agent/context-manager.ts`: runtime context budget/compression plus requester-scoped conversation windows.
- `src/agent/jobs.ts`: long-running job results scoped by profile/source/requester.
- `src/agent/slot-clarification.ts`: definition-driven required-slot clarification.
- `src/agent/trace-store.ts`: sanitized recent agent turn diagnostics for `/last-agent-turns`.
- `src/agent/*`: controlled agent runtime, resource metadata memory, explicit text memory, aliases, and Postgres/in-memory stores.
- `src/clients/*`: external service clients for LINE, Ollama, DeepSeek, Graph, and Notion.
- `src/access/*`: access principals, Redis-backed registration invite codes, audit events, and stores.
- `src/state/*`: short-lived user sessions and selection state.
- `src/cache/*`: shared cache abstractions, including Redis-backed cache.
- `src/observability/*`: recent errors and route diagnostics used by admin commands.
- `src/diagnostics/*`: public data-layer readiness and admin-only dependency diagnostics.
- `src/web/allowlist.ts`: controlled profile-scoped HTTPS allowlist for future safe web lookup.
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
- User and group grants are additive. To make a function group-only, remove it from `enabledFunctions` and grant it to selected groups with `/function-grant`.
- Write functions such as explicit memory saves are admin-only by default even when present in `profile.enabledFunctions`; grant them to selected users with `/function-user-grant` or to selected groups with `/function-grant`.
- Use `/function-grant <functionName> [groupId]`, `/function-revoke <functionName> [groupId]`, and `/function-scopes [groupId]` for group function scope management.
- Use `/function-user-grant <functionName> <userId>`, `/function-user-revoke <functionName> <userId>`, and `/function-user-scopes <userId>` for user function scope management.
- In a group, admins can omit `groupId` for those function-scope commands. In direct chat, admins must provide `groupId`.

## Function Module Contract

- Every `FUNCTION_NAMES` entry must have a matching `FUNCTION_MODULES` module and function definition.
- Each module owns its router eval cases. Include positive, missing-slot, typo, negative, disabled, and cross-function cases.
- Use `expected: { type: "execute", ... }` or `expected: { type: "deny", ... }` so evals can check both allowed and blocked behavior.
- Keep `pnpm eval:router` deterministic and offline. Use `pnpm eval:router:ollama` only for manual live-model checks.

## State And Persistence

- In-memory stores are acceptable for single-replica local/dev behavior.
- `REDIS_URL` moves sessions, cache, recent errors, rate-limit state, and registration invite codes to Redis.
- `REDIS_URL` also moves destructive-action confirmation codes to Redis.
- `REDIS_URL` also moves requester-scoped conversation windows and long-running job results to Redis.
- Redis rate limiting must use atomic counters, not read-modify-write JSON buckets.
- PostgreSQL backs managed access principals and audit events when registration is enabled.
- PostgreSQL backs agent memory when configured. The app creates access and agent memory tables on startup.
- PostgreSQL must not store remote provider API keys, access tokens, or refresh tokens. Use it only for policy, registry, audit, allowlist, and memory metadata.
- Remote provider API keys belong in ACA secrets or local `.env`, never in PostgreSQL or committed files.
- Agent memory must not store temporary sharing links. Store Graph drive/item metadata and regenerate short-lived links on demand.
- Successful PPT and sheet-music lookup metadata is a controlled `read`-function exception: it may store short-lived, scope-local resource metadata for recall, but it is not user-authored saved content and must not store raw files or generated sharing links.
- External resource memories may store user-provided URLs, but only when the user explicitly asks the bot to remember/save/store that resource.
- Recent resource recall is requester-scoped. Resource aliases and explicit text memories are scoped to the current profile and LINE source.
- Structured schedules are profile-shared, not requester/source-scoped. The same helper schedule can be queried from managed direct chats and groups.
- Structured schedule replacement and entry add/update/delete require preview and confirmation. The same schedule type and month has one active canonical record.
- Do not add automatic group-chat recording. Text memory must be explicit user intent.
- Do not add LINE attachment download/storage without an explicit new plan. The current attachment path is only a controlled pending gate: if a profile explicitly allows `image` or `file` and the requester has effective `save_resource`, the webhook may store a short-lived requester/source-scoped pending attachment session and ask for purpose, but it must not download, scan, upload, publish, or catalog the binary yet.
- Agent turn traces are diagnostic metadata only. Do not store raw user text, file names, invite codes, secrets, or generated sharing links in traces.
- Do not assume multi-replica safety without Redis for sessions/cache/invite codes.
- Group and room clarification/selection sessions are requester-scoped. They require the same `source.userId` to continue, and should not be created or matched when LINE does not provide a requester user id.
- Long-running job result retrieval follows the same requester/source rule. A group user must not be able to fetch another user's job result.
- Soft display-name personalization is for task-state replies such as "what title?" or "please choose"; avoid adding names to final data-heavy function results unless the user asks.

## Workflow

- Use `pnpm` for package scripts.
- Prefer small, targeted changes that follow the existing module boundaries.
- Before pushing behavior changes, run:
  - `pnpm format:check`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
- For router behavior changes, also run `pnpm eval:router` when relevant.
- For live Ollama model validation, run `pnpm eval:router:ollama` manually; do not add it to CI.
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

- Important: pushing app/build/deploy path changes to `main` triggers the Azure DevOps pipeline and deploys the app.
- Treat `git push origin main` as a production deployment action when changed paths match `azure-pipelines.yml` trigger filters.
- `AGENTS.md`, `README.md`, and `docs/**`-only changes should not trigger the pipeline.
- Do not push deploy-triggering changes to `main` unless the user explicitly asks to deploy or confirms that deploying is acceptable.
- If the user asks for code changes but not deployment, commit locally or leave changes staged/unstaged as appropriate, then ask before pushing.

## Deployment Context

- CI/CD is defined in `azure-pipelines.yml`.
- Images are built for `alive.azurecr.io`.
- Runtime configuration and secrets belong in Azure Container Apps/Azure secrets, not in the repository.

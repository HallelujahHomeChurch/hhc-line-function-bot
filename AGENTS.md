# AGENTS.md

## Startup Context

- This repo is `hhc-line-function-bot`, a TypeScript/Fastify LINE webhook service.
- The bot is a restricted church helper, not an open-ended chat bot.
- It should feel smart inside explicitly enabled functions, but deny or clarify requests outside those functions.
- Runtime behavior is controlled by bot profiles, function toggles, access control, and state stores.
- Keep public repo safety in mind: never commit real `.env` files, tokens, IDs, or secrets.

Read these first when starting work:

1. `README.md` for product behavior, configuration, commands, and deployment context.
2. `src/server.ts` for LINE entrance behavior, admin commands, access checks, and postback routing.
3. `src/router.ts`, `src/keyword-router.ts`, and `src/function-arguments.ts` for LLM/keyword routing and argument handling.
4. `src/functions/definitions.ts`, `src/functions/registry.ts`, and `src/functions/modules.ts` for function registration.
5. `src/access/*` for managed user/group/admin registration and PostgreSQL/in-memory stores.
6. `src/state/*`, `src/cache/*`, and `src/redis.ts` for session/cache persistence.
7. `src/__tests__/*` before changing behavior; tests are the best executable map of expected bot behavior.

## Current Product Shape

- One service can host multiple LINE bot profiles on different webhook paths, for example `/line/helper/webhook`.
- Each profile has its own LINE credentials, access policy, wake-word behavior, enabled functions, and bootstrap `adminUserId`.
- The intended split is:
  - `helper`: managed direct users, managed groups, registration enabled.
  - future `main`: public direct users, groups blocked, registration disabled.
- Access registration is profile-scoped. Do not make user/group registration global unless the user explicitly asks.
- `adminUserId` is the single bootstrap superadmin. Legacy `adminUserIds`, `allowedUserIds`, and `allowedGroupIds` should not be reintroduced.

## Function Surface

The first-class functions are:

- `find_ppt_slides`: search Microsoft Graph/OneDrive PPT or PDF files and return temporary sharing links.
- `query_service_schedule`: query Notion service schedule data and return a focused service list.
- `find_pop_sheet_music`: search Microsoft Graph/OneDrive sheet music folders, including shortcut folders, and return temporary sharing links.
- Intro/help behavior is not a normal function execution path; keep it friendly and do not expose implementation details such as OneDrive or Notion to ordinary users.

When adding or changing a function:

- Add or update the function definition.
- Register the function module.
- Update routing and argument extraction.
- Add clarification behavior for missing required slots.
- Add postback/numeric selection behavior if multiple results are possible.
- Add tests for enabled, disabled, unclear, deny, missing-slot, and multi-result cases.
- Update README and this file if the behavior changes how agents should work.

## Architecture Map

- `src/index.ts`: app bootstrapping and dependency wiring.
- `src/config.ts`: env parsing and profile validation.
- `src/server.ts`: Fastify routes, LINE webhook entrance, access gates, admin commands, and postbacks.
- `src/router.ts`: primary Ollama routing and router result model.
- `src/keyword-router.ts`: conservative fallback routing when Ollama is unavailable or invalid.
- `src/function-arguments.ts`: argument extraction and slot handling.
- `src/functions/*`: function definitions, modules, and implementations.
- `src/clients/*`: external service clients for LINE, Ollama, Graph, and Notion.
- `src/access/*`: access principals, Redis-backed registration invite codes, audit events, and stores.
- `src/state/*`: short-lived user sessions and selection state.
- `src/cache/*`: shared cache abstractions, including Redis-backed cache.
- `src/observability/*`: recent errors and route diagnostics used by admin commands.
- `src/tools/*`: local verification helpers such as router eval and Notion checks.

## Access And Admin Model

- Ordinary users should use natural language, `/registry <code>`, `/help`, or `/whoami`.
- Slash admin commands are gated by `adminUserId` or DB-managed admin principals.
- `adminDirectOnly` means admin commands should only run from direct chat except explicitly group-scoped commands.
- Registration is invite-code based:
  - Admins create one-time codes with `/invite-code-create`.
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
- Direct users only receive profile-global functions.
- Groups receive profile-global functions plus DB-managed `profileName/groupId/functionName` grants.
- Group grants are additive. To make a function group-only, remove it from `enabledFunctions` and grant it to selected groups with `/function-grant`.
- Use `/function-grant <functionName> [groupId]`, `/function-revoke <functionName> [groupId]`, and `/function-scopes [groupId]` for group function scope management.
- In a group, admins can omit `groupId` for those function-scope commands. In direct chat, admins must provide `groupId`.

## State And Persistence

- In-memory stores are acceptable for single-replica local/dev behavior.
- `REDIS_URL` moves sessions, cache, recent errors, rate-limit state, and registration invite codes to Redis.
- PostgreSQL backs managed access principals and audit events when registration is enabled.
- The app creates access tables on startup if PostgreSQL is configured.
- Do not assume multi-replica safety without Redis for sessions/cache/invite codes.

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

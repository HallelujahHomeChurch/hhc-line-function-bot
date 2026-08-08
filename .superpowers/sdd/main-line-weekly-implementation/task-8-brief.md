## Task 8: Provider-free main profile and Weekly Paper download

Work only in `/Users/rayselfs/Projects/hhc/hhc-line-function-bot/.worktrees/main-profile-prerequisites` on `codex/main-profile-prerequisites`. Read the repository instructions and current Task 1/3/6 reports first. Use TDD and keep one focused commit; do not push, merge, deploy, call LINE/Azure/provider/live services, or modify `AGENTS.md`.

### Persisted policy

- `allowedProviders: []` is the sole persisted provider-free authority. Do not add `none`, a second router, shadow routing, a provider switch, or `adminActionsEnabled`.
- Permit an empty provider set and an empty/partial lane policy. Non-empty profiles retain the current DeepSeek-only validation.
- The existing planner must return local `no_plan/providers_disabled` before resolving or calling a provider when the input profile has no providers. The existing validator remains authoritative and may deterministically execute exactly one explicit read candidate.
- The profile-aware provider wrapper must fail with local `providers_disabled` before calling an underlying provider.
- Provider-free profiles locally reject provider/admin surfaces, including natural-language admin routing, `/route-test`, and admin-only slash help, before Account API/provider calls. Keep `account_login` public/direct.

### Weekly capability

- Add `download_weekly_paper` as a read function with `requires: hhc_web_api`, no memory/resource/task-frame retention, no refinements/operations, and no required slots.
- Optional `issueNumber` is an integer from 1 through 2147483647. Extract it centrally only when the current text has explicit Weekly Paper intent; a numeric-only message is never weekly intent.
- Reuse the function module/registry and controlled candidate/validator flow. Do not add phrase branches to the generic router or top-level turn coordinator.
- The handler calls hhc-web-api through Dapr: latest uses `/api/bulletins/latest`; specified uses `/api/bulletins/by-number/{issueNumber}`; fixed locale is `zh-Hant`. Use the existing injected `fetchImpl`, a hard timeout, and no bot cache/client framework.
- Accept the existing public response envelope only. Map 404 to `not_found`; timeout, other non-2xx, invalid JSON/envelope/issue mismatch/URL to `unavailable`.
- The response `downloadUrl` must be either root-relative canonical `/assets/<32 lowercase hex>` or exact-origin absolute `https://www.alive.org.tw/assets/<32 lowercase hex>`, with no userinfo/hash/path escape/extra segment; query may be absent or exactly one nonblank `filename`. Resolve relative input against fixed `https://www.alive.org.tw`, revalidate exact HTTPS origin and path, and expose the URL only in a LINE URI quick reply. Never place it in reply text, agent result, trace, task state, memory, or resource metadata. Do not accept the legacy `/api/assets/public/*` surface.
- Extend the Quick Reply action union with the SDK-native `uri` shape; no custom rich-message abstraction.

### Main presentation and entrance

- Add explicit small branding copy to profile config (identity line only; no presentation DSL). Helper keeps its current copy. Main deterministic template small talk should remain friendly and provider-free.
- Help/introduction derive their lines and Quick Replies from effective functions plus public `account_login`. Main shows Weekly Paper and account login only; it must not show helper registration or memory commands. Preserve helper help regressions.
- Add production `main`: canonical webhook `/api/line/webhook/main`, public direct, group/room blocked, registration disabled, text only, `enabledFunctions: [download_weekly_paper]`, template small talk, general agent disabled, `allowedProviders: []`.
- Reorder the common entrance, not a main-specific route: structural source/message gate first, webhook dedupe and rate limit before optional dependency lookups, then lazy Account authorization only where helper admin/write authority can matter, then effective access and optional LINE display-name lookup. Main normal/help/unknown/admin-looking/blocked-group turns must not call Account API or LINE identity lookup before those gates.
- Add main LINE secret/token placeholders and deployment rendering only to the bot container. No background job manifest receives `LINE_MAIN_*`; keep Task 1 workload filtering intact.

### Required RED/GREEN evidence

- Config/policy: empty allowed providers accepted; non-empty DeepSeek rules unchanged; provider wrapper underlying completeJson/Text never called for main.
- Controlled routing: providers-disabled + one explicit weekly candidate executes; typo/ambiguous/cross-function/write/numeric-only do not execute; helper explicit read still uses DeepSeek.
- Weekly handler: latest, specified, 404, 5xx, timeout, malformed envelope, mismatched issue, external/scheme-relative/legacy/traversal/bad-query URL.
- LINE URI serialization and absence of URL from structured/persisted result fields.
- Profile-aware intro/help/login Quick Replies and helper presentation regression.
- Signed entrance provider spies for latest, specified, not-found, help, account login, unknown, blocked group, admin-looking, `/route-test`, typo, cross-function, write intent, numeric-only. Assert zero LLM/text/embedding requests; where relevant assert zero Account authorization and correct rate/display-name ordering.
- Main deployment/config isolation tests proving only the bot container receives both main LINE secrets.
- Add deterministic module eval cases and a versioned Kernel case; run focused tests, `pnpm eval:agent`, `pnpm eval:kernel`, format, typecheck, lint, architecture, build, and the broad suite excluding only the documented macOS `/dev/shm` case. Integration eval must be attempted and any Docker blocker reported exactly.

### Out of scope

No PDF proxy/download/scan/catalog/memory, bot cache, weekly selection/task state, locale fallback, generic Dapr framework, URI-policy DSL, new provider, production credential read, LINE Console change, push, PR, merge, or deployment.

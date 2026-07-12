# Architecture Context

This document is the fast map for agents and maintainers. Use it to locate the
right subsystem before changing code. `README.md` remains the product and
operations reference; `AGENTS.md` remains the agent working agreement.

## 30 Second Summary

`hhc-line-function-bot` is a restricted LINE function bot for church workflows.
It is intentionally not an open-ended chatbot. User messages are allowed to feel
natural, but execution is limited to configured profiles, access policy, enabled
functions, and admin gates.

The service is lane-based and local-first for controlled routing:

- Ollama is the default provider for `function_routing`, `admin_routing`, and
  `memory_routing`.
- DeepSeek can be enabled per profile for `smart_talk` and future
  higher-value generation lanes such as `general_agent` and
  `context_compression`, with Ollama fallback where configured.
- `deepseek` is an optional remote API provider that uses `DEEPSEEK_API_KEY`.
- Provider runtimes may reason and generate text, but this bot owns authority:
  profile policy, function toggles, tool execution, memory writes, and deny or
  clarify flows remain server-side.
- The line bot does not expose provider OAuth callback routes or store LLM
  tokens in PostgreSQL. Remote provider API keys live in ACA secrets or local
  `.env` only.
- Keyword fallback is conservative and only runs when configured model
  providers are unavailable, time out, or return invalid JSON.
- Explicit model deny decisions do not fall back.
- Function execution is still controlled by server-side policy and registered
  handlers.
- Agent memory is controlled and explicit: file results store metadata only,
  text memory is saved only when requested, and short-lived links are regenerated.
- User-provided external links can be saved as scoped resource memories only
  when the user explicitly asks the bot to remember them.
- Runtime context is selective: safety context plus same-requester recent turns,
  not full group chat transcripts.
- Production profile configuration, including persona, conversation, safety,
  and format prompting, is versioned in `config/profiles.json` and loaded from
  `PROFILE_CONFIG_PATH=/app/config/profiles.json`. ACA supplies only the
  credential values named by that file; it must not supply profile JSON.

## Request Flow

For normal LINE webhook messages, read the flow in this order:

1. `src/index.ts` wires config, clients, stores, function registry, and routers.
2. `src/server.ts` receives the Fastify webhook route.
3. LINE signature and profile path select the `BotProfileConfig`.
4. Access policy checks direct user, group, registration, and admin identity.
5. Group engagement decides whether the bot was actually addressed.
6. A short requester-scoped group conversation window may allow the same user to
   continue without repeating the wake word.
7. Slash commands stay in `src/server.ts`; normal text turns enter
   `src/agent/turn-runtime.ts`.
8. Pending text sessions and agent-memory follow-ups can short-circuit the
   router.
9. Intro and small-talk system actions can respond without function execution.
10. `src/agent/context-manager.ts` builds a bounded runtime context.
11. `src/router.ts` asks the configured LLM provider for a strict JSON route.
12. `src/keyword-router.ts` may provide conservative fallback.
13. Definition-driven slot clarification asks for missing required metadata
    before handlers run. Generic capability-only requests are identified by the
    same slot metadata and override model-inferred values.
14. Agent memory can resolve aliases before expensive file searches.
15. The turn runtime applies in-flight locks, calls the registered handler, and
    records sanitized route/function/turn diagnostics.
16. Slow turns can be stored as long-running jobs and returned through a
    requester-scoped LINE postback.
17. Successful file handlers can record resource metadata for later recall.
18. Handler output is replied through the LINE client.

The main entrance behavior lives in `src/server.ts`; tests for it live mostly in
`src/__tests__/entrance.test.ts`.

For provider diagnostics, the bootstrap superadmin sends `/llm-use` or
`/llm-status` in direct chat. Profile provider policy decides which providers
may be used. Remote API providers such as `deepseek` are configured through
secrets and profile allowlists.
`/llm-status` includes the current profile's lane policy, so route debugging can
distinguish cheap local classification from remote smart-talk generation.

## Action Types

There are three action categories. Keep them separate.

- User functions are in `FUNCTION_NAMES` and `enabledFunctions`.
- System actions are `introduce_bot` and `small_talk`; they are not function
  handlers and should not expose implementation details.
- Admin actions are management operations behind admin identity, source policy,
  action catalog metadata, audit, and sanitized observability.

Do not put admin operations into user functions. Do not grant system actions
through group function scopes.

## Profiles And Access

Profiles are independent bot configurations served by one process. In practice:

- `helper` is invite-based for direct users and groups.
- future `main` is expected to allow public direct chat but block groups.
- `enabledFunctions` is profile-global for that profile only.
- profile-global write functions are admin-only by default; non-admin users need
  an explicit user or group function grant.
- group-specific function grants are additive and stored by profile/group.
- user-specific function grants are additive and stored by profile/user. They
  apply to direct chat and to that requester inside a registered group.
- future role/capability bindings are documented in
  [`docs/rbac-capability-model.md`](rbac-capability-model.md), but v1 runtime
  behavior still uses explicit function grants as the operative override
  mechanism.
- `adminUserId` is the single bootstrap superadmin.
- `config/profiles.json` is the sole complete production profile definition.
  It contains env-variable names for LINE credentials but never their values.
  Add a profile only after its named ACA secret refs have been provisioned.

When debugging "why did the bot ignore this?", check:

- profile path and webhook path validation in `src/profile-path.ts`
- direct/group access policy in `src/server.ts`
- managed access state in `src/access/*`
- registration settings and invite-code store
- group wake word and engagement classification in `src/engagement.ts`

## Routing And Intro

Routing is deliberately layered:

- `src/engagement.ts`: cheap group prefilter for addressed vs third-person
  mentions, intro, and small talk.
- `src/intro.ts`: deterministic identity/capability replies and quick replies.
- `src/small-talk.ts`: controlled short chat, optionally generated by the LLM
  with strict sanitization. Its persona, conversation, safety, and format
  rules are profile-owned configuration; code owns only operational limits and
  provider fallback behavior.
- `src/agent/turn-runtime.ts`: shared text-turn pipeline for memory prechecks,
  text sessions, admin natural-language actions, routing, slot clarification,
  in-flight locks, function execution, and sanitized traces.
- `src/agent/slot-clarification.ts`: required-slot handling driven by function
  definition metadata.
- `src/router.ts`: primary JSON router with provider/fallback diagnostics.
- `src/clients/deepseek.ts`: DeepSeek chat/text provider.
- `src/keyword-router.ts`: narrow fallback when Ollama fails.
- `src/function-arguments.ts` and `src/functions/argument-normalization.ts`:
  slot validation and cleanup.

If a behavior is "the bot answered when it should not", start with
`engagement.ts` and entrance tests. If a behavior is "the wrong function ran",
start with `router.ts`, `keyword-router.ts`, function definitions, and router
eval cases.

## Function Cookbook

To add or change a user function:

1. Add the name to `FUNCTION_NAMES`.
2. Add or update the function definition in `src/functions/definitions.ts`,
   including side-effect level, allowed sources, required slots, resource policy,
   and memory policy.
3. Add argument schema and normalization.
4. Add a module in `src/functions/modules.ts` with router eval cases.
5. Register the handler in `src/functions/registry.ts`.
6. Add clarification state if required slots can be missing.
7. Add postback or numeric selection if multiple results are possible.
8. Add tests for enabled, disabled, unclear, missing-slot, typo/fuzzy, deny, and
   multi-result behavior.
9. Update README and AGENTS if the user/admin surface changes.

High-value tests:

- entrance/access behavior: `src/__tests__/entrance.test.ts`
- routing behavior: `src/__tests__/router.test.ts`
- deterministic eval corpus: `src/__tests__/router-evals.test.ts`
- function behavior: function-specific test files

Run `pnpm eval:router` after changing function routing.

## Agent Runtime Cookbook

The controlled agent runtime lives in `src/agent/*` and is wired from
`src/index.ts` into `src/server.ts`.

Use it for cross-function agent behavior that should not belong to one function
handler:

- text-turn orchestration after access and engagement checks
- definition-driven missing-slot clarification
- in-flight duplicate protection for long-running lookups
- requester-scoped conversation windows for natural follow-up messages
  (default 60 seconds; each handled reply refreshes the requester window)
- bounded runtime context building and compression
- postback-based long-running job result retrieval
- recent file recall such as "再給我一次"
- scope-local aliases such as "以後 X 就用這份"
- explicit external resource links such as "幫我記住這份投影片 https://..."
- explicit text memories such as "幫我記住..."
- profile-shared structured text-only schedule memories such as morning-prayer
  family schedules and street-sign service schedules. These use shared schedule
  tables with a `schedule_type` discriminator, one-year retention, and one
  canonical record per schedule type and month.
- memory commands such as `/memories`, `/forget-memory <id>`, and
  `/memory-status`
- sanitized turn diagnostics through `/last-agent-turns`

Do not use it for unrestricted chat logging. Normal group chatter must not be
saved. Temporary Graph sharing links must not be saved; store drive/item ids and
regenerate links on demand. External resource memories store user-provided URLs
and do not verify continued access. LINE attachment download/storage is out of
scope unless a future plan explicitly adds it.

Successful PPT and sheet-music lookups are the one controlled read-function
metadata exception: they may store short-lived, scope-local resource metadata for
recall and aliasing. This does not authorize user-authored saved content. Any
explicit "remember/save/store" behavior, including external links, text memory,
or structured schedule memory, remains a write action and must pass the normal
function permission rules. Schedule replacement and entry mutation always use a
preview-and-confirm flow.

When adding resource memory for a function:

1. Return `agentResource` from the successful function result.
2. Include only stable storage metadata, not generated sharing links.
3. Use `graph` storage for files that can regenerate links, or
   `external_link` storage for user-provided URLs.
4. Add tests that cover direct handler execution and entrance-level recall.
5. Keep requester-scoped recall for group conversations unless the user
   explicitly asks for a shared alias.

## Admin Cookbook

To add or change an admin action:

1. Add the action name and metadata in the admin action catalog.
2. Keep execution in the admin action registry, not inline in `server.ts`.
3. Define source policy, side-effect level, and confirmation requirements.
4. Add slash command help only if a command is user-facing.
5. Add natural-language admin routing for direct-chat admin use by default. Allow group natural language only for explicitly group-scoped actions such as function scope grant/revoke/list.
6. Audit the action and keep `/last-routes` sanitized.
7. Add policy and observability tests.

Run `pnpm eval:admin` after changing admin natural-language routing.

## State And Locking

Short-lived state can use memory locally, but production should use Redis when
multiple replicas or restarts matter.

- `src/state/*`: pending clarifications and selection sessions.
- `src/cache/*`: shared cache, including sheet music cache.
- `src/agent/*`: controlled recent resources, aliases, explicit text memories,
  and Postgres/in-memory memory stores.
- `src/in-flight/*`: duplicate in-flight function locks.
- `src/agent/jobs.ts`: requester-scoped long-running job results.
- `src/agent/context-manager.ts`: requester-scoped conversation window and
  context budget/compression.
- `src/observability/*`: recent routes and recent errors.
- `src/access/*`: Postgres access principals, audit, and invite-code stores.

Group and room task sessions are requester-scoped. A pending clarification or
multi-result selection in a shared conversation must only match when LINE sends
the same `source.userId`; if the requester user id is missing, do not create or
match that session. The bot may softly prefix task-state replies with the
requester's LINE display name, but final function results should stay focused on
the requested data.

In-flight locks currently protect long-running function requests by
`profileName + sourceKey + action + queryHash`. With Redis configured, this is
cross-instance using Redis `NX` and `PX`. Without Redis, it is process-local.

Long-running job results are separate from in-flight locks. They are keyed by a
random job id but can only be read from the same profile, LINE source, and
requester user id. With Redis configured, job results survive app restarts until
their TTL expires.

General public web lookup is intentionally not supported. The external
knowledge function is `query_wikipedia`, which uses the Wikipedia API with a
fixed language fallback and never fetches arbitrary user-supplied URLs. Sheet
music has a separate not-found fallback: when local catalog/OneDrive lookup
returns nothing, the bot may ask the requester for consent and then call the
configured internal SearXNG endpoint. That fallback only uses returned
title/snippet/url fields, passes them to the `web_summarization` provider for
ranking/summary, and never downloads, crawls, or saves web results.

Catalog-backed lookups are separated from user-facing function names. The
canonical functions are `find_ppt_slides`, `find_sheet_music`, and
`find_resource`; they should call the catalog/search layer with different
filters instead of implementing separate source-specific searches. Legacy
`find_pop_sheet_music` is an internal alias only. Future OneDrive-backed
folders such as weekly report audio should be added as a `catalog_sources` row,
an item kind value, resolver aliases, and tests; they must not add another
OneDrive crawl/search implementation.

The shared query-domain resolver lives in `src/query-domain-resolver.ts` and is
used by both model-route policy and keyword fallback. It handles explicit
domains such as service schedules, slides, sheet music, church resources,
weekly report audio, and Wikipedia. If a user names a domain but omits the
required topic/title/date, the resolver must preserve the missing slot and let
the shared slot clarification path ask instead of letting the LLM invent a
query.

Service schedules are intentionally separated from file catalog items. Notion
media-team schedule sources are registered through the same source config, but
the scheduled sync job writes them into `schedule_items` as read-model rows with
`origin=notion`. `query_schedule` checks this read model before falling back to
live Notion. LINE-created schedules remain write-controlled through the schedule
memory flow and must not write back to Notion-origin rows.

`query_schedule` is also the first adopter of the reusable query-refinement
contract. Router-provided arguments remain useful LLM evidence, while the
schedule adapter deterministically fills recognizable date, meeting, role,
schedule-type, and source-category values. Terms consumed by those structured
values are removed before the remaining text reaches in-memory or PostgreSQL
search. Future query functions should add their own domain adapter; the generic
router must not accumulate function-specific residual-query rules.

LINE attachment handling is gated before storage. If a profile explicitly allows
`image` or `file` messages and the requester has effective `save_resource`
permission, the webhook stores only a short-lived requester/source-scoped
pending attachment session and asks for the intended purpose. It does not
download, scan, upload, or publish the binary at this entrance stage.

The later pending-attachment text handler is the only binary publish path. It
accepts deterministic purposes such as slides, pop sheet music, hymn sheet
music, or Xiaoha database/church resources; verifies the target source has write
capability; downloads LINE content; checks size, MIME/magic bytes, extension,
safe filename, hash, and virus scan status; then asks for explicit confirmation.
Only a confirmed clean file is uploaded to OneDrive and upserted into
`catalog_items`. The `xiaoha_database` manual source is skipped by catalog sync
and receives a 90-day catalog `expiresAt`; formal synced sources do not.

## External Dependencies

Function dependencies are intentionally behind ports/clients:

- LINE: `src/clients/line.ts`
- Virus scanner: `src/clients/virus-scan.ts`
- SearXNG web search: `src/clients/searxng.ts`
- Ollama: `src/clients/ollama.ts`
- DeepSeek provider: `src/clients/deepseek.ts`
- Microsoft Graph: `src/clients/graph.ts`
- Notion: `src/clients/notion.ts`
- Catalog source/item store abstraction: `src/catalog/*`
- Schedule read-model store and sync: `src/schedules/*`
- Postgres access store: `src/access/postgres-access-store.ts`
- Postgres agent memory store: `src/agent/postgres-memory-store.ts`
- Redis wiring: `src/redis.ts`

Do not put real tokens, tenant ids, folder ids, database ids, or LINE ids in
docs or committed config. Use placeholders in repo files.

## Debug Map

Use this map for common issues:

- Bot does not respond in a group: access policy, registration state,
  `groupRequireWakeWord`, `src/engagement.ts`.
- Bot responds when merely mentioned in third person: `src/engagement.ts` and
  entrance tests for `third_person`.
- Wrong function route: `src/router.ts`, `src/keyword-router.ts`,
  `src/query-domain-resolver.ts`, `src/functions/definitions.ts`, router eval
  cases.
- Missing query or wrong slot: `src/function-arguments.ts`,
  `src/functions/argument-normalization.ts`, `src/agent/slot-clarification.ts`,
  and clarification tests.
- Group clarification or selection goes to the wrong person:
  `src/state/session-safety.ts`, `src/requester-personalization.ts`, and
  requester-scoped session tests.
- Duplicate long task replies: `src/in-flight/*` and the in-flight block in
  `src/agent/turn-runtime.ts`.
- User asks twice because a task is slow: `src/agent/jobs.ts` and
  `handleAgentTextTurnWithLongJob` in `src/server.ts`.
- Follow-up without wake word fails for same user: `src/agent/context-manager.ts`
  and the conversation window checks in `src/server.ts`.
- Wikipedia lookup has no result: `src/wikipedia/client.ts` and
  `src/wikipedia/lookup.ts`.
- Follow-up recall or aliases fail: `src/agent/agent-runtime.ts`,
  `src/agent/*memory-store.ts`, and `src/__tests__/agent-memory.test.ts`.
- Admin command denied: `adminUserId`, DB admin principals, `adminDirectOnly`,
  admin command parser, action policy tests.
- DeepSeek provider does not work: verify `DEEPSEEK_API_KEY`, profile provider
  allowlist, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, and `/llm-status`.
- Need to know where a text request stopped: admin direct-chat
  `/last-agent-turns`.
- Readiness failed: public `/readyz` checks only Postgres and Redis; detailed
  dependency status is `/diag` in admin direct chat.

## Verification

Use the smallest relevant check first, then run the full stack before pushing
behavior changes:

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:router
pnpm build
```

For docs-only changes, `pnpm format:check` is usually enough.

## Deployment Safety

Pushing app/build/deploy path changes to `main` can deploy through Azure DevOps.
Docs and agent-instruction-only changes should not trigger the pipeline by
current path filters, but still check `azure-pipelines.yml` if trigger behavior
changes.

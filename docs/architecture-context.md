# Architecture Context

This document is the fast map for agents and maintainers. Use it to locate the
right subsystem before changing code. `README.md` remains the product and
operations reference; `AGENTS.md` remains the agent working agreement.

## 30 Second Summary

`hhc-line-function-bot` is a restricted LINE function bot for church workflows.
It is intentionally not an open-ended chatbot. User messages are allowed to feel
natural, but execution is limited to configured profiles, access policy, enabled
functions, and admin gates.

The service is lane-based and authority-first for controlled routing:

- The helper profile uses DeepSeek as the primary `function_routing` planner
  with Ollama fallback. Admin and memory routing remain local Ollama lanes.
- DeepSeek can also be enabled per profile for `smart_talk`, `general_agent`,
  and `context_compression`, with Ollama fallback where configured.
- `deepseek` is an optional remote API provider that uses `DEEPSEEK_API_KEY`.
- Provider runtimes may reason and generate text, but this bot owns authority:
  profile policy, function toggles, tool execution, memory writes, and deny or
  clarify flows remain server-side.
- The line bot does not expose provider OAuth callback routes or store LLM
  tokens in PostgreSQL. Remote provider API keys live in ACA secrets or local
  `.env` only.
- The helper controlled planner is enabled with three deterministic candidates
  and a `0.65` minimum confidence. Provider output is advisory; deterministic
  validation owns function/source policy, evidence, arguments, and execution.
- Unresolved provider failure, low confidence, or ambiguous evidence fails
  closed to clarification. One unambiguous explicit request may use the
  definition-owned deterministic recovery path.
- Function execution remains controlled by server-side policy and registered
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
8. Text continuation handlers declare a controlled workflow stage. The kernel
   orders pending confirmation/cancellation and slot collection first, then
   capability/entity selection and attachment workflow. Registration or object
   iteration order is never authority. There is no pre-route resource-recall
   bypass; replay and field follow-ups use the normal task-frame candidate,
   planner, validator, and exact-reference path. A bare
   confirmation stays with its current pending write.
9. Intro and small-talk system actions can respond without function execution.
10. In controlled mode, the runtime reads the independently expiring,
    requester-scoped version-2 task frame and generates at most the configured number of
    candidates from declarative function contracts.
11. `src/agent/planner.ts` asks the `function_routing` provider for a bounded
    semantic proposal. DeepSeek is primary for helper and Ollama is fallback.
12. `src/agent/plan-validator.ts` treats that proposal as untrusted: it
    rechecks current-message evidence, task-frame authority, effective function
    policy, side effects, source, confidence, schema, and required slots.
13. Definition-driven validation separates `collect` from `execute`. Missing
    slots create requester-scoped collection state regardless of whether the
    model proposed execute, clarify, chat, low confidence, or no plan.
    Ambiguity remains clarification. The model cannot invent a function, make a
    write authoritative, or carry an undeclared value from old context.
14. After a validated file-search plan, agent memory can resolve explicit aliases
    before an expensive provider search.
15. The turn runtime applies in-flight locks, calls only the registered handler,
    records a sanitized result envelope, and transitions task-frame state only
    from a successful structured read result.
16. Slow turns can be stored as long-running jobs and returned through a
    requester-scoped LINE postback.
17. Successful file handlers can record resource metadata for later recall.
18. Handler output is replied through the LINE client.

Controlled routing is the only production text-routing path. Deprecated
`controlledAgent.enabled` and `controlledAgent.shadow` configuration is rejected
at startup so a deployment cannot silently return to the removed router.

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
- Function definitions may narrow grant principals. `save_schedule` and
  `save_memory` accept user grants but reject group grants and group role
  capabilities, so write authority follows the requester rather than every
  member of a registered group.
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
- `src/agent/turn-runtime.ts`: shared text-turn pipeline for pending workflows,
  memory prechecks, admin natural-language actions, controlled routing,
  resolver selection, slot clarification, in-flight locks, function execution,
  active-task transitions, and sanitized traces.
- `src/agent/capability-candidates.ts`: deterministic, bounded candidates from
  enabled function contracts, active-task evidence, and approved read-only
  evidence providers.
- `src/agent/planner.ts`: bounded semantic proposal through the configured
  `function_routing` primary/fallback providers.
- `src/agent/plan-validator.ts`: deterministic authority boundary that grounds
  arguments/references and rejects unsupported plans.
- `src/agent/active-task.ts` and `src/agent/active-task-transition.ts`:
  requester-scoped active-task state derived only from successful structured
  results.
- `src/agent/slot-clarification.ts`: required-slot handling driven by function
  definition metadata.
- `src/agent/resolution.ts` and `src/functions/pending-resolution.ts`:
  reusable multi-domain resolution plus requester/source-scoped continuation of
  the original grounded arguments.
- `src/clients/deepseek.ts`: DeepSeek chat/text provider.
- `src/function-arguments.ts` and `src/functions/argument-normalization.ts`:
  slot validation and cleanup.

If a behavior is "the bot answered when it should not", start with
`engagement.ts` and entrance tests. If a behavior is "the wrong function ran",
start with `agent/capability-candidates.ts`, `agent/controlled-agent-router.ts`,
`agent/plan-validator.ts`, function definitions, and agent eval cases.

## Function Cookbook

To add or change a user function:

1. Add the name to `FUNCTION_NAMES`.
2. Add or update the function definition in `src/functions/definitions.ts`,
   including side-effect level, allowed sources, required slots, resource policy,
   and memory policy.
3. For every enabled read function, declare `agentCapability`: current-message
   intents/hints, operations, entity types, refinable fields, ambiguity policy,
   and field-local active-evidence rules. Add a bounded read-only evidence
   provider only when metadata alone cannot establish a candidate.
4. Add argument schema and normalization. Add a source-technology adapter only
   when integrating a genuinely new storage/API format; keep that adapter behind
   the existing product capability and out of the generic planner/turn runtime.
5. Add a module in `src/functions/modules.ts` with router eval cases.
6. Register the handler in `src/functions/registry.ts`.
7. Return a structured `agentResult` from read outcomes. A success envelope may
   contain only declared safe entities, canonical anchors, opaque references,
   supported operations, and reply data; never put raw secrets, URLs, prompts,
   evidence text, or temporary links in active-task state.
8. Add clarification state if required slots can be missing.
9. Add postback or numeric selection if multiple results are possible.
10. Add tests for candidate generation, validator rejection, enabled, disabled,
    unclear, missing-slot, typo/fuzzy, deny, result-envelope lifecycle,
    requester isolation, and multi-result behavior.
11. Update README and AGENTS if the user/admin surface changes.

High-value tests:

- entrance/access behavior: `src/__tests__/entrance.test.ts`
- controlled routing behavior: `src/__tests__/controlled-agent-router.test.ts`
- deterministic planner and validator evals: `src/__tests__/agent-planner-eval.test.ts`
- function behavior: function-specific test files

Run `pnpm eval:agent` after changing function routing.

## Agent Runtime Cookbook

The controlled agent runtime lives in `src/agent/*` and is wired from
`src/index.ts` into `src/server.ts`.

The generic turn contract is:

1. Generate a bounded candidate set only from effective enabled functions and
   each definition's `agentCapability` metadata.
2. Let DeepSeek (primary) or Ollama (fallback) propose semantics over that set.
   The planner receives bounded contracts and safe task-frame summaries, not
   arbitrary source content or execution authority.
3. Deterministically validate capability choice, source, side effects,
   confidence, current-message evidence, task-frame evidence, arguments,
   references, and required slots.
4. Enter `collect` for missing slots, execute one registered handler only when
   complete, or return a controlled chat/clarify/deny outcome.
5. Consume the handler's structured result envelope and update a task frame
   only for a successful result with operations allowed by both the function
   contract and result.

Use it for cross-function agent behavior that should not belong to one function
handler:

- text-turn orchestration after access and engagement checks
- definition-driven missing-slot clarification
- in-flight duplicate protection for long-running lookups
- requester-scoped conversation windows for natural follow-up messages
  (default 60 seconds; each handled reply refreshes the requester window)
- structured task-frame state containing handler-confirmed canonical anchors,
  declared entities, and safe references; it has an independent absolute expiry, does not extend
  with ordinary conversation turns, and cannot be inherited by another group requester
- bounded runtime context building and compression
- postback-based long-running job result retrieval
- task-frame file replay such as "再給我一次", routed through the same
  candidate/planner/validator path with exact safe references
- scope-local aliases such as "以後 X 就用這份"
- explicit external resource links such as "幫我記住這份投影片 https://..."
- explicit text memories such as "幫我記住..."
- profile-shared structured text-only schedule memories such as morning-prayer
  family schedules and street-sign service schedules. These use shared schedule
  tables with a `schedule_type` discriminator, one-year retention, and one
  canonical record per schedule type and month.
- memory commands such as `/memories`, `/forget-memory <id>`, and
  `/memory-status`
- sanitized turn diagnostics through `/last-agent-turns`, correlated with `/last-routes` and `/last-errors` by opaque support ID
- response-only retrieval diagnostics for execution mode, task/resource age, source revision marker, freshness, and keyed query/reference equality fingerprints
- privacy-safe product events for registration, clarification, result class, write completion, latency, and retry

Result envelopes use the shared statuses `success`, `not_found`, `ambiguous`,
and `unavailable`. Entity types must be declared by the capability contract.
Anchors and references must be canonical, bounded, and safe to persist. A
missing, failed, not-found, or unavailable envelope cannot manufacture a new
task frame. Task frames have a 600-second absolute TTL separate from the conversation
window and are keyed by profile, LINE source, and requester. Successful writes
may nominate a declared read capability through a contract handoff, but the
target must still be effective for the requester and source.

Dynamic knowledge uses a separate `knowledge_*` read model rather than catalog
items or schedule rows. Admin direct-chat actions register Notion roots, the sync
service recursively reads blocks and prepares the complete chunk/vector set before publication, and
`query_knowledge` combines lexical and pgvector retrieval before a grounded LLM
answer. The dedicated `bge-m3` model runs on the private Ollama host; PostgreSQL
stores only vectors and version metadata. Bounded routing summaries come only
from the promoted last-known-good snapshot: staged administrator fields plus
document titles and headings from the latest successful sync. Failed syncs
preserve the previous live content, core/lifecycle fields, and routing snapshot, and never-successfully-synced rows remain visible
to admins but ineligible for routing, anchors, and retrieval. Read functions can
declare a retrieval-evidence provider and capability-specific stop words; the
kernel projects a bounded query without wake words and request wrappers before
the provider probe, while preserving identity/date/topic conditions. The
knowledge provider makes one read-only, profile-scoped probe over at most 20
promoted sources and returns only bounded candidate evidence. Task-frame entities, routing metadata, knowledge capability
hints, and retrieval evidence share the engagement classifier and centralized
write-intent guard whenever the current message has no explicit knowledge intent.
Disabled functions fail closed. Retrieval provider failure is reported as
temporarily unavailable rather than conflated with no-match or unclear intent.
The controlled planner never receives source ids or
names, titles, chunks, URLs, or answer content. Successful results persist
opaque source/document/hashed-section ids with generic labels and ordinals;
follow-ups fall back section to document to source, never profile-wide, unless the
same capped metadata provider proves one unique source switch. Initial body-only
queries search only that capped eligible source set. Memory keeps one maximum per
source in one scan and PostgreSQL uses one windowed query; source maxima use the
same ordinal boost as final retrieval and are compared before the eight-chunk answer
context is selected. Unique top-source evidence is
answered, while a tied cross-source top score creates an existing generic,
requester-scoped selection session that maps numeric/postback choices to opaque
source ids. PostgreSQL publishes source documents, tombstones, chunks, embeddings,
promoted metadata, lifecycle/core fields, sync health, and a rotated staging
revision in one transaction; the memory store exposes the same one-operation
snapshot contract. Failure health updates require the invocation's expected
revision, so stale admin or scheduled syncs cannot overwrite a newer ready snapshot.
The staging initialization marker runs the legacy live-to-staged copy once and
preserves a later staged permanent (`NULL`) expiry across restarts.

Schedule sources follow the same adapter boundary. The Notion roster adapter
and structured text schedule store normalize their input into one schedule-item
model before query refinement, preserving distinct role assignments instead of
asking the planner to understand source formatting. Administrator-added
knowledge is different: every topic or content domain—including a trip, SOP,
policy, ministry material, or future church knowledge—reuses the existing
dynamic-source metadata, `query_knowledge`, and its structured result. A new
storage/API technology may require a source adapter behind that same capability;
it does not justify a per-domain function. Add a new capability contract only
for genuinely separate product behavior with a different interaction or data
contract.

Agent traces are allowlist-sanitized by construction. They contain phase,
bounded capability names/count, provider/disposition/confidence bucket,
validator reason, result status/anchor count/entity types, and task lifecycle
only. Raw messages, people, prompts, filenames, URLs, source titles/IDs,
retrieval evidence, tokens, and sharing links are never used as a diagnostic
fallback; fields that cannot be safely normalized are omitted. Trace writes are
best-effort and never acquire routing authority. Production uses a bounded Redis
list when `REDIS_URL` is present, so replica changes and restarts do not erase the
latest sanitized decision traces.

Do not use it for unrestricted chat logging. Normal group chatter must not be
saved. Temporary Graph sharing links must not be saved; store drive/item ids and
regenerate links on demand. External resource memories store user-provided URLs
and do not verify continued access. LINE attachment download/storage is allowed
only through the controlled `save_resource` workflow below.

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
- `src/idempotency/*`: profile-scoped LINE `webhookEventId` deduplication.
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

Current explicit query evidence outranks active tasks and remembered metadata.
Only a validated `active_task_refinement` receives a task reference. Legacy
resource aliases are cleared by migration and are never consulted before
execution. One-shot selections use an atomic take, and resource-memory rows are
deduplicated by storage identity with verification, revision, and tombstone
metadata. Redis makes selection and webhook-event consumption cross-replica;
the memory fallback is single-process only.

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
ranking/summary, and never downloads or saves results automatically. A
requester with effective `save_resource` permission may explicitly select and
confirm one direct HTTPS PDF/JPEG/PNG result. Each request and redirect is
DNS-resolved, checked for private/reserved addresses, and pinned to the
validated address; HTML, credentials, cookies, and page crawling are rejected.
Confirmed bytes enter the same shared binary publisher as LINE attachments.

Catalog-backed lookups are separated from user-facing function names. The
canonical functions are `find_ppt_slides`, `find_sheet_music`, and
`find_resource`; they should call the catalog/search layer with different
filters instead of implementing separate source-specific searches. Future OneDrive-backed
folders such as weekly report audio should be added as a `catalog_sources` row,
an item kind value, resolver aliases, and tests; they must not add another
OneDrive crawl/search implementation.

The controlled candidate and validation contracts handle explicit domains such
as service schedules, slides, sheet music, church resources, weekly report
audio, and Wikipedia. If a user names a capability but omits the required
topic/title/date, definition-driven slot clarification asks instead of letting
the planner invent a query.

Service schedules are intentionally separated from file catalog items. Notion
media-team schedule sources are registered through the same source config, but
the scheduled sync job writes them into `schedule_items` as read-model rows with
`origin=notion`. `query_schedule` checks this read model before falling back to
live Notion. LINE-created schedules remain write-controlled through the schedule
memory flow and must not write back to Notion-origin rows.

`query_schedule` is also the first adopter of the reusable query-refinement and
domain-resolution contracts. Router-provided arguments remain useful LLM
evidence, while the schedule adapter deterministically fills recognizable date,
month, meeting, role, participant, schedule-type, and source-category values.
The media-team and morning-prayer-family resolvers expose product concepts, not
storage implementation names. Typed evidence selects one domain; when both
domains actually contain a match and the request is still ambiguous, the bot
asks which schedule the requester means and resumes the original grounded
arguments after the choice. Terms consumed by structured values are removed
before residual text reaches in-memory or PostgreSQL search. A genuinely
separate future query behavior may add its own refinement adapter, resolver,
and capability contract, but arbitrary knowledge topics remain inside
`query_knowledge`. The generic router must not accumulate function-specific
residual-query rules.

LINE attachment handling is gated before storage. If a profile explicitly allows
`image` or `file` messages and the requester has effective `save_resource`
permission, direct chat stores only a short-lived requester/source-scoped
pending attachment session. A group attachment is silent unless the same
requester first sends a supported upload activation phrase; the resulting
two-minute, one-shot intent is consumed atomically by that requester's next
attachment. The webhook does not download, scan, upload, or publish the binary
at this entrance stage.

The later pending-attachment text handler accepts deterministic purposes such as
slides, pop sheet music, hymn sheet music, or Xiaoha database/church resources.
Purpose selection verifies the target source has write capability and stores a
metadata-only confirmation target. It does not download or scan content. On
explicit confirmation, the handler performs one bounded LINE Content API
download and hands the bytes to the shared binary publisher for actual-size,
MIME/magic-byte, extension, safe-filename, hash, virus-scan, conflict, upload,
and catalog checks. The pending session is claimed atomically before download,
so duplicate confirmations cannot publish twice. OneDrive upload and catalog
upsert form one logical commit; catalog failure compensates by deleting the
uploaded Graph item. Scanner results other than `clean` fail closed. The
`xiaoha_database` manual source is skipped by catalog sync and receives a 90-day
catalog `expiresAt`; formal synced sources do not. Successful publication
records opaque drive/item metadata as a recent general resource, so a scoped
task-frame follow-up such as `剛剛那份` can re-enter `find_resource` with the exact
catalog item reference and regenerate a temporary link without storing the link
itself.

LINE binary bytes travel in the bot's outbound Content API response, not through
the inbound webhook body. Gateway, Dapr, and Fastify webhook body limits are not
attachment-size controls and remain unchanged.

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
- Wrong function route: `src/agent/capability-candidates.ts`,
  `src/agent/controlled-agent-router.ts`, `src/agent/plan-validator.ts`,
  `src/functions/definitions.ts`, and agent eval cases.
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
pnpm config:validate
pnpm eval:admin
pnpm eval:agent
pnpm eval:retrieval-product
pnpm build
```

Run `pnpm eval:agent:live` manually when DeepSeek credentials and the configured
Ollama endpoint are available. It is an acceptance check, not a CI dependency.

For docs-only changes, `pnpm format:check` is usually enough.

## Deployment Safety

`main` is protected by a no-bypass GitHub ruleset. Every administrator and agent
change must use a pull request and pass the required `PR CI` check from
`.github/workflows/ci.yml`. No approving review is required, so an agent may
enable squash auto-merge after opening the PR. A CI failure blocks merge and
never enters the production delivery path.

After a deploy-triggering PR merges, `.github/workflows/release.yml` builds the
immutable ACR image and runs `scripts/deploy-aca.sh`; it does not repeat the
pnpm validation suite. Documentation-only merges do not trigger production
release. GitHub Actions is the sole CI/CD system; the obsolete Azure DevOps
pipeline and YAML definition have been removed.

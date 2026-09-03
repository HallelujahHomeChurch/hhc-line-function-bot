# Architecture Context

This document is the fast map for agents and maintainers. Use it to locate the
right subsystem before changing code. `README.md` remains the product and
operations reference; `AGENTS.md` remains the agent working agreement.

## 30 Second Summary

`hhc-line-function-bot` is a restricted LINE function bot for church workflows.
It is intentionally not an open-ended chatbot. User messages are allowed to feel
natural, but execution is limited to configured profiles, access policy, enabled
functions, and admin gates.

The service uses separate routing paths per profile while keeping authority server-side:

- `helper` runs one LangChain JS `createAgent` path with `ChatDeepSeek`, LangGraph checkpointing, and official model/tool call limits. `deepseek` is its only semantic provider and reads `DEEPSEEK_API_KEY`.
- `main` remains provider-free (`allowedProviders: []`) and uses the existing deterministic Weekly Paper and own-profile workflows without invoking the SDK model.
- Profile policy, effective function projection, Account authorization, source scope, strict tool schemas, write confirmation, and domain handlers remain server-owned.
- The helper model receives only tools valid for the current profile/source/requester. Authorization is checked again immediately before each handler call.
- Existing pending confirmation, selection, slot-collection, attachment, and admin stages run before the helper SDK agent. The old candidate/planner/validator code remains only for `main` compatibility and those deterministic workflows; it is not a second helper semantic path.
- Helper conversation threads use the official PostgreSQL checkpointer in production, are HMAC-scoped by profile/source/requester, serialize same-thread turns, and expire after the configured idle TTL. A group without requester identity gets no thread.
- `config/agents/helper/PERSONA.md` and `MEMORY.md` are read-only prompt policy. Explicit memory remains in the database; group chat does not create automatic named profiles or ingest unaddressed messages.
- Knowledge, visible memory, and Wikipedia return bounded evidence directly in SDK tool mode, avoiding nested model summarizers. Temporary sharing links and internal knowledge anchors stay outside checkpointed tool output.
- External sheet-music search is consent-only. The agent may iteratively search and read bounded public HTTPS pages, while direct-file import continues through the existing confirmation, durable outbox, Asset malware scan, and clean-only publication path.
- Provider OAuth callback routes and database token storage do not exist. Remote API keys live in ACA secrets or local `.env` only.

## Modular Monolith Boundaries

The service remains one deployed modular monolith. The source boundaries are:

- `src/bootstrap/*`: the sole production composition root. It constructs
  concrete PostgreSQL, Redis, Graph, Notion, LINE, DeepSeek, Azure embedding,
  queue, store, and capability adapters.
- `src/transport/*`: Fastify and LINE adapters for health/readiness, canonical
  webhooks, public access commands, admin commands, and postbacks.
- `src/application/*`: use-case contracts and the controlled turn coordinator.
  Turn stages own text continuation, capability resolution, admin actions,
  controlled planning, and function execution in that order.
- `src/capabilities/*`: vertical product slices. `query-schedule` is the
  reference slice and owns its definition, eval cases, ports, handler, and
  module factory. `download-weekly-paper.ts` is intentionally a single narrow
  capability module with injected `fetchImpl`, not a generic Dapr client layer.
- `src/infrastructure/*`: future concrete port implementations. Existing
  concrete adapters migrate here only when touched; bootstrap remains their
  only construction owner.

`pnpm architecture:check` enforces dependency direction in PR CI. Production
construction is explicit and fails closed without PostgreSQL and Redis. Tests
use the visibly separate builders in `src/testing/*`; production code never
silently selects an in-memory store. Compatibility files such as
`src/server.ts`, `src/agent/turn-runtime.ts`, and
`src/functions/query-schedule.ts` contain re-exports only.

New types belong beside the invariants they describe. Cross-capability
execution and routing contracts live in `src/application/contracts/*`; do not
add new behavior to the compatibility catch-all `src/types.ts`.

## Request Flow

For normal LINE webhook messages, read the flow in this order:

1. `src/index.ts` loads configuration and starts `src/bootstrap/create-production-runtime.ts`.
2. `src/transport/line/webhook-routes.ts` verifies the LINE signature, selects the canonical profile path, applies webhook dedupe/rate limits, access policy, registration, admin commands, and group engagement.
3. Public slash commands, account linking, intro/help, and deterministic `main` behavior can finish before any semantic provider.
4. Existing requester-scoped pending workflows run through `src/application/turn/runtime.ts` with routing disabled. Confirmation/cancellation, slot collection, selections, attachment intake, and natural-language admin actions therefore keep their established policy and storage contracts.
5. A remaining `helper` turn enters `src/agent/sdk-turn-runtime.ts`. It derives an opaque profile/source/requester thread ID and builds the current effective profile with one bounded Account authorization result.
6. `src/agent/sdk-tools.ts` exposes only enabled, registered, source-valid tools. Each call repeats authorization, injects trusted context, validates strict Zod arguments, and invokes the existing domain handler with `agentTool: true`.
7. `src/agent/sdk-runtime.ts` composes the official `createAgent` loop, DeepSeek model, checkpointer, and six-call model/tool limits. The model may combine formal schedule, visible memory, knowledge, Wikipedia, and file evidence, but it never owns identity, permission, confirmation, or publication state.
8. A write tool can only create a preview. The next LINE event is consumed by the existing continuation workflow, which rechecks live authorization and revision state before the handler commits.
9. For consented external sheet-music discovery, SearXNG results become invocation-local opaque references. `src/clients/public-page.ts` can read only validated public HTTPS pages/direct files; any direct PDF/image candidate enters the existing import selection and Asset worker path.
10. A typed domain result containing a write preview, Quick Replies, or resource link is authoritative. Otherwise the SDK model produces the final bounded response. The transport sends it through the LINE reply client and refreshes the requester-scoped group conversation window.

Production checkpoint state uses `PostgresSaver` plus `agent_sdk_threads`. A PostgreSQL advisory transaction lock serializes each thread across replicas; the configured 600-second idle TTL and five-minute cleanup delete the full checkpoint chain. Redis retains webhook idempotency, selections, confirmation, jobs, cache, and conversation-window responsibilities.

`main` never enters steps 5-9. Its provider-free compatibility runtime remains covered by entrance and Kernel regression tests.

## Action Types

There are three action categories. Keep them separate.

- User functions are in `FUNCTION_NAMES` and `enabledFunctions`.
- System actions are `introduce_bot`, `small_talk`, `show_help`, `show_account`, and `account_login`; they are not function
  handlers and should not expose implementation details.
- Admin actions are management operations behind admin identity, source policy,
  action catalog metadata, audit, and sanitized observability.

Do not put admin operations into user functions. System actions never enter
function permission management.

## Profiles And Access

Profiles are independent bot configurations served by one process. In practice:

- `helper` is invite-based for direct users and groups.
- `main` allows public direct chat, blocks groups, and enables only provider-free Weekly Paper download.
- `enabledFunctions` is profile-global for that profile only.
- profile-global read functions are available after source authorization unless they are listed in `permissionRequiredFunctions`.
- Account authorization is the only per-user function expansion. Explicit permission-required functions use `allowedFunctions`; configured writes outside the public read projection require the Account administrator flag. The bot sends only bounded restricted candidates or current continuation capabilities and uses at most one Account authorization lookup per turn.
- historical group/user grant and role-capability rows remain stored for rollback but never expand the effective function set. Their slash and natural-language management surfaces are retired.
- LINE administrators are resolved by account-api from the linked HHC account.
- `config/profiles.json` is the sole complete production profile definition.
  It contains env-variable names for LINE credentials but never their values.
  Add a profile only after its named ACA secret refs have been provisioned.

When debugging "why did the bot ignore this?", check:

- profile path and webhook path validation in `src/profile-path.ts`
- direct/group access policy in `src/transport/line/webhook-routes.ts`
- managed access state in `src/access/*`
- registration settings and invite-code store
- group wake word and engagement classification in `src/engagement.ts`

## Routing And Intro

Routing remains layered, with one semantic owner per profile:

- `src/engagement.ts`, `src/intro.ts`, and `src/application/access/effective-access.ts` handle group engagement, deterministic identity/help, and the effective capability projection before the model.
- `src/application/turn/runtime.ts` remains the deterministic continuation engine. `src/agent/sdk-turn-runtime.ts` calls it first with `allowRouting: false`, then invokes the SDK only if no pending workflow consumed the helper turn.
- `src/agent/sdk-runtime.ts` is the thin official agent composition. It contains no hand-written tool loop or semantic graph.
- `src/agent/sdk-tools.ts` adapts existing handlers into a small tool set. Tool construction and execution both enforce profile, source, requester, and Account authorization.
- `src/agent/sdk-state.ts` owns only scoped thread identity, TTL, cleanup, and same-thread serialization around the official checkpointer. It does not serialize messages itself.
- `src/clients/public-page.ts` is the bounded SSRF-safe reader used only after sheet-music search consent.
- `src/agent/capability-candidates.ts`, `planner.ts`, `controlled-agent-router.ts`, and `plan-validator.ts` are legacy compatibility code for provider-free `main`, deterministic diagnostics/evals, and existing workflows. Helper semantic turns do not call them.

The helper tool surface intentionally groups related reads: `search_information` covers dynamic knowledge and visible explicit memory; `search_files` covers presentations, sheet music, and general catalog resources. Formal schedules and Wikipedia keep dedicated tools. Writes keep dedicated preview-only tools because their schemas and policy differ.

Intro/help stays deterministic so it cannot expose unavailable tools or implementation details. General helper chat, follow-up reasoning, and cross-source decisions use the same persona and memory policy as tool-driven answers. `main` loads neither helper policy file nor a semantic model path.

If helper chooses a wrong tool, start with `src/agent/sdk-tools.ts`, the function definition/schema, and `src/__tests__/sdk-tools.test.ts`. If an existing preview/selection does not continue, start with `src/application/turn/runtime.ts` and the owning function/session handler. If `main` regresses, inspect the legacy candidate/planner/validator path and entrance tests.

## Function Cookbook

To add or change a user function:

1. Add the name to `FUNCTION_NAMES`.
2. Add a capability slice in `src/capabilities/<name>/*` containing its
   definition, eval cases, narrow ports, handler, and module factory.
3. For every helper function, add it to the smallest appropriate SDK tool and
   expose only current effective sub-operations. Keep `agentCapability` metadata
   while legacy `main` or shared result-envelope code still consumes it.
4. Add argument schema and normalization. Add a source-technology adapter only
   when integrating a genuinely new storage/API format; keep that adapter behind
   the existing product capability and out of the SDK wrapper/turn runtime.
5. Aggregate its metadata in `src/functions/definitions.ts` and
   `src/functions/modules.ts`; do not put capability behavior there.
6. Construct the module explicitly in
   `src/bootstrap/create-production-runtime.ts` and pass it to the registry.
7. Return a structured `agentResult` from read outcomes. A success envelope may
   contain only declared safe entities, canonical anchors, opaque references,
   supported operations, and reply data; never put raw secrets, URLs, prompts,
   evidence text, or temporary links in active-task state.
8. Add clarification state if required slots can be missing.
9. Add postback or numeric selection if multiple results are possible.
10. Add tests for SDK tool visibility/schema/authorization/evidence plus enabled,
    disabled, missing-slot, typo/fuzzy, deny, requester isolation, and
    multi-result behavior. Preserve legacy router cases for `main` compatibility.
11. Update README and AGENTS if the user/admin surface changes.

High-value tests:

- entrance/access behavior: `src/__tests__/entrance.test.ts`
- helper SDK behavior: `src/__tests__/sdk-agent.test.ts`, `sdk-tools.test.ts`,
  `sdk-state.test.ts`, and `sdk-turn-runtime.test.ts`
- legacy deterministic planner/validator behavior: `src/__tests__/controlled-agent-router.test.ts`
- function behavior: function-specific test files

Run `pnpm eval:sdk-agent` after changing helper routing. Run `pnpm eval:agent`
when the legacy `main` compatibility path or shared contracts change.

## Agent Runtime Cookbook

Use the SDK agent for helper behavior that needs conversation, cross-source reasoning, or multiple tool calls. Keep business work in the existing domain handlers:

1. Project current source/requester authority and build only effective tools.
2. Let `createAgent` choose and sequence those tools.
3. Reauthorize each tool call, validate strict arguments, and invoke the registered handler.
4. Return bounded typed evidence to the model; retain raw authoritative results separately for LINE previews, Quick Replies, and resource links.
5. Let existing continuation stages own all later confirmation, selection, attachment, and commit events.

Do not add candidate ranking, phrase-specific routing, or a hand-written graph to the SDK wrapper. A new storage technology belongs behind an existing handler. A genuinely new product action gets one definition, handler, strict tool schema, authorization tests, and an SDK acceptance case.

`search_information` deliberately queries both visible explicit memory and eligible dynamic knowledge when available. In `agentTool` mode those handlers skip their former nested answer generator and return capped excerpts with a source kind. Formal schedule results remain distinct, so the model must label a visible note as unconfirmed rather than present it as the official roster. Wikipedia uses the same pattern: the handler fetches a bounded introduction and the SDK agent writes the answer once.

Dynamic knowledge still uses the existing `knowledge_*` read model, profile/source eligibility, lexical plus pgvector retrieval, atomic snapshot publication, and stale/unavailable semantics. The SDK sees answer evidence only; it does not receive source IDs, document IDs, section anchors, routing metadata, or provider payloads. Arbitrary topics continue to reuse `query_knowledge` instead of gaining domain-specific tools.

Thread/checkpoint scope is `(profile, source type/id, requester user id)`. The value is HMAC-derived and contains no LINE identifier. A group without requester identity does not run the SDK. Production state uses `PostgresSaver`; local state uses `MemorySaver`. `agent_sdk_threads` stores only thread ID and expiry timestamps. Same-thread `run` holds a PostgreSQL advisory transaction lock; expiry deletes the metadata row and calls the official checkpointer's `deleteThread`.

The helper system prompt concatenates the checked-in persona, checked-in memory policy, current time, source-separation rules, untrusted-page rule, and preview-only write rule. `MEMORY.md` is policy, not writable memory. Runtime checkpoints have the short agent TTL; explicit text memory retains its existing 30-day lifecycle and visibility rules.

Writes stay minimal and server-bound. `save_schedule`, `save_memory`, and `save_resource` tool schemas omit `confirm` and `cancel`, so they can only create an existing preview session. Confirmation arrives in another LINE event and reuses the established requester/source scope, Account check, revision guard, audit, idempotency, and handler. A bare confirmation is consumed before the SDK sees it.

External sheet-music tools exist only after an existing consent session is atomically consumed. Search results are mapped to invocation-local `web-N` references. The reader accepts only those references, validates public HTTPS/DNS/redirects, caps content, strips active HTML, and marks text untrusted. Direct PDF/JPEG/PNG candidates are copied into the existing external-import selection; the attachment worker remains the sole download/scan/publish path.

Keep diagnostics separate from checkpoints. Operational traces remain bounded metadata and must never serialize SDK messages, system prompts, evidence, URLs, people, filenames, or provider payloads. Checkpoints are business state with explicit TTL and deletion behavior, not observability records.

Verification ownership:

- SDK loop and official middleware: `src/__tests__/sdk-agent.test.ts`
- tool visibility, schemas, authorization, and projections: `src/__tests__/sdk-tools.test.ts`
- scope, serialization, and expiry: `src/__tests__/sdk-state.test.ts`
- helper/main dispatch and pending-flow precedence: `src/__tests__/sdk-turn-runtime.test.ts`
- public page trust boundary: `src/__tests__/public-page.test.ts`
- real PostgreSQL checkpoint restart/cleanup: `pnpm eval:kernel:integration`
- live DeepSeek tool calling: `pnpm eval:sdk-agent --live`

## Admin Cookbook

To add or change an admin action:

1. Add the action name and metadata in the admin action catalog.
2. Keep execution in the admin action registry, not inline in `server.ts`.
3. Define source policy, side-effect level, and confirmation requirements.
4. Add slash command help only if a command is user-facing.
5. Add natural-language admin routing for direct-chat admin use by default. Do not reintroduce retired function-scope grant/revoke/list actions.
6. Audit the action and keep `/last-routes` sanitized.
7. Add policy and observability tests.

Run `pnpm eval:admin` after changing admin natural-language routing.

## State And Locking

Short-lived state can use memory locally, but production should use Redis when
multiple replicas or restarts matter.

- `src/state/*`: pending clarifications and selection sessions.
- `src/cache/*`: shared short-lived state caches. Resource query results are not stored in an unversioned cache; any future query cache must bind profile, source, capability contract, normalized query/options, and source publication revision.
- `src/agent/sdk-state.ts`: helper checkpointer scope, same-thread serialization,
  consent TTL, and checkpoint cleanup. Other `src/agent/*` files retain explicit
  text/resource memory and the `main` compatibility runtime.
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

Helper checkpoint context never grants authority. Tool construction and every
call use the current effective profile, so permission revocation or source
disablement takes effect before another handler execution. One-shot selections
use an atomic take, and resource-memory rows are deduplicated by storage
identity with verification, revision, and tombstone metadata. Redis makes
selection and webhook-event consumption cross-replica; PostgreSQL separately
persists and serializes SDK checkpoints.

Long-running job results are separate from in-flight locks. They are keyed by a
random job id but can only be read from the same profile, LINE source, and
requester user id. With Redis configured, job results survive app restarts until
their TTL expires.

General public web lookup is intentionally not supported. `query_wikipedia`
uses the fixed Wikipedia API. Sheet music has one consented exception: after a
local miss, the helper SDK may iteratively call internal SearXNG and read the
opaque public HTTPS references it returned. The page reader permits bounded
HTML/text and direct PDF/JPEG/PNG detection, revalidates/pins public DNS and
redirects, strips active markup, and exposes no arbitrary URL parameter to the
model. Reading never saves a result. An authorized requester may select and
confirm a detected direct file; the finite attachment worker then performs the
actual download and the existing Asset scan/publication lifecycle.

Catalog-backed lookups are separated from user-facing function names. The
canonical functions are `find_ppt_slides`, `find_sheet_music`, and
`find_resource`; they should call the catalog/search layer with different
filters instead of implementing separate source-specific searches. Future OneDrive-backed
folders such as weekly report audio should be added as a `catalog_sources` row,
an item kind value, resolver aliases, and tests; they must not add another
OneDrive crawl/search implementation.

SDK tool schemas handle service schedules, slides, sheet music, church
resources, weekly report audio, and Wikipedia. Existing slot sessions still ask
for required topic/title/date values when a preview or continuation owns the
turn; strict schemas reject model-invented extra fields.

Service schedules are intentionally separated from file catalog items. Notion
media-team schedule sources are registered through the same source config, but
the scheduled sync job writes them into `schedule_items` as read-model rows with
`origin=notion`. `query_schedule` checks this read model before falling back to
live Notion. LINE-created schedules remain write-controlled through the schedule
memory flow and must not write back to Notion-origin rows.

`query_schedule` uses the reusable field-interpretation and domain-resolution
contracts. SDK-provided arguments remain advisory input, while the handler's
field interpreter deterministically fills recognizable
dates, months, meetings, roles, and participants without selecting storage.
The profile registry exposes product concepts and bindings rather than storage
implementation names. One grounded match selects a domain; multiple matches
always ask which schedule the requester means and resume the original grounded
arguments after the choice. Terms consumed by typed fields and the selected
domain alias are removed before residual text reaches search. A genuinely
separate future query behavior may add an adapter and capability contract, but
new existing-schema schedule domains change registry data only, and arbitrary
knowledge topics remain inside `query_knowledge`. The generic router must not
accumulate function-specific residual-query rules.

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
explicit confirmation, the handler atomically persists scoped work in a durable
enqueue outbox and queues only its opaque ID. A queue send must be durably
marked before the user sees a queued-success reply; ambiguous Redis/queue
failures remain pending for bounded retry. An event-driven ACA Job leases one
queue item, atomically claims the work with a token and expiry, and only then
performs the bounded LINE Content API or authorized external-file download,
actual-size, MIME/magic-byte, extension, safe-filename, and hash checks. It then
persists a non-secret upload descriptor, creates an idempotent Asset upload,
waits for Asset's durable ClamAV result, grants and downloads only a clean
asset, and validates the persisted checksum, size, and detected MIME before
publication. Work that already has an Asset identity resumes entirely through
Asset; a lost Asset-ID record is recovered by replaying create with the same
work ID and descriptor before another source download. Expired pre-publication
claims are reclaimable, but expired `publishing` work becomes the observable
terminal `publication_abandoned` state rather than being blindly republished.
Stale workers cannot mutate the terminal work state or requester-scoped job.
Completion and failure commit the Redis work CAS together
with a bounded pending job update before the job-store write. Queue redelivery
reconciles that idempotent update before acknowledging terminal work, closing
the crash window between the two Redis records. Claim disposition distinguishes
pending scan or legitimate claim/publication contention from terminal and
missing/expired opaque work. Only durably completed, permanently failed, and
missing work is acknowledged; transient dependency failures atomically release
their claim and remain queued for redelivery. The 10-minute scan, 14-minute
publication, 15-minute replica, 1-minute acknowledgement margin, 17-minute
visibility, 20-minute claim, and 60-minute retention policy is tested as one
ordered invariant. OneDrive upload and catalog upsert form one logical commit; catalog
failure compensates by deleting the uploaded Graph item. Asset API is the sole owner
of quarantine Blob state, ClamAV signatures and execution, scan lifecycle,
grants, and clean download. Any status other than `clean` fails closed. The LINE
Job has one replica per execution, uses a dedicated managed identity, and has no
storage key, queue connection string, ClamAV state, channel secret, admin ID,
LLM/Notion credential, or observability secret. The
`xiaoha_database` manual source is skipped by catalog sync and receives a 90-day
catalog `expiresAt`; formal synced sources do not. Successful publication
records opaque drive/item metadata as a recent general resource, so a scoped
task-frame follow-up such as `剛剛那份` can re-enter `find_resource` with the exact
catalog item reference and regenerate a temporary link without storing the link
itself. Catalog full/delta publication atomically advances source revision,
health, cursor, items, and tombstones. Retrieval distinguishes fresh,
stale-but-allowed, unavailable, and genuine not-found. Recent resource memory is
only a ranking signal for a currently authorized candidate, and Graph identity
is validated again immediately before a temporary link is created.

LINE binary bytes travel in the bot's outbound Content API response, not through
the inbound webhook body. Gateway, Dapr, and Fastify webhook body limits are not
attachment-size controls and remain unchanged.

## External Dependencies

Function dependencies are intentionally behind ports/clients:

- LINE: `src/clients/line.ts`
- Asset API attachment client and finite worker: `src/clients/asset-api.ts` and
  `src/tools/run-attachment-worker.ts`
- SearXNG web search: `src/clients/searxng.ts`
- consented public page reader: `src/clients/public-page.ts`
- helper DeepSeek SDK model: `@langchain/deepseek` in
  `src/bootstrap/create-production-runtime.ts`
- legacy/admin DeepSeek provider: `src/clients/deepseek.ts`
- Azure OpenAI embeddings: `src/clients/azure-openai-embedding.ts`
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
- Wrong helper function or missing cross-source evidence: `src/agent/sdk-tools.ts`,
  the owning function definition/handler, and SDK tests. For `main`, inspect the
  legacy candidate/planner/validator path.
- Missing query or wrong slot: `src/function-arguments.ts`,
  `src/functions/argument-normalization.ts`, `src/agent/slot-clarification.ts`,
  and clarification tests.
- Group clarification or selection goes to the wrong person:
  `src/state/session-safety.ts`, `src/requester-personalization.ts`, and
  requester-scoped session tests.
- Duplicate long task replies: `src/in-flight/*` and
  `src/application/turn/stages/function-execution-stage.ts`.
- User asks twice because a task is slow: `src/agent/jobs.ts` and
  `handleAgentTextTurnWithLongJob` in `src/transport/line/postbacks.ts`.
- Follow-up without wake word fails for same user: `src/agent/context-manager.ts`
  and the conversation window checks in
  `src/transport/line/webhook-routes.ts`.
- Wikipedia lookup has no result: `src/wikipedia/client.ts` and
  `src/wikipedia/lookup.ts`.
- Helper follow-up state fails: `src/agent/sdk-state.ts`, PostgreSQL checkpoint
  tables, and `src/__tests__/sdk-state.test.ts`. Explicit memory failures remain
  in `src/agent/*memory-store.ts` and memory tests.
- Admin command denied: account-api LINE binding, Account `admin` role,
  `adminDirectOnly`, admin command parser, action policy tests.
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
pnpm eval:sdk-agent
pnpm eval:retrieval-product
pnpm eval:kernel
pnpm eval:kernel:integration
pnpm build
```

Run `pnpm eval:sdk-agent --live` manually when DeepSeek credentials are
available. It is a bounded helper acceptance check, not a CI dependency. The
legacy `eval:agent:live` remains only for the compatibility router.

Run `pnpm eval:kernel:local-live` manually for the disposable signed-webhook
Kernel gate. It composes only synthetic local app/PostgreSQL/Redis state, uses
real DeepSeek routing and Azure embeddings under a serialized 10/3 request
ceiling, captures replies locally, and never calls production LINE, Graph,
Notion, OneDrive, queues, or ClamAV. Its secrets are fetched from ACA into
memory-backed mode-`0600` files and are removed with the run-scoped Compose
resources on every exit. This gate is intentionally excluded from CI.

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

## R5.0 Release Assurance

R4.1 production verification and R5.0 production acceptance describe the prior
controlled-agent release. The authorized helper SDK redesign is a new change
and requires its own PR CI, release, and production acceptance before those
claims apply to it. No SaaS or local-model expansion is implied.

The deploy transaction snapshots a known-good revision and image, deploys the
target, and writes `artifacts/release-assurance/report.json`. Its release probe
uses separately signed empty `events: []` webhooks for `helper` and `main` and
records zero provider calls. The two explicit checks prove the
Gateway→Dapr→selected-profile route, configured signature acceptance, and
empty-batch early return only. They do not prove LINE platform delivery, LINE
Console secret correctness, reply-token behavior, or provider availability in
normal turns; the zero-provider count describes this release path, not runtime
telemetry. Failed release gates copy the known-good revision into a
new rollback revision and restore changed job images; a manual image update is
only the bounded emergency fallback. Weekly dependency evidence is separate:
`hhc-line-bot-periodic-assurance` writes
`artifacts/release-assurance/periodic-report.json` after its own run. Its bounded
Asset lifecycle check uploads only fixed tiny clean text under a unique
assurance owner with restricted visibility, grants service-read access, verifies
the clean scan and downloaded bytes, then revokes and owner-verifies the exact
soft-delete in cleanup. Cleanup failure fails the assurance; the check exposes
no public URL and does not call LINE, Graph, or the catalog.

The production boundary adds two fail-closed checks without a second assurance
system. Before mutation, `scripts/deploy-aca.sh` compares the human-confirmed
LINE Developers Provider checkpoint with the single provider ID enforced by
profile configuration. Repository data cannot prove Console ownership. After
the new bot revision is ready, `account_preflight` runs inside that revision so
its Dapr sidecar supplies the verified `hhc-line-function-bot` workload
identity. Account's private preflight accepts only profile and function names,
checks exact derived permission-record existence, and never provisions RBAC.
The same probe uses disposable values to require an unbound identity result and
an expired/unknown binding rejection. Its allowlisted output contains only
function names and outcomes. API Gateway independently rejects `/priv/*` with
`404`, strips caller identity headers, and exercises a forged-header negative
probe; Account ACA itself must continue to have no ingress. Together these
checks prove only those routing, workload identity, lookup, binding, and RBAC
record boundaries—not LINE delivery, Console configuration, or real-device UI.

The accepted baseline is production release
[30237001171](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237001171),
which deployed revision `hhc-line-function-bot--0000149` with all 15 checks
passing, and weekly assurance
[30237568728](https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/30237568728),
whose seven dependency checks passed. Both reports attest zero DeepSeek and
zero embedding requests.

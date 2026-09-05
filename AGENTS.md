# AGENTS.md

## Startup Context

- This repo is `hhc-line-function-bot`, a TypeScript/Fastify LINE webhook service.
- `helper` uses one LangChain/LangGraph agent with DeepSeek and server-owned tools.
- `main` is a deterministic provider-free runtime for public and self-service functions.
- Runtime behavior is controlled by bot profiles, capability toggles, access policy, and state stores.
- Group context is requester-scoped and short-lived; never feed raw whole-group chat into the model.
- Public `/healthz` is minimal liveness. Public `/readyz` checks only Postgres and Redis. Detailed dependency status belongs in admin-only direct-chat `/diag`.
- Keep public repo safety in mind: never commit real `.env` files, tokens, IDs, or secrets.

Read these first when starting work:

1. `README.md` for product behavior, configuration, commands, and deployment context.
2. `docs/architecture-context.md` for request flow, boundaries, and debug entry points.
3. `src/transport/line/webhook-routes.ts` for signed ingress, access checks, commands, and exceptional workflows.
4. `src/runtime/profile-runtime.ts`, `src/runtime/main-runtime.ts`, and `src/helper-agent/runtime.ts` for profile dispatch.
5. `src/helper-agent/agent.ts`, `state.ts`, `policy-gateway.ts`, `read-tools.ts`, `write-tools.ts`, and `review.ts` for model, context, authority, tools, and HITL.
6. `src/runtime/action-executor.ts` and `src/capabilities/catalog.ts` for side effects and capability metadata.
7. `src/transport/line/attachment-intake.ts`, `src/state/*`, `src/cache/*`, and `src/redis.ts` for deterministic workflow state.
8. `src/__tests__/*` before changing behavior; tests are the executable map.

## Current Product Shape

- One service can host multiple LINE bot profiles on canonical webhook paths, for example `/api/line/webhook/helper`.
- Profile names must be lowercase URL-safe names, and `webhookPath` must equal `/api/line/webhook/{profileName}`. Do not reintroduce `/line/{profile}/webhook`.
- Each profile has its own LINE credential references, access policy, wake-word behavior, and enabled functions.
- The intended split is:
  - `helper`: managed direct users/groups, registration enabled, DeepSeek SDK agent.
  - `main`: public direct users, groups blocked, registration disabled, provider-free, with public Weekly Paper download and Account-authorized own-profile updates.
- Access registration is profile-scoped. Do not make user/group registration global unless the user explicitly asks.
- Administrator authority comes from a current linked Account administrator role and is rechecked for each protected operation. Legacy bootstrap or allowlist fields should not be reintroduced.
- Production profile source is `config/profiles.json`, loaded from `PROFILE_CONFIG_PATH=/app/config/profiles.json`. It must use `channelSecretEnv` and `channelAccessTokenEnv`; do not put real LINE credentials or user IDs in the file.
- The LINE bot must not expose provider OAuth callback routes. Do not add `/api/line/llm-auth/*`; use API keys from ACA/local secrets for remote providers.
- Remote API providers such as `deepseek` are profile-scoped; `main` intentionally keeps an empty provider allowlist.
- Helper persona and memory rules come from `config/agents/helper/PERSONA.md` and `MEMORY.md`, loaded through restricted profile-relative paths. Treat them as read-only prompt policy and never append runtime content. Keep house-church quote/golden-sentence behavior out of the persona; it should become a separate function if needed.

## Function Surface

The first-class functions are:

- `find_ppt_slides`: search configured `.pptx`, `.ppt`, `.key`, or `.odp` presentation files and return temporary sharing links.
- `query_schedule`: query configured service schedule sources and return a focused service list without exposing the source.
- `find_sheet_music`: search the catalog-backed pop and hymn sheet-music sources and return temporary sharing links.
- `find_resource`: search authorized general church catalog sources without competing with explicit schedule, slide, or sheet-music intent.
- `query_wikipedia`: query Wikipedia for supported factual lookups.
- `query_knowledge`: query admin-registered, profile-shared Notion knowledge through PostgreSQL full-text plus pgvector retrieval and a grounded LLM answer; do not create travel/SOP-specific variants.
- `save_schedule`: preview and manage profile-shared structured service schedules with one-year retention.
- `save_resource`: controlled LINE image/file attachment intake with purpose, validation, ClamAV scanning, confirmation, OneDrive publication, catalog upsert, and audit. It is enabled on `helper`, but write-function policy keeps it Account-admin/permission only.
- `save_memory`: explicit 30-day text memory with preview/confirmation. It is enabled on `helper`, but only Account-authorized requesters can write and explicitly create group-visible memory in a registered group.
- `retrieve_memory`: query visible explicit text memories in the current LINE source. It is enabled as a profile-global read function on `helper`.
- `update_own_profile`: direct-only first/last-name update for the linked active caller, using exact intents, deterministic required-field collection, preview, a live Account binding check, and explicit confirmation. It is self-service only on provider-free `main` and never creates task or memory state.
- Intro/help behavior is not a normal function execution path; keep it friendly and do not expose implementation details such as OneDrive or Notion to ordinary users.
- User functions, admin actions, and system actions are separate action kinds. Do not add management behavior to `enabledFunctions`.
- Admin natural language is direct-chat only. It may route to selected admin actions, currently invite-code creation, after admin identity and source policy checks.
- Admin actions must go through the action catalog, policy gate, admin action registry, audit, and sanitized route observability.
- Destructive admin actions must use `/confirm <code>`. `security_change` actions such as invite-code creation remain admin direct-only and audited unless explicitly reclassified.

When adding or changing a function:

- Add or update the function definition.
- Include capability metadata: `displayName`, `shortDescription`, `examples`, `requires`, `scope`, `sideEffectLevel`, `allowedSources`, `requiredSlots`, `resourcePolicy`, `memoryPolicy`, and `clarificationPrompt`.
- Every helper function must provide a bounded intent list and semantic tool description. Keep authority and validation in the server-owned tool adapter and handler schema.
- Read handlers must return a structured `agentResult` envelope for success, not-found, ambiguity, and unavailable outcomes. Expose only bounded safe evidence and reply data to the SDK model.
- Arbitrary administrator-added knowledge domains—including trips, SOPs, policies, and ministry material—must reuse dynamic-source metadata plus `query_knowledge`; do not add per-domain adapters or capabilities. Add a source adapter only for a genuinely new storage/API technology behind the existing product capability, and add a new capability contract only for genuinely separate product behavior. Never add function-specific branches to the helper SDK wrapper or top-level workflow flow.
- Add it to `CAPABILITY_CATALOG` and update the owning helper read/write tool or narrow `main` handler.
- Keep missing-value behavior in the schema/domain contract or the narrow deterministic `main` flow.
- Add postback/numeric selection behavior if multiple results are possible.
- Add tests for enabled, disabled, unclear, deny, missing-slot, and multi-result cases.
- Add SDK tests for tool visibility, strict arguments, authorization recheck, bounded evidence, checkpoint isolation, and write preview behavior. Add direct-handler tests when `main` is affected.
- Update README and this file if the behavior changes how agents should work.

When adding or changing an admin action:

- Add the action name and metadata to the action catalog.
- Add or update policy tests for auth, source policy, side effect, and confirmation behavior.
- Register the handler in the admin action registry instead of adding execution logic to `server.ts`.
- Add admin router/eval cases and run `pnpm eval:admin`.
- Add observability tests that verify `/last-routes` does not expose raw messages or secrets.
- Keep telemetry, last routes, and last errors sanitized by construction.

## Architecture Map

- `src/index.ts`: load configuration, create the production runtime, and listen.
- `src/bootstrap/create-production-runtime.ts`: sole production composition root.
- `src/transport/line/webhook-routes.ts`: signed LINE ingress, access/engagement checks, commands, postbacks, deterministic attachment and selection flows, then profile dispatch.
- `src/runtime/profile-runtime.ts`: maps one profile name to one runtime.
- `src/runtime/main-runtime.ts`: deterministic Weekly Paper and own-profile behavior with zero model or embedding calls.
- `src/helper-agent/runtime.ts`: helper turn construction, effective capability projection, review resume, authoritative result selection, and bounded error response.
- `src/helper-agent/agent.ts`: the sole `createAgent` composition and context/call middleware.
- `src/helper-agent/state.ts`: HMAC thread scope, 30-minute direct and 15-minute group idle TTL, reset, cleanup, research consent, and same-thread serialization.
- `src/helper-agent/policy-gateway.ts`: strict arguments, source policy, per-call authorization, bounded typed projection, and tool budget.
- `src/helper-agent/read-tools.ts` and `sheet-music-tools.ts`: separate authority-specific read tools and consented public research.
- `src/helper-agent/write-tools.ts` and `review.ts`: proposal tools and opaque one-shot HITL review state.
- `src/runtime/action-executor.ts`: live authorization, policy/revision checks, idempotent execution, and durable result persistence.
- `src/capabilities/catalog.ts`: canonical capability metadata and definitions.
- `src/transport/line/attachment-intake.ts`: the only executable LINE attachment intake path.
- `src/architecture/dependency-rules.ts`: enforced import direction used by `pnpm architecture:check`.
- `src/testing/*`: explicit in-memory construction for tests; production code must not import it.

The retired SDK compatibility wrapper, turn-state engine, generic pending/slot/resolution orchestration, factory-array module registry, and semantic router are absent. Do not recreate them. Helper ambiguity and follow-up stay in the requester checkpoint and make a fresh authorized tool call. `main` keeps only its narrow profile-update session.

## Access And Admin Model

- Ordinary users should use natural language, `/registry <code>`, `/help`, or `/whoami`.
- Slash admin commands are gated by the linked Account administrator role or DB-managed admin principals.
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
- Ordinary requesters receive profile-global read functions not listed in `permissionRequiredFunctions`.
- Account authorization is the only per-user function expansion. Recheck restricted tool calls, collection, preview, and confirmation continuations before execution.
- Historical user/group grants and role-capability bindings remain stored for rollback but never expand effective functions.
- Hide or reject `/function-grant`, `/function-user-grant`, their revoke/list variants, and matching natural-language admin actions. Do not drop the legacy tables.

## Capability Contract

- Every `CapabilityName` has one entry in `CAPABILITY_CATALOG` with its definition and handler factory.
- Every helper-enabled definition has a semantic description and strict argument schema.
- Read tools have separate authority names: official schedule, presentations, sheet music, resources, knowledge, saved notes, and Wikipedia.
- The server owns latest/default resolution. The model omits unknown date/version values; the domain selects the latest valid schedule or catalog revision.
- A model proposal never grants authority. Tool construction projects the effective set, and `src/helper-agent/policy-gateway.ts` rechecks source, Account authorization, schema, and side-effect policy for every call.
- Read handlers return typed success, not-found, ambiguity, and unavailable results. Model evidence is capped at 2,000 characters or 10 records and excludes internal IDs, URLs, prompts, payloads, and temporary sharing links.
- Side effects use proposal tools, HITL review, and `src/runtime/action-executor.ts`; model output cannot confirm or commit.
- Keep `pnpm eval:agent`, `pnpm eval:sdk-agent`, and `pnpm eval:kernel` deterministic and offline. They use the same evaluator. Use `pnpm eval:sdk-agent --live` only for the manual bounded DeepSeek suite.
- Keep `pnpm eval:retrieval-product` deterministic and offline.

## State And Persistence

- In-memory stores are acceptable for single-replica local/dev behavior.
- `REDIS_URL` moves sessions, cache, recent errors, rate-limit state, and registration invite codes to Redis.
- `REDIS_URL` also moves destructive-action confirmation codes to Redis.
- `REDIS_URL` also moves requester-scoped conversation windows and long-running job results to Redis.
- Redis rate limiting must use atomic counters, not read-modify-write JSON buckets.
- PostgreSQL backs managed access principals and audit events when registration is enabled.
- PostgreSQL backs agent memory when configured. The app creates access and agent memory tables on startup.
- PostgreSQL also backs the official helper LangGraph checkpointer and the short-lived `agent_sdk_threads` TTL index. Delete expired checkpoint chains; never treat checkpoints as audit logs or durable user memory.
- PostgreSQL must not store remote provider API keys, access tokens, or refresh tokens. Use it only for policy, registry, audit, and memory/catalog metadata.
- Remote provider API keys belong in ACA secrets or local `.env`, never in PostgreSQL or committed files.
- Agent memory must not store temporary sharing links. Store Graph drive/item metadata and regenerate short-lived links on demand.
- Successful PPT and sheet-music lookup metadata is a controlled `read`-function exception: it may store short-lived, scope-local resource metadata for recall, but it is not user-authored saved content and must not store raw files or generated sharing links.
- External resource memories may store user-provided URLs, but only when the user explicitly asks the bot to remember/save/store that resource.
- Recent resource recall is requester-scoped. Resource aliases and explicit text memories are scoped to the current profile and LINE source.
- Automatic resource aliases are retired and must never execute before a function handler. A new explicit lookup always searches; Helper follow-ups must call a currently authorized tool. Resource memory is deduplicated candidate metadata, not an authoritative response cache. Catalog full and delta syncs publish items, tombstones, cursor, source revision, and health atomically. Retrieval must distinguish fresh, stale-but-allowed, unavailable, and genuine not-found. Resource memory may only rank currently authorized catalog/provider candidates, and Graph items must be validated immediately before creating a sharing link. Do not add unversioned resource-query or negative caches.
- Structured schedules are profile-shared, not requester/source-scoped. The same helper schedule can be queried from managed direct chats and groups.
- Dynamic knowledge sources are profile-shared. They default to permanent; an explicit expiry disables search immediately and schedules purge after 30 days. The existing Bible Azure AI Services `text-embedding-3-small` deployment produces 1536-dimensional embeddings; PostgreSQL stores vectors, not model files.
- Dynamic knowledge core/lifecycle fields and routing metadata are staged and promoted only by a successful atomic snapshot publication after fetch, chunk, and embedding preparation. Document/node/chunk replacement, tombstones, embeddings, promoted routing metadata, live core/lifecycle fields, sync health, and a rotated staging revision become visible in one memory operation or PostgreSQL transaction; failure health updates require the invocation's expected revision, so stale admin/scheduled sync failures do not overwrite a newer ready snapshot. The staging migration marker must preserve a later staged permanent (`NULL`) expiry across restarts. A failed sync preserves the prior live snapshot, and re-adding a disabled/expired source does not reactivate it before promotion. Never-successfully-synced sources cannot route, anchor, or search. Helper tool results must not expose internal source IDs, URLs, prompts, or provider payloads. Helper tool mode may receive only capped authorized excerpts with a generic `knowledge` source kind; do not include source/document/section IDs, titles, URLs, or provider payloads. Genuine cross-source ambiguity continues through the existing requester-scoped selection state.
- Structured schedule replacement and entry add/update/delete require preview and confirmation. The same schedule type and month has one active canonical record.
- Schedule domains belong in the profile-scoped `schedulePolicy.domains` registry. Add an existing-schema domain by changing registry/binding data; do not add domain-specific router or `query_schedule`/`save_schedule` branches. Multiple domain matches must clarify. Write previews are bound to the domain revision and canonical schedule-source refreshes publish atomically.
- Do not add automatic group-chat recording. Text memory must be explicit user intent.
- LINE attachment download/storage is allowed only through the controlled `save_resource` pending-attachment flow. Direct chat may create a short-lived requester/source-scoped pending attachment session. A group must first receive a requester-scoped, two-minute, one-shot upload intent from an explicit activation phrase; unrelated group attachments remain silent. The requester must opt in, choose one of the four declared purposes, enter a title, review the preview, and explicitly confirm. Final confirmation may persist and enqueue only one opaque work ID through the durable outbox. The event-driven ACA attachment worker leases one queue message and claims work with a bounded token lease; expired pre-publication claims are reclaimable, stale tokens cannot mutate a newer claim, and queue delivery is acknowledged only after a durable completed, permanent-failure, or missing outcome. Persist the non-secret Asset upload descriptor before upload. Once work has an Asset ID, retry through Asset get/wait/grant/download and validate the persisted checksum, size, and detected MIME without redownloading LINE or external content. If Asset completion succeeded before the Asset ID was recorded, replay the same idempotent create before considering another source download. Transient dependencies and pending scans release the live claim atomically and remain unacknowledged. Never reclaim or blindly replay expired `publishing` work; expose it as `publication_abandoned` because Graph/catalog may already have committed. Do not download in the bot process, pass queue content to the scaler, or add another binary publish path.
- The attachment ACA Job has no ingress, one replica per execution, `0.5 CPU / 1 GiB`, a bounded timeout, and no storage mounts. It downloads the source, delegates malware scanning and signature assurance to Asset API, and publishes only a durable `clean` asset.
- Agent turn traces are diagnostic metadata only. Do not store raw user text, file names, invite codes, secrets, generated sharing links, agent messages, prompts, or tool payloads in traces.
- Helper resource replay and follow-ups must use the scoped checkpoint plus a currently authorized tool call. Do not reintroduce a pre-route latest-resource lookup or phrase-specific execution shortcut.
- LINE `webhookEventId` processing and one-shot selections are atomic with Redis. Without Redis these guarantees are process-local only and must not be described as restart-safe or multi-replica-safe.
- Do not assume multi-replica safety without Redis for sessions/cache/invite codes.
- Group and room clarification/selection sessions are requester-scoped. They require the same `source.userId` to continue, and should not be created or matched when LINE does not provide a requester user id.
- Long-running job result retrieval follows the same requester/source rule. A group user must not be able to fetch another user's job result.
- Soft display-name personalization is for task-state replies such as "what title?" or "please choose"; avoid adding names to final data-heavy function results unless the user asks.
- Conversational bot-authored self-reference uses first person (`我`), not third-person `小哈`. Keep `小哈` only where it is the product identity (`我是小哈`), a wake word or user-facing example, a registration phrase, or a proper destination name such as `小哈資料庫`.
- SearXNG is only a sheet-music not-found fallback after requester consent. It must not become a general web browsing function or save results automatically. The helper agent may read only bounded public HTTPS pages referenced by the current search result; every DNS result and redirect is revalidated/pinned, and page text is untrusted. An authorized requester may explicitly select and confirm a detected direct PDF/JPEG/PNG result. The bot queues only the confirmed opaque work ID; the finite attachment worker owns the safe file download, rejects HTML/private addresses/unsafe redirects/authentication, and publishes through the sole Asset-scanned binary path.

## Workflow

- Use `pnpm` for package scripts.
- Prefer small, targeted changes within the final boundaries above.
- Before pushing behavior changes, run `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm architecture:check`.
- Run `pnpm eval:agent` for helper model/tool/state behavior. `pnpm eval:sdk-agent` and `pnpm eval:kernel` are aliases of that same offline implementation.
- Run `pnpm eval:sdk-agent --live` manually only when a bounded real DeepSeek check is authorized and credentials are available; never add provider calls to CI.
- Run `pnpm eval:retrieval-product` for retrieval lifecycle behavior and `pnpm eval:kernel:integration` for Redis/PostgreSQL state, lifecycle, or publication changes.
- Run `pnpm eval:admin` for admin natural-language routing changes and consider `pnpm smoke:webhook` for webhook entrance changes.
- Diagnose a failed evaluator by its boundary ID and shared contract. Do not patch example phrases or add function-specific branches to the agent loop.

Testing map:

- LINE ingress/access/admin: `src/__tests__/entrance.test.ts`.
- Helper composition/context: `src/__tests__/helper-agent.test.ts`, `helper-agent-state.test.ts`, and `helper-agent-budget.test.ts`.
- Helper tools/authority: `src/__tests__/helper-agent-read-tools.test.ts`, `helper-agent-policy-gateway.test.ts`, and `helper-agent-sheet-music.test.ts`.
- Helper runtime/review: `src/__tests__/helper-agent-runtime.test.ts` and `helper-agent-review.test.ts`.
- Main deterministic behavior: `src/__tests__/main-runtime.test.ts` and `main-direct-functions.test.ts`.
- Profile dispatch: `src/__tests__/profile-runtime.test.ts`.
- Final evaluator/docs: `src/__tests__/kernel-corpus.test.ts` and `helper-agent-docs.test.ts`.
- Store/config behavior: owning store tests and `src/__tests__/config.test.ts`.

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
- The helper agent runtime is the sole semantic agent path. `main` remains provider-free with narrow direct handlers. Do not add a shadow router or semantic fallback provider. Roll back through a reviewed application deployment while retaining DeepSeek-only helper policy.
- R4.1/R5.0 acceptance describes the prior controlled-agent release. The authorized helper SDK redesign requires its own PR, release, and production acceptance. Do not infer SaaS or local-model follow-up work.
- Release assurance is provider-free: after the provider-free job definitions are verified, the signed empty webhook probe and release report attest `providerRequests: { deepseek: 0, embedding: 0 }`; an earlier failed report omits that unverified attestation. It proves gateway/Dapr/bot reachability only, never LINE delivery or reply-token behavior. The normal rollback copies the known-good revision while pinning its resolved OCI digest into a new revision; use a manual image change only as bounded emergency fallback.

## Deployment Context

- Pull-request CI is defined in `.github/workflows/ci.yml`. Production image build and deployment are defined in `.github/workflows/release.yml`; `scripts/deploy-aca.sh` owns the shared Azure Container Apps deployment sequence.
- Images are built for `alive.azurecr.io`.
- Runtime configuration and secrets belong in Azure Container Apps/Azure secrets, not in the repository.
- This repository is public. Never commit real `.env` files, credentials, tokens, sensitive LINE or church user data, private operational exports, or secrets in source, tests, fixtures, documentation, commits, pull requests, issues, or Actions output.
- Production LINE callback traffic enters through the public `api-gateway`, whose Nginx route invokes Dapr app id `hhc-line-function-bot` at `/v1.0/invoke/hhc-line-function-bot/method/api/line/webhook/{profileName}`. The bot Container App must keep Dapr enabled with `appId=hhc-line-function-bot`, `appPort=3000`, and `appProtocol=http`; do not disable Dapr while this gateway route exists.
- The consent-only sheet-music SearXNG fallback runs in the separate `hhc-searxng` ACA app. Keep its ingress internal, its pinned image/configuration mount in `aca.searxng.containerapp.yaml`, and let `scripts/deploy-aca.sh` resolve its internal FQDN before updating the bot; never restore an office-network or public SearXNG route.
- Production deployment uses one LINE runtime image and must keep every LINE workload free of retired model/scanner endpoint families, office-network addresses, scanner ports, ClamAV packages, and signature mounts. The attachment worker must use its minimal loader and secret set; do not give it storage keys, queue connection strings, channel secrets, admin IDs, LLM/Notion credentials, or observability keys.
- Keep the bot's own ingress internal. After any Dapr or ingress change, POST an unsigned JSON body through the public API Gateway webhook path and verify the response comes from the bot as `400 {"ok":false,"error":"missing_line_signature"}`.

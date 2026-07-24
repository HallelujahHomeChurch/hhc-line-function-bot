# Controlled Retrieval Product Roadmap Design

## Status

Approved direction on 2026-07-19. This document turns the controlled-agent,
schedule-domain, cache/state-lifecycle, productization, and operations reviews
into one dependency-ordered roadmap. It does not authorize implementation by
itself; every milestone receives its own implementation plan and review gate.

## Product Decision

The product remains a restricted church helper delivered primarily through
LINE. It is not a general chatbot. Its product promise is:

> Help church workers retrieve approved schedules, meeting files, sheet music,
> and internal knowledge through natural language, while keeping permissions,
> source freshness, continuation state, and writes under deterministic server
> control.

The roadmap uses a reliability-first path:

1. make controlled decisions observable;
2. make fresh queries, continuation, memory, and cache semantically distinct;
3. make schedule domains declarative instead of router-specific;
4. apply the same source-revision and freshness contract to all retrieval;
5. productize onboarding and operations;
6. make one church deployment repeatable;
7. validate managed pilots;
8. add shared multi-tenant scale only after isolation and operations are proven.

## Why This Sequence

Three alternatives were considered:

- Fix each production symptom independently. This is fast initially but repeats
  the same lifecycle and routing failures for every function.
- Build a multi-tenant SaaS control plane first. This creates a large security
  and operational surface before the core retrieval experience is dependable.
- Stabilize the controlled retrieval kernel first, then make it repeatable and
  multi-tenant. This is the selected approach.

The first product milestone is **Controlled Retrieval Kernel v1**, comprising
R0 through R3. No self-service SaaS or billing work begins before that milestone
passes its exit criteria.

## Product Scope

### Initial users

- Churches with approximately 30 to 300 active participants.
- Teams already coordinating through LINE.
- Administrators, media teams, worship teams, schedule coordinators, and
  authorized content maintainers.
- Organizations with approved information in OneDrive, Notion, structured
  schedules, or the managed church catalog.

### Product packages

1. **Meeting workspace**: schedules, presentations, sheet music, and approved
   church files.
2. **Approved knowledge**: SOPs, plans, policies, and explicitly saved memories.
3. **Controlled stewardship**: schedule maintenance, attachment publication,
   explicit memory, source administration, audit, and freshness ownership.

### Non-goals

- An unrestricted conversational or autonomous agent.
- Automatic group-chat recording or raw-chat analytics.
- One function or router branch per ministry, trip, SOP, or schedule type.
- Model-owned permission, write, confirmation, or data-source decisions.
- A plugin system that accepts arbitrary tenant code, SQL, URLs, or planner
  authority.
- Kubernetes, Kafka, a service mesh, active-active regions, or public self-serve
  billing before managed pilots demonstrate the need.

## Cross-Cutting Architecture Contracts

### 1. Authority contract

- Capability contracts and effective permissions bound every candidate.
- DeepSeek and Ollama remain advisory providers.
- The deterministic validator, policy gate, state machine, and registered
  handler own execution authority.
- A provider may interpret current evidence but may not invent a function,
  domain, reference, permission, or side effect.
- Responses return only the requested field by default.

### 2. Retrieval lifecycle contract

The runtime must distinguish these modes in types, traces, and behavior:

```text
fresh_search
explicit_task_replay
resource_memory_candidate
catalog_snapshot_read
provider_fallback
```

- A current explicit lookup always wins over aliases, task frames, or recent
  metadata.
- Only explicit deictic language such as `剛剛那份` or `再給我一次` can replay
  an earlier opaque reference.
- Resource metadata memory may nominate or rank a candidate, but it is not an
  authoritative answer without revision or bounded metadata validation.
- Temporary sharing links are never stored; they are regenerated from a
  validated opaque resource reference.
- Negative caches have short TTLs and are invalidated by successful source
  publication.

### 3. Source and freshness contract

Every materialized retrieval source exposes:

```text
sourceRevision
lastSuccessfulSyncAt
syncStatus
staleAfter
freshnessStatus
activeSnapshotId
```

- Publication is atomic: a partially prepared snapshot is never queryable.
- A failed sync preserves the last-known-good snapshot.
- A stale snapshot is either clearly marked or rejected according to source
  policy; it is never silently presented as current.
- Rename, move, disable, deletion, expiry, and tombstone events invalidate
  dependent resource-memory candidates.

### 4. State-scope contract

All sessions, task frames, selections, aliases, resource memories, jobs, and
diagnostics are scoped by:

```text
organization / bot profile / LINE source / requester
```

Until organization UUIDs exist, the existing profile/source/requester scope is
mandatory. Missing requester identity in a group fails closed. Multi-replica
workflow semantics require Redis; unsupported in-memory multi-replica behavior
must not be presented as reliable.

### 5. Side-effect contract

- Writes require effective current permission, explicit intent, preview, and
  confirmation.
- Confirmation commits the exact normalized preview payload and does not rerun
  an LLM or parser.
- Every write and admin action has a durable idempotency key for LINE redelivery,
  timeout-after-commit, and process restart.
- Attachment scanning remains fail closed.

### 6. Privacy-safe observability contract

Store bounded decision metadata, not conversation content:

- support ID and pseudonymous query/reference fingerprints;
- capability candidates and bounded reason codes;
- planner provider/disposition/confidence bucket;
- validator reason and execution mode;
- task-frame, alias, resource-memory, and selection ages;
- result status, source revision, freshness, latency, and lifecycle outcome.

Never persist raw group chat, names, file names, URLs, content, secrets,
temporary links, or provider payloads in diagnostics.

## Roadmap

## R0 — Observable Decision Baseline

### Outcome

Production failures can be classified without screenshots or raw-message
logging.

### Scope

- Add a stable, non-PII support ID across webhook, routing, handler, source, and
  reply telemetry.
- Record privacy-safe execution mode, state age, source revision, and freshness.
- Establish an offline regression corpus for presentations, schedules, sheet
  music, general resources, knowledge, memory, and cross-function ambiguity.
- Add product events for registration, first success, clarification count,
  result class, write completion, latency, and retry.
- Define baseline task-success, not-found, ambiguity, unavailable, and stale
  rates before changing behavior.

### Exit criteria

- At least 95% of production errors are classifiable by support ID within five
  minutes without raw user content.
- A second presentation lookup can be identified as fresh search, explicit
  replay, task-frame refinement, alias recall, resource-memory candidate,
  catalog hit, or Graph fallback.
- Regression cases run deterministically and offline in CI where applicable.

## R1 — Agent State and Cache Lifecycle

### Outcome

New explicit queries cannot be replaced by a prior result, while natural
continuation remains available and requester-scoped.

### Scope

- Make current explicit capability and query evidence authoritative over alias,
  resource memory, and task frames.
- Restrict task replay to explicit deictic continuation.
- Remove the authoritative pre-handler legacy alias shortcut for new lookups.
- Audit and retire legacy automatically created aliases without deleting
  explicit user-authored saved resources.
- Change automatic resource memory to deduplicated candidate metadata with
  source revision, `verifiedAt`, and tombstone invalidation.
- Add durable webhook idempotency and atomic one-shot selection consumption.
- Document Redis and no-Redis behavior for restart and multiple replicas.

### Exit criteria

- Two different consecutive presentation queries always execute the second
  lookup.
- `剛剛那份` replays the previous opaque reference and regenerates a link.
- A new title plus a generic word such as `連結` wins over the task frame.
- Rename, move, delete, tombstone, source disable, and revision change cannot
  return a stale remembered item.
- Cross-profile, cross-source, and cross-requester state leaks remain zero.

## R2 — Declarative Schedule Domains

### Outcome

Media, morning prayer, street service, children's Sunday, prayer meeting, and
future schedule domains reuse `query_schedule` and `save_schedule` without
top-level router changes.

### Scope

- Add a profile-scoped schedule-domain registry with stable domain key, display
  name, aliases, schema version, input schema, occurrence policy, source
  bindings, origin policy, write policy, priority, revision, and freshness
  policy.
- Split schedule interpretation into a field interpreter and a domain resolver.
- Keep planner input bounded to the raw query and safe candidate summaries;
  every interpreted field requires current-span, selection, or valid task-frame
  evidence.
- Normalize Notion and LINE schedule input into canonical occurrences and
  assignments backed by atomic snapshots.
- Add domain-scoped schedule grants. Admins own domain lifecycle and destructive
  mutations; granted users can perform only permitted replace/add operations in
  existing domains.
- Migrate media, morning-prayer-family, and street-service data by count and
  checksum. Route custom schedules through explicit admin review.
- Remove `includeMedia`, `includeFamily`, hard-coded domain selection, and live
  dual-query behavior only after verified cutover.

### Exit criteria

- Adding children's Sunday and prayer meeting with existing schemas and
  adapters changes registry/binding data but produces no router diff.
- Multiple matching domains always clarify; the system never guesses.
- Follow-ups stay within the selected domain and requester scope.
- Preview confirmation fails if domain revision or permission changes.
- Partial sync, stale failure, and migration fault injection never expose a
  half-published schedule.

## R3 — Unified Retrieval and Catalog Freshness

### Outcome

Presentations, sheet music, and general files share one product-grade source,
resource-memory, freshness, and invalidation lifecycle.

### Scope

- Add atomic catalog publication revisions and source health watermarks.
- Define resource identity, rename/move/delete/tombstone behavior across Graph
  and catalog adapters.
- Use resource metadata memory only as a bounded candidate/ranking signal.
- Regenerate sharing links after current reference validation.
- Define catalog-first and live-provider-fallback policy per source; a catalog
  hit cannot hide an unacceptable stale state.
- If query caching is introduced, bind the key to profile, source, capability
  contract version, normalized query, match options, and source revision.
- Add freshness and fallback metrics for catalog, Graph, Notion, and future
  adapters.

### Exit criteria

- A successful source publication becomes visible atomically.
- Query results state whether data is fresh, stale-but-allowed, unavailable, or
  not found without revealing storage implementation.
- Newly added resources are not blocked by long negative caches.
- Resource memory cannot resurrect a tombstoned or unauthorized item.
- Restart and two-replica Redis tests produce consistent results.

## R3.1 — Remote Provider Policy and Local Runtime Retirement

### Outcome

The service no longer depends on an office-hosted runtime. DeepSeek is the only
active remote LLM provider, while the existing Bible Azure AI Services
`text-embedding-3-small` deployment supplies cloud embeddings for knowledge
retrieval. SearXNG runs as an internal, always-on ACA service and ClamAV runs as
bounded ACA Jobs. Provider and workload contracts remain configuration-backed
so a future remote API provider or infrastructure implementation can replace
either integration without capability-specific changes.

### Scope

- Replace the Ollama-based LLM and embedding runtime with separately configured
  remote chat and embedding provider contracts. Provider names, API-key env
  references, base URLs, models, timeouts, and capabilities remain
  profile-scoped configuration; keys never enter PostgreSQL or profile JSON.
- Use DeepSeek as the only active LLM provider. When it is unavailable, invalid,
  or times out, retain only deterministic candidate/validator recovery and
  fail-closed clarification or unavailable outcomes; do not send the request
  to a local or second semantic model.
- Use the existing Bible Azure AI Services `text-embedding-3-small` deployment
  at its native 1536 dimensions for the active knowledge index. Keep the
  existing PostgreSQL/pgvector retrieval and controlled result-envelope
  architecture rather than delegating knowledge search to a provider-hosted
  vector store.
- Preserve knowledge source registration, access policy, lifecycle, audit, and
  source metadata. Treat existing nodes, chunks, embeddings, routing metadata,
  and their snapshot revision as derived data: clear them in a controlled
  migration and rebuild every enabled source before atomic publication of the
  new 1536-dimensional index.
- Make embedding model identity and dimension part of the promoted snapshot
  contract. A query never mixes vectors from different embedding models. If the
  active embedding provider is unavailable, knowledge search returns an
  unavailable outcome instead of a cross-model fallback.
- Remove Ollama configuration, clients, diagnostics, tests, local-services
  runtime requirements, and deployment references after the remote replacement
  is live and verified.
- Move the consent-only sheet-music SearXNG fallback to an internal-only ACA
  Container App that remains available rather than scaling to zero. Preserve
  its existing limited purpose: it is not a general web-browsing capability and
  it never saves a result automatically.
- Move attachment scanning and publication to an event-driven ACA Job. The
  confirmed attachment workflow queues only an opaque work identifier; the job
  performs the existing validation, antivirus scan, OneDrive publication, and
  catalog upsert through the sole binary-publisher path. It reports through
  requester-scoped long-running job retrieval/postback rather than LINE push.
- Use an Azure Files share for ClamAV signature data. A scheduled ACA Job
  refreshes and validates signatures every two days; scan jobs mount the share
  read-only and fail closed when signatures are absent, older than 72 hours,
  stale, or unhealthy. No attachment bytes, file names, raw messages, or
  secrets enter queues or telemetry.
- Remove office-hosted SearXNG and ClamAV endpoint configuration, local-service
  startup requirements, and deployment references once their ACA workloads
  pass the replacement contract.
- Add provider usage, timeout, unavailable, and rebuild metrics without raw
  content, API keys, prompts, source titles, or URLs.

### Non-goals

- No second semantic LLM fallback in this milestone.
- No provider-hosted file/vector-store product and no local CPU/GPU embedding
  service.
- No public SearXNG ingress, no general web-search function, and no always-on
  ClamAV daemon.
- No migration of secrets into PostgreSQL, no raw-text telemetry, and no
  downgrade of controlled routing, access, or result-envelope rules.

### Exit criteria

- A deployment with no reachable office endpoint starts and completes all
  supported LLM, knowledge, external-sheet-search, and attachment-publication
  flows through ACA and remote providers.
- DeepSeek failure exercises deterministic recovery or a safe unavailable/
  clarification response; it never attempts a local-model connection.
- All enabled knowledge sources are re-indexed with `text-embedding-3-small`
  1536-dimensional vectors and publish atomically only after a complete
  snapshot is ready.
- Provider/model/dimension changes fail closed until a complete replacement
  index has been published.
- The remote-provider contract supports a future OpenAI-compatible provider
  through configuration and a provider adapter, without changes in capability
  handlers or the controlled router.
- SearXNG has internal ingress only and remains limited to the existing
  requester-consented sheet-music fallback.
- Clean attachments complete through the event-driven scan job; infected,
  timed-out, unavailable, duplicate, or stale-signature jobs publish nothing
  and return a requester-scoped failed result.
- Full tests, remote-provider integration tests, and the versioned Kernel gate
  pass with the revised lane policy.

## Controlled Retrieval Kernel v1 Gate

R0 through R3 form one product milestone. The gate requires:

- canonical schedule accuracy of at least 98% on the approved corpus;
- at least 85% end-to-end success across core retrieval journeys;
- less than 1% unavailable responses incorrectly presented as not found or
  unclear;
- at least 80% of genuine ambiguity resolved within two turns;
- zero unauthorized reads/writes, state-scope leaks, confirmation bypasses, or
  virus-scan bypasses;
- 90% of core read turns complete within eight seconds, with slow tasks returning
  a retrievable job result;
- all known recurrence cases for stale replay, alias recall, task-frame misuse,
  and schedule-domain confusion covered by regression tests.

## R3.5 — Modular Monolith Maintainability

### Outcome

The service remains one deployable application while new capabilities, workflow
stages, and data sources evolve through explicit dependency boundaries,
purpose-specific dependency injection, and discoverable capability modules.

### Scope

- Add automated dependency rules: only the composition root may construct
  concrete infrastructure clients; transport adapters may call application
  use cases but not infrastructure; capability logic depends on declared ports
  rather than concrete Redis, PostgreSQL, Graph, Notion, or provider clients.
- Split the Fastify/LINE entrance into focused transport adapters for webhook,
  access and registration commands, admin commands, postbacks, and health
  routes, while retaining one application deployment and canonical webhook
  paths.
- Split controlled turn orchestration into explicit, independently testable
  stages and a coordinator that preserves the existing deterministic stage
  precedence and server-owned workflow state.
- Replace oversized capability dependency contexts with narrow dependency
  interfaces owned by each capability. Production composition must not hide
  in-memory fallbacks; test composition supplies fakes explicitly.
- Move capability definition, handler, ports, and deterministic eval cases
  toward vertical slices. The central registry performs discovery and
  completeness checks only.
- Split global cross-domain types into bounded contracts for transport, access,
  agent/kernel, capability, and infrastructure boundaries.
- Permit naming, file organization, and local duplicate-code cleanup only when
  directly required by one of these boundary changes.

### Non-goals

- No microservice split, runtime DI container, decorator-based injection, or
  generic repository framework.
- No change to user-visible capability behavior, controlled routing authority,
  access policy, result-envelope safety rules, or deployment topology.
- No stand-alone formatting, rename-only, or cosmetic rewrite.

### Exit criteria

- CI enforces the declared import/dependency rules.
- `server.ts` no longer contains the business implementation of access/admin
  commands or postback workflows, and turn orchestration stages have focused
  tests.
- A capability declares only its own dependencies and can be composed with
  explicit production adapters or test fakes without a shared service-locator
  context.
- `query_schedule` is migrated as the reference vertical slice, with its
  definition, handler, ports, and eval ownership discoverable together.
- Full tests and the versioned Kernel acceptance gate remain green with no
  external behavior regression.

## R4 — Product Experience

### Outcome

Users understand what they can do, why a request failed, and whether data is
current without learning function names or storage systems.

### Scope

- Permission-aware registration confirmation, help, intro, and Quick Replies.
- Show only functions effective for the current requester and source.
- Product language for permission denied, genuine ambiguity, not found,
  unavailable, and stale data.
- Focused response projection by default, with explicit full-result actions.
- Align `save_resource` capability metadata with the actual guided attachment
  workflow.
- Add source-owner and freshness responsibility to administrator views.

### Exit criteria

- At least 70% of new registered users complete a successful core task within
  24 hours.
- Median registration-to-first-value is at most three minutes.
- At least 80% of first-time users complete a core task without documentation.
- Help never advertises a write function unavailable to the requester.

## R5 — Production Reliability

### Outcome

The service can support a managed paid pilot with an evidence-backed 99.5%
availability target.

### Scope

- Application Insights or Log Analytics metrics and alerting.
- Capability-aware dependency probes without expanding public `/readyz` beyond
  its data-plane purpose.
- Release transaction: immutable image, previous-image record, Gateway/Dapr
  smoke, signed webhook smoke, safe function smoke, scheduled-job freshness,
  and automatic or explicit rollback handling.
- SBOM, image vulnerability policy, and pinned workflow dependencies.
- PostgreSQL PITR, OneDrive retention validation, and quarterly restore drills.
- ClamAV signature/reachability monitoring and explicit degraded behavior for
  remote-provider, ACA SearXNG, and ACA Job dependencies.
- Data inventory, retention, export, deletion, source ownership, offboarding,
  incident response, and secret rotation runbooks.
- Provider data-classification policy, including a local-only lane for private
  content when required.

### Exit criteria

- Webhook non-5xx availability is at least 99.5% monthly for valid signed events.
- Initial response p95 is at most three seconds or returns a job-result path.
- PostgreSQL RPO is at most 15 minutes and demonstrated RTO is at most four
  hours.
- Every production release passes gateway, webhook, function, and sync checks or
  rolls back to the previous immutable image.
- Security bypass, duplicate committed write, and cross-scope access remain zero.

## R6 — Repeatable Church Package

### Outcome

A second church can be provisioned without changing application code or
rebuilding an organization-specific image.

### Scope

- Introduce immutable `organizationId` and `botProfileId` runtime context.
- Convert `config/profiles.json` into a bootstrap template feeding versioned
  draft/validate/publish/rollback profile snapshots.
- Add organization-scoped connector records for LINE, Graph, Notion, DeepSeek,
  Ollama, and future adapters; store only Key Vault references.
- Add source bindings, function bindings, organization identities, role
  templates, and profile-scoped grants.
- Add tenant-aware database keys, foreign keys, Redis namespaces, and fail-closed
  repository context.
- Keep initial paying organizations in dedicated deployment/database namespaces
  while using the same image and configuration contracts.

### Exit criteria

- Two organizations may use the same profile slug, source key, user/group IDs,
  and aliases without reading each other's state.
- Missing tenant context fails closed.
- Creating a second organization requires configuration and secret provisioning,
  not a code or image change.
- Connector rotation does not require a full application deployment.

## R7 — Managed Pilot

### Outcome

Three to five comparable churches validate repeatability, value, support cost,
and operational assumptions.

### Scope

- Formal onboarding and offboarding checklists.
- At least two organization administrators and one owner per source/domain.
- Privacy-safe usage ledger for active principals, function executions,
  provider use, storage, sync, uploads, and support tier.
- Core, Knowledge, and Steward package experiments.
- Base subscription plus active-principal, storage, sync, or provider overage;
  do not bill per successful answer.
- Weekly adoption, freshness, support, and cost review.

### Exit criteria

- At least two teams use the core journeys continuously for four weeks.
- At least 50% of activated users succeed in two separate weeks within 30 days.
- Enabled-group eight-week retention is at least 70%.
- At least 60% of core questions complete without asking a human worker.
- Routine administrator maintenance is at most 15 minutes per profile per week.
- Pilot support load and gross cost support a sustainable package decision.

## R8 — SaaS Scale

### Outcome

The validated managed product can safely consolidate tenants and automate
commercial operations.

### Scope

- PostgreSQL row-level security and transaction-local tenant context.
- Shared cell routing with tenant quotas and optional dedicated cells.
- Queue-driven sync, embedding, purge, migration, and backfill workers.
- OIDC control plane for organization, profile, connector, source, function,
  role, audit, route simulation, export, suspension, and deletion.
- Billing entitlements, quota enforcement, cost attribution, and support tooling.
- Canary or blue/green deployment only when release volume justifies it.

### Exit criteria

- A noisy sync or embedding tenant cannot violate another tenant's webhook SLO.
- Tenant export, restore, suspend, and delete complete with auditable evidence.
- Unknown handler versions, schema fields, source bindings, or executable tenant
  input fail publication.
- Controlled routing remains the only production authority path.

## Milestone Dependencies

```text
R0 Observable baseline
  -> R1 Agent state/cache lifecycle
  -> R2 Schedule domains
  -> R3 Unified retrieval freshness
  -> R3.1 Remote provider policy and local runtime retirement
  -> Controlled Retrieval Kernel v1
  -> R3.5 Modular monolith maintainability
  -> R4 Product experience
  -> R5 Production reliability
  -> R6 Repeatable church package
  -> R7 Managed pilot
  -> R8 SaaS scale
```

R2 may start after R1 behavior contracts are fixed, but R2 and R3 do not pass
the kernel gate until the R0 telemetry proves their production behavior. R3.1
completes before the final Kernel v1 stabilization so the integration and live
provider checks exercise the remote-only runtime. R3.5 starts only after that
stabilization gate and completes before R4 implementation; it preserves
behavior while making later product work cheaper to change. R4 may prototype
copy and onboarding during R2/R3, but it must not hide unresolved freshness or
state failures. R6 begins only after R5 establishes backup, offboarding,
release, and incident controls.

## Planning Horizon

These ranges are planning estimates, not delivery commitments. They assume one
primary implementation stream, test-first delivery, normal pull-request review,
and production observation between behavior changes.

| Milestone                             |          Indicative range | May overlap with                     |
| ------------------------------------- | ------------------------: | ------------------------------------ |
| R0 Observable baseline                |                 1–2 weeks | Regression-corpus preparation for R1 |
| R1 Agent state/cache lifecycle        |                 2–4 weeks | R2 design only                       |
| R2 Declarative schedule domains       |                 4–6 weeks | R3 catalog contract design           |
| R3 Unified retrieval freshness        |                 3–5 weeks | R4 copy/onboarding prototype         |
| R3.1 Remote provider/local retirement |                 1–2 weeks | Kernel integration test design       |
| Kernel v1 stabilization               |                   2 weeks | R4 implementation                    |
| R3.5 Modular monolith maintainability |                 2–4 weeks | R4 design only                       |
| R4 Product experience                 |                 2–3 weeks | Late R3/R5 preparation               |
| R5 Production reliability             |                 4–6 weeks | R6 tenant-model design               |
| R6 Repeatable church package          |                6–10 weeks | Pilot onboarding preparation         |
| R7 Managed pilot                      | 8–12 weeks of observation | No R8 decision before evidence       |
| R8 SaaS scale                         |           Evidence-driven | Begins only after R7 exit criteria   |

R0 through R3 therefore represent roughly 12 to 19 weeks on a single stream,
including the stabilization gate. Parallelism may shorten calendar time only
when the work does not share authority, state, migration, or production
validation boundaries.

## Delivery Model

This roadmap is intentionally not one implementation plan or one long-lived
branch. Each milestone receives:

1. a focused design/spec amendment if new decisions are required;
2. a dedicated implementation plan with exact files and tests;
3. a new `codex/*` branch created from current merged `main`;
4. test-first implementation and independent review;
5. a pull request with required CI;
6. merge and production release only after the milestone's acceptance gate;
7. post-release validation using privacy-safe traces and metrics.

The first implementation plan should cover R0 only. R1 planning begins after R0
contracts and telemetry fields are approved, so production evidence can confirm
whether legacy aliases, task-frame continuation, resource-memory short-circuit,
or catalog freshness caused each observed replay.

## Roadmap Success Definition

The roadmap succeeds when the bot feels intelligent because it preserves the
right context, asks only genuine clarifications, retrieves current authorized
data, and answers the requested field—while the server, not the model, retains
control of permissions, evidence, workflow state, data freshness, and writes.

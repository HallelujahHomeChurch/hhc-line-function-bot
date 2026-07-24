# Remote Provider and Office Runtime Retirement Design

## Status

Approved on 2026-07-24. This design defines roadmap milestone R3.1. It follows
R3 Unified Retrieval and Catalog Freshness and precedes final Kernel v1
stabilization.

## Goal

Remove all runtime dependence on office-hosted services while preserving the
restricted bot's deterministic authority boundary, safe failure behavior, and
provider replaceability.

## Decisions

- DeepSeek is the sole active LLM provider for every enabled LLM lane.
- A DeepSeek error, timeout, invalid response, or rate-limit condition does not
  invoke a second semantic model. The application uses existing deterministic
  candidate/validator recovery only when it has sufficient current-message
  evidence; otherwise it returns a controlled clarification or unavailable
  result.
- OpenAI `text-embedding-3-small` is the sole active embedding model and uses
  its native 1536-dimensional output.
- Existing knowledge retrieval data is disposable derived state. Source
  registrations, access policy, lifecycle state, and audit remain intact;
  derived knowledge nodes, chunks, embeddings, routing metadata, and snapshot
  revisions are cleared and rebuilt from enabled sources.
- The service continues to own pgvector search, retrieval policy, result
  envelopes, requester scope, and authorization. It does not adopt a
  provider-hosted vector-store product.
- Providers remain explicit configuration-backed adapters. API keys are ACA
  secrets referenced by environment variable names and are never stored in
  PostgreSQL or committed configuration.
- SearXNG becomes an internal-only, always-on ACA Container App. It remains a
  requester-consented sheet-music not-found fallback, never a general web
  capability, and never saves a result automatically.
- ClamAV becomes two ACA Jobs: an event-driven scan-and-publish job and a
  scheduled signature-refresh job. They use an Azure Files share for signature
  data; no office-hosted `clamd` service remains in the request path.

## Provider Architecture

Chat and embedding are independent provider families. A chat provider declares
its OpenAI-compatible endpoint, API-key reference, model, timeout, and
structured-output capability. An embedding provider declares its endpoint,
API-key reference, model, dimensions, timeout, and snapshot identity.

The initial configuration activates only `deepseek` for chat and only
`openai` with `text-embedding-3-small` for embeddings. The provider registry
and profile policy must permit a future named remote provider adapter without
changing function handlers, planner logic, or capability contracts. A provider
change is a configuration plus adapter change, not a database-stored secret or
an ad-hoc runtime command.

## External Search and Antivirus Execution

SearXNG is deployed as a separate internal ACA Container App in the same ACA
environment, with no public ingress and a minimum replica count of one. The
bot calls its internal endpoint only after the existing sheet-music fallback
consent and keeps the existing allowed-result and safe-download checks. It is a
workload boundary, not a new product service or general web-search surface.

After final attachment confirmation, the controlled attachment workflow creates
an atomic requester/source-scoped long-running job record and enqueues an
opaque work identifier to Azure Storage Queue. The event-driven ClamAV ACA Job
uses that identifier to load the authorized work state, then performs download,
size/MIME/magic-byte/extension/safe-name/hash validation, virus scanning,
OneDrive publication, and catalog upsert through the existing sole binary
publisher. The queue, traces, and telemetry carry no attachment bytes, file
names, raw LINE messages, URLs, credentials, or scan output.

The scan job returns a sanitized terminal state to the existing requester-
scoped job/postback retrieval path; it does not use LINE push. Confirmation
deduplication and job claiming must be atomic so a file is neither downloaded
before confirmation nor published twice.

A scheduled ACA Job refreshes ClamAV signatures onto an Azure Files share every
two days and validates the completed signature set before making it current.
Scan jobs mount that share read-only. A missing, invalid, unreadable, or more
than 72-hour-old signature set, scan timeout, scanner failure, or infected
result fails closed: it creates no OneDrive item and no catalog record. Initial
scan-job sizing is 1 vCPU and 4 GiB memory, then adjusted only from measured
queue duration, memory, and signature-load telemetry.

## Knowledge Index Migration

The existing 1024-dimensional BGE-M3 index is not compatible with the new
1536-dimensional OpenAI vector space. The migration deletes derived knowledge
snapshot tables or their rows, alters the pgvector dimension contract to 1536,
and then performs a full source resynchronization. It retains source records,
access state, lifecycle/expiry policy, and audit history.

Each source prepares nodes, chunks, embeddings, routing metadata, and a new
snapshot revision before publication. Until a source has successfully published
its 1536-dimensional snapshot, it is unavailable to retrieval and routing.
The system never compares a query vector from one model to a document vector
from another model.

The full rebuild runs as a bounded background operation. It batches embedding
requests, records only sanitized counts/statuses, and respects provider timeout
and rate-limit responses. Rebuild failure leaves a source unavailable rather
than exposing stale cross-model data.

## Failure Behavior

For LLM lanes, DeepSeek failure enters deterministic controlled routing only;
where the deterministic contract cannot establish one authorized action, the
bot clarifies or reports temporary unavailability. It never falls back to an
office or second remote model.

For embeddings, an unavailable API prevents fresh query embedding and source
publication. `query_knowledge` returns its existing unavailable result. No
fallback embedding model is used against the active index.

## Removal Scope

After replacement integration passes, remove Ollama clients, embedding clients,
environment variables, profile allowlists/policies, diagnostics, tests,
office-hosted SearXNG/ClamAV endpoints, local-services startup configuration,
and documentation. The deployment must not contact the office network during
startup, request handling, scheduled sync, background rebuild, external
sheet-music fallback, or attachment scanning/publication.

## Verification

- Provider-policy tests prove DeepSeek-only LLM lanes and no semantic fallback.
- Integration tests simulate DeepSeek and embedding-provider timeout, invalid
  response, and rate-limit failures and assert safe controlled outcomes.
- Migration tests start from a populated 1024-dimensional derived knowledge
  snapshot, preserve source/access/audit metadata, clear derived rows, rebuild
  1536-dimensional vectors, and atomically publish only complete sources.
- Deployment-contract and consent tests prove SearXNG has internal ACA ingress
  only and cannot become a general-search or automatic-save path.
- Attachment-job tests cover one-shot confirmation, opaque queue payloads,
  requester/source isolation, atomic claims, and no download before final
  confirmation.
- Scanner tests cover clean, infected, timeout, unavailable, duplicate, and
  stale/missing-signature outcomes; every non-clean outcome leaves OneDrive and
  catalog state unchanged.
- A live controlled evaluation uses only DeepSeek and confirms deterministic
  fail-closed behavior when it is unavailable.
- Kernel cases cover provider unavailability, rebuilt-knowledge lifecycle, and
  attachment-job terminal states.

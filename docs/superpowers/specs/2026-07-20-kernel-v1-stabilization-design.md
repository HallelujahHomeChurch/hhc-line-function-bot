# Controlled Retrieval Kernel v1 Stabilization Design

## Status

Approved design direction. This document defines the stabilization gate after
R0 through R3 and before R4 product-experience work. It does not authorize R4
features or tenant-platform work.

## Product Decision

The controlled retrieval kernel is accepted through a hybrid gate:

1. a deterministic, offline acceptance corpus measures repeatable behavior;
2. isolated integration scenarios verify Redis, PostgreSQL, state, migration,
   restart, and two-replica behavior;
3. privacy-safe production observations verify that deployed LINE turns follow
   the same decision lifecycle without storing raw messages.

No screenshot, single successful chat, unit-test count, or model-only score can
pass the gate by itself. Failures are classified by architecture boundary and
fixed at the narrowest reusable contract. Phrase-specific routing branches are
not an acceptable stabilization fix.

## Outcome

The R0 through R3 work behaves as one reliable controlled agent:

- it selects an authorized capability from current-message and bounded active
  evidence;
- it asks only for genuine missing or ambiguous information;
- it preserves requester-scoped continuation without replaying stale answers;
- it retrieves current authorized schedule, catalog, knowledge, and explicit
  memory data;
- it distinguishes not found, unavailable, stale-but-allowed, ambiguity, and
  permission denial;
- it projects only the field requested unless the user explicitly asks for the
  full result;
- the server remains authoritative for permissions, state, evidence,
  freshness, confirmation, scanning, and writes.

## Scope

### Core journeys

The acceptance corpus covers these product journeys:

- service schedules from Notion-backed, profile-shared structured-memory, and
  future declaratively registered domains;
- presentation lookup;
- sheet-music lookup, including consented public-search fallback boundaries;
- general catalog resource lookup;
- dynamic Notion knowledge lookup;
- explicit text-memory save and retrieval;
- controlled schedule save, preview, confirmation, and query;
- controlled attachment save, preview, confirmation, scan, publication, and
  immediate catalog retrieval;
- direct-chat and registered-group use;
- requester-scoped follow-up, clarification, numeric/postback selection, and
  explicit function switching;
- permission denial, disabled functions, unavailable dependencies, stale data,
  genuine not-found results, and long-running job retrieval.

### Recurrence families

Every previously observed failure belongs to a reusable recurrence family:

- wrapper words or polite phrasing hide the retrieval subject;
- generic service wording maps to multiple schedule domains;
- an explicit domain is lost before execution;
- a role-only follow-up loses the prior occurrence or domain;
- a fresh query replays an older resource result;
- resource memory resurrects a deleted, stale, or unauthorized item;
- required-slot collection is mistaken for small talk or another function;
- a bare confirmation escapes the pending write;
- group state is continued by a different requester;
- unavailable data is presented as not found;
- a write bypasses authorization, confirmation, file validation, or virus
  scanning;
- a restart or second replica observes a different task, selection, cache, or
  confirmation state.

New production failures must first be assigned to one of these families or to
a newly documented family before implementation changes begin.

## Non-Goals

- R4 onboarding, help copy, and first-user activation changes.
- R5 alerting, rollback automation, disaster recovery, and paid-pilot SLO work.
- New church-specific schedule branches or domain-specific routers.
- Live-model CI that depends on DeepSeek, Ollama, Graph, Notion, LINE, or
  SearXNG availability.
- Persisting raw LINE text, file names, people, URLs, provider payloads, or
  sharing links for evaluation.
- Treating synthetic fixtures as evidence of production availability.

## Architecture

### 1. Versioned acceptance corpus

A checked-in TypeScript corpus defines scenarios as product contracts rather
than function-specific test prose. Each case declares:

- stable case ID and recurrence family;
- journey and capability expectation;
- requester/source/profile context using synthetic opaque identifiers;
- one or more turns, including postback or attachment events where applicable;
- fixture state and dependency disposition;
- expected controlled decisions, result status, projection, and lifecycle;
- applicable quality dimensions and denominator membership.

Cases may contain synthetic church-style content, but no production message,
person, source ID, file name, URL, token, or secret. The corpus is immutable per
case ID: semantic changes create a new case version so score movement remains
explainable.

### 2. Deterministic kernel evaluator

`pnpm eval:kernel` runs the corpus offline through the real candidate,
planner-validation, turn-state, handler-envelope, response-projection, and
lifecycle boundaries. External adapters use deterministic fakes at their
existing interfaces. The evaluator produces:

- human-readable console output;
- a machine-readable JSON report under an ignored artifacts directory;
- overall and per-journey pass counts;
- gate metrics with explicit numerators, denominators, exclusions, and failed
  case IDs;
- recurrence-family and architecture-boundary classifications.

The evaluator never substitutes an unconstrained test router for the
production controlled flow. Model planning is advisory: deterministic cases
may supply bounded planner proposals, while a separately labeled manual live
run samples DeepSeek-primary/Ollama-fallback behavior.

### 3. Gate metrics

The evaluator owns exact metric definitions:

- **Canonical schedule accuracy:** correct occurrence, domain, requested role,
  and projected value divided by eligible schedule assertions; threshold
  `>= 98%`.
- **Core journey success:** cases that reach the expected terminal product
  outcome without an unnecessary clarification or unsafe fallback divided by
  eligible core-journey cases; threshold `>= 85%`.
- **Unavailable misclassification:** unavailable cases returned as not found,
  unclear, or fabricated divided by eligible unavailable cases; threshold
  `< 1%`.
- **Ambiguity resolution:** genuine ambiguity cases reaching the expected
  grounded execution within at most two user turns after the first
  clarification divided by eligible ambiguity cases; threshold `>= 80%`.
- **Security violations:** unauthorized read/write, scope leak, confirmation
  bypass, unsafe binary publication, or scan bypass; threshold `0`.
- **Core read completion:** eligible core read cases that either complete in
  eight seconds or return a requester-retrievable long-running job result;
  threshold `>= 90%`.
- **Known recurrence coverage:** every recurrence family above has at least one
  regression case, and every fixed production recurrence has a permanent case;
  threshold `100%`.

Performance timing uses elapsed time around the complete turn runtime with
deterministic adapter latency profiles. Production latency is reported
separately and cannot be replaced by fake-adapter timing.

### 4. Integration matrix

Integration suites run outside the ordinary unit-test process when their
dependencies are available. They verify:

- Redis restart preserves only state whose contract survives restart;
- two service instances observe the same requester-scoped task, selection,
  confirmation, job, and invalidation state;
- a different group requester cannot continue another requester's state;
- PostgreSQL migration from the supported previous schema succeeds;
- atomic catalog and knowledge publication preserves the previous good
  snapshot on failure;
- catalog additions, tombstones, and authorization changes are visible under
  the declared freshness policy;
- confirmed attachment publication becomes searchable without a stale negative
  cache;
- Graph item validation fails closed before link generation.

Integration setup must be ephemeral and idempotent. It must not use production
databases, Redis keys, OneDrive folders, LINE users, or Notion pages.

### 5. Production observation

R0 sanitized traces and product events provide a bounded observation window
after deployment. Observation aggregates only allowlisted values such as:

- capability candidates and selected capability;
- planner disposition and confidence bucket;
- validator reason;
- result status and entity types;
- active-task transition and lifecycle outcome;
- support ID, actor/query fingerprints, profile, and source type;
- product events for clarification, completion, preview, commit, and retry.

The release report compares production disposition rates with the offline
corpus and flags unexplained increases in denial, clarification, not-found,
unavailable, retry, or stale-result paths. A support case may opt into the
existing short-lived superadmin direct-chat diagnostic mode; group raw-message
capture remains prohibited.

Production observation is evidence, not authority. It can block acceptance or
create new corpus cases, but it cannot weaken the deterministic security gate.

### 6. Failure triage

Every failed case records one primary boundary:

- entrance/access;
- candidate generation;
- planner proposal;
- deterministic validation;
- slot/ambiguity resolution;
- active-task lifecycle;
- adapter retrieval;
- freshness/invalidation;
- result envelope;
- response projection;
- write workflow;
- external dependency;
- deployment/configuration.

The repair order is contract, reusable implementation, regression case, full
gate. A fix must not add function-name checks to the generic router, planner,
validator, or top-level turn flow. Function-owned behavior belongs in
declarative capability metadata, adapters, handlers, or response data.

## Commands and Artifacts

The implementation plan will introduce these stable interfaces:

- `pnpm eval:kernel` — deterministic offline acceptance gate;
- `pnpm eval:kernel:integration` — ephemeral Redis/PostgreSQL and multi-instance
  verification;
- `pnpm eval:kernel:live` — manual, non-CI planner sample when configured
  providers are available;
- `artifacts/kernel-v1/report.json` — ignored machine-readable report;
- `artifacts/kernel-v1/report.md` — ignored local summary;
- a committed redacted acceptance summary documenting version, command, metric
  results, failed case IDs, and production observation window.

`PR CI` runs the deterministic gate. Integration tests may run in PR CI only
when GitHub service containers can provide their dependencies reliably. Live
provider and production observation commands remain manual and credentialed.

## Data and Privacy

- Corpus and reports use synthetic or opaque data only.
- Failure output prints case IDs and allowlisted classifications, not raw turn
  text from production.
- Production traces retain the existing sanitized construction and retention
  policy.
- Reports must not contain LINE IDs, group IDs, source titles, file names,
  person values, URLs, tokens, prompts, or provider payloads.
- A production issue becomes a checked-in regression only after being reduced
  to synthetic inputs that preserve the architectural failure.

## Delivery and Release

Stabilization is delivered as focused PRs rather than one long-lived branch:

1. acceptance contracts, corpus schema, evaluator, and report;
2. integration matrix and CI wiring;
3. architecture fixes discovered by the gate, grouped by boundary;
4. final acceptance summary and Kernel v1 tag/release marker.

Each behavior PR must pass formatting, type checking, lint, unit tests, build,
`eval:agent`, `eval:retrieval-product`, and `eval:kernel` where applicable.
Completed PRs follow protected-main auto-merge and Production Release. A
production deployment is observed before the next architecture-fix batch.

Documentation-only planning commits do not deploy the application.

## Exit Criteria

Kernel v1 passes only when all conditions are true:

- all seven gate metrics meet their thresholds;
- deterministic, integration, and migration suites pass from a clean checkout;
- no open severity-one or severity-two recurrence remains;
- every production failure observed during the acceptance window is explained
  by a known case, external dependency state, or documented non-kernel scope;
- public Gateway/Dapr unsigned smoke reaches the bot and returns the expected
  missing-signature response;
- signed webhook and safe read-function smoke pass without writing production
  data;
- the active ACA revision is healthy and receives 100% traffic;
- the committed acceptance summary contains no sensitive data;
- the roadmap records Controlled Retrieval Kernel v1 as accepted before R4
  implementation begins.

## Rollback and Stop Conditions

- A security-gate failure blocks merge and deployment.
- A production regression after an architecture-fix release stops the next
  batch and uses the normal reviewed rollback/deployment path; no shadow router
  or runtime authority switch is introduced.
- An unavailable external dependency is reported as unavailable and does not
  justify fabricating success or weakening a gate.
- If a metric cannot be calculated from an explicit denominator, the gate is
  incomplete rather than passed.

# Single-Church Optimization Roadmap Design

## Status

Approved direction on 2026-07-26.

The approved delivery finish line is R5.0 Lean Release Assurance. After R5.0,
the product enters stable maintenance; R5.1 and R5.2 are not required roadmap
milestones.

This design replaces the remaining R4 through R8 direction in
`2026-07-19-controlled-retrieval-product-roadmap-design.md`. The completed R0,
R1, R2, R3, R3.1, Controlled Retrieval Kernel v1, and R3.5 milestones remain
historical and accepted. This document does not reopen them.

Each remaining milestone still requires a focused implementation plan, a new
`codex/*` branch from current `main`, test-first delivery, pull-request CI, and
the repository's production-deployment authorization boundary.

## Product Decision

`hhc-line-function-bot` is an internal helper for Hallelujah Home Church. It is
not a SaaS product and will not be provisioned for unrelated churches.

The supported product shape is:

- one church organization;
- one shared Azure deployment;
- one or more LINE bot profiles only when credentials or global policy truly
  differ;
- the existing managed `helper` profile for direct users and registered church
  or branch groups;
- branch use through independently registered LINE groups;
- shared canonical schedules, knowledge, and church catalog by default;
- requester- and LINE-source-scoped conversation state, selections, jobs,
  attachments, and explicit group memories.

The roadmap ends in stable internal operation. It does not lead to commercial
pilots, tenant consolidation, billing, or a self-service control plane.

## Why The Roadmap Changes

R3.1 moved every active semantic and supporting workload away from the office
computer: DeepSeek is the sole semantic provider, Azure
`text-embedding-3-small` supplies 1536-dimensional embeddings, SearXNG runs in
ACA, and attachment scanning runs through finite ClamAV ACA Jobs. R3.5 then
created enforceable modular-monolith boundaries.

Those inserted milestones invalidate several assumptions in the original
remaining roadmap:

- an Ollama connector is no longer an active or planned production dependency;
- a private-content local-model lane would reverse the approved remote-only
  runtime retirement;
- repeatable provisioning for unrelated churches is not a product goal;
- tenant keys, tenant RLS, shared cells, quotas, billing, and organization
  lifecycle automation solve a problem this service will not have;
- a three-to-five-church paid pilot is not required to validate an internal
  church helper.

The correct next investment is therefore not tenant infrastructure. It is
honest user guidance followed by lean, provider-free release assurance.

## Considered Approaches

### 1. Product experience only

Complete the original R4 user-facing work and leave production controls mostly
manual.

This is the shortest path, but it leaves known contradictions in attachment
availability and leaves releases and rollback unverified. It is rejected.

### 2. Lean single-church optimization

Correct current production contracts first, complete the internal product
experience, add a small release transaction, and then enter stable
maintenance.

This is the selected approach. It resolves present risk without creating a
platform.

### 3. Branch isolation platform now

Add `branchId` or `campusId` to every database record, Redis key, source,
workflow, and direct-chat decision.

This is rejected. LINE `groupId` already provides the actual interaction
boundary. A second branch identifier would add mapping, migration, selection,
and authorization complexity without a current requirement for private branch
data.

## Architecture And Scope Decisions

### No tenant or branch identity

Do not add:

- `organizationId`;
- `branchId` or `campusId`;
- tenant-aware repositories or Redis namespaces;
- PostgreSQL row-level tenant security;
- tenant connector registries;
- OIDC organization control planes;
- tenant quotas, billing, entitlements, or cost allocation.

The existing authority scopes remain canonical:

```text
profile / LINE source / requester
```

Access principals and function grants remain keyed by profile plus user or
group. Group and room workflow state continues to require the same requester
identity and fails closed when LINE omits it.

### Shared formal church data

Canonical schedules, dynamic knowledge sources, and catalog sources remain
profile-shared. A registered branch group with an effective read function sees
the same authorized church source as another registered group.

This is an explicit product rule, not an accidental omission. Direct chat also
uses the profile-shared formal data.

### Isolated group interaction data

The following remain scoped by profile, LINE source, and requester as their
existing contracts require:

- conversation windows and active tasks;
- clarification and numeric/postback selections;
- pending confirmations and attachment sessions;
- slow-job results;
- recent-resource evidence;
- explicit group-visible text memory.

One branch group must not continue, consume, or retrieve another group or
requester's workflow state.

### Conditional private-source extension

Do not build source visibility controls in the current roadmap. If a real
requirement later proves that one branch must not see another branch's formal
source, the smallest acceptable extension is a group-to-source audience
binding:

```text
profile_name
resource_kind
resource_key
group_id
```

Absence of a restricted binding preserves the current profile-shared behavior.
Any future restricted binding must be enforced by the same eligibility
provider across candidate generation, routing metadata, handler search, active
task validation, exact-reference replay, selection continuation, and final
sharing-link validation. Adding a final-search-only filter would be a security
bug.

Create a separate bot profile only when a branch needs separate LINE
credentials, persona, global function policy, or a complete formal-data
boundary. Do not create one profile per group by default.

## New Remaining Roadmap

```text
Completed R0-R3
  -> Completed R3.1
  -> Completed Controlled Retrieval Kernel v1
  -> Completed R3.5
  -> Completed R4.0 Production Contract Correction
  -> Completed R4.1 Internal Product Experience
  -> R5.0 Lean Release Assurance
  -> Stable Maintenance
```

## R4.0 — Production Contract Correction

### Outcome

The checked-in code, manifests, deployment script, tests, and operating
documentation describe one deployable production contract with no predictable
attachment outage.

### Scope

- Preserve the approved weekly ClamAV refresh schedule at
  `10 19 * * 0` UTC.
- Remove the incompatible age-based rejection threshold. Emit an operational
  warning when the active signature set reaches seven days, but continue
  scanning with the last successfully promoted immutable signature set
  regardless of age.
- Continue to fail closed when the manifest is missing, malformed, changes
  during scanning, comes from the future, or ClamAV cannot complete a clean
  scan. Signature age alone must never block publication.
- Preserve immutable signature-set promotion, previous-good retention, and the
  deployment bootstrap refresh.
- Align the scanner resource contract with the ACA-valid deployed pair of
  `2 CPU / 4 GiB`.
- Remove active roadmap and operating references to Ollama, local semantic
  fallback, two-day ClamAV refresh, and the obsolete scanner resource pair.
- Make ACA YAML manifests own probes, scale, resources, mounts, and schedules.
  The deployment script owns environment-specific values, secret references,
  image selection, application of the rendered manifests, and rollout
  verification.
- Remove retired bot-manifest secret and environment placeholders rather than
  relying indefinitely on post-deployment cleanup.
- Add deployment-contract tests for refresh cadence, the warning-only
  signature-age policy, resources, Dapr configuration, internal ingress, and
  retired settings.

### Exit Criteria

- Weekly refresh and the warning-only signature-age policy cannot contradict in
  CI.
- One successful refresh keeps attachment scanning available until a newer
  immutable signature set is promoted.
- One or more missed refreshes produce an operational warning from seven days
  onward without blocking publication solely because of signature age.
- Code, manifests, deployment tests, README, architecture context, AGENTS, and
  the operations runbook state the same active contract.
- Kernel v1 and the attachment security cases remain green.

## R4.1 — Internal Product Experience

### Status

Implementation and local acceptance are complete. The deterministic Kernel gate
passes 113 cases, including the seven versioned R4.1 boundaries, and the owned
Redis/pgvector PostgreSQL integration gate passes without skipped dependencies.
No DeepSeek or Azure embedding call was used for this acceptance.

Production verification remains pending the Task 9 pull-request, deployment,
and live production checks. This status does not claim LINE-platform delivery,
production adoption, or any other external acceptance evidence.

### Outcome

An authorized church member understands what the bot can currently do, can
complete a first useful task without engineering documentation, and receives
an honest next step for every controlled result class.

### Scope

- Introduce one application-owned effective-capability projection consumed by
  registration completion, `/help`, natural-language capability intro, and
  Quick Replies.
- Derive the projection only from the already computed effective profile for
  the current requester and LINE source. Presentation never grants authority.
- After successful direct-user or group registration, present two or three
  deterministic, currently authorized read examples.
- Make `/help` and natural-language capability intro agree. Do not randomly
  advertise different capabilities and do not expose function names, OneDrive,
  Notion, provider, model, or storage implementation.
- Never advertise a write function unless the current requester has effective
  write authority in the current source.
- Define first-person Traditional Chinese response states for permission
  denied, missing input, genuine ambiguity, not found, unavailable, stale
  data, and successful focused results. Every non-success state includes one
  bounded next action when an action is available.
- Prefer a focused answer. Offer an explicit full-result action only when the
  result contract supports it.
- Align `save_resource` metadata and discovery copy with the real attachment
  workflow: activation, attachment, purpose, title, preview, confirmation,
  scan, publication, and requester-scoped result retrieval.
- Add administrator-facing group summaries containing display name, active
  state, effective function names, and last privacy-safe success metadata.
- Add source-owner and freshness-responsibility metadata to administrator
  views without exposing storage details to ordinary users.
- Reuse privacy-safe product events for registration, first success,
  clarification, result class, write completion, and retry. Do not add raw
  message analytics.

### Exit Criteria

- Automated direct-user, group-user, granted-user, and admin cases prove that
  discovery shows exactly the effective capability set.
- Help never advertises an unavailable write.
- Registration completion offers an executable core read journey.
- Every controlled result class has stable copy and a tested next action.
- Two synthetic branch groups share formal schedules, catalog, and knowledge
  while their requester state, selections, jobs, attachments, and explicit
  group memories remain isolated.
- Natural production adoption is measured through privacy-safe events; no
  recruited human acceptance session is required.

## R5.0 — Lean Release Assurance

### Outcome

Every production release either proves the new immutable revision can serve the
supported runtime contract or preserves/restores the previous known-good
revision.

### Deploy-Time Checks

- Record the current ready revision and immutable image before deployment.
- Deploy and verify the target ACA revision, image, internal ingress, traffic,
  and Dapr app id, port, and protocol.
- Verify the bot's internal `/healthz` and `/readyz`.
- Send a correctly signed `events: []` request through the public Gateway
  canonical helper webhook path. This validates signature handling and
  Gateway-to-Dapr-to-bot routing without a LINE reply, DeepSeek request, or
  embedding request.
- Verify SearXNG internal health without turning it into a public or general
  search service.
- Verify the catalog job definition and most recent successful execution.
- Verify the ClamAV refresh job, active manifest, signature age, and scan-job
  definition.
- Write an allowlisted release report containing resource names, revision/image
  identifiers, bounded statuses, timestamps, and failure codes only.
- On a required-gate failure, keep traffic on or restore the recorded
  known-good revision. Never repair production by bypassing `main`.

### Periodic Checks

- Bounded Graph and Notion read probes.
- Harmless clean-file and EICAR-rejection ClamAV self-tests.
- Queue depth, oldest-message age, and recent scan execution.
- A low-frequency write-delete smoke in a dedicated OneDrive diagnostics
  folder.

### Explicit Limitation

An empty signed webhook does not prove LINE platform delivery or reply-token
behavior. Without a recruited human test, those are observed only through
sanitized success events from naturally occurring production traffic. Release
reports must not claim otherwise.

### Exit Criteria

- Every release produces a secret-free gate report.
- A deliberately failed gate demonstrates retention or restoration of the
  previous image.
- Every dependency excluded from local Kernel live acceptance has a named
  deploy-time or periodic check.
- Deploy-time checks consume zero DeepSeek and zero embedding requests.

## Work Explicitly Removed

The following are no longer roadmap items:

- provisioning the product for unrelated churches;
- commercial managed-pilot packages;
- subscriptions, usage overages, billing, entitlements, or support tiers;
- tenant connector and profile control planes;
- `organizationId`, tenant repository context, and tenant RLS;
- shared-cell routing, tenant quotas, and noisy-tenant isolation;
- tenant export, suspension, deletion, and dedicated-cell automation;
- a local semantic model or office-runtime fallback;
- broad branch/campus identity propagation;
- R5.1 enterprise-style operational-safety expansion;
- R5.2 long-running cost and maintenance optimization program.

## Delivery Decomposition

This roadmap is not one implementation branch. Create one reviewed design and
implementation plan for each independently deployable milestone:

1. R4.0 production contract correction;
2. R4.1 internal product experience;
3. R5.0 lean release assurance.

R4.0 must complete before R4.1 because it corrects a current attachment
availability defect. R5.0 is the final delivery milestone and establishes the
release probes and rollback evidence required before stable maintenance.

R4.1 implementation and local acceptance are complete; its production
verification remains pending Task 9. R5.0 is the only remaining roadmap
milestone, followed by Stable Maintenance.

Each behavior or lifecycle change after R3 must update the versioned Kernel
corpus and run the applicable deterministic, Redis/PostgreSQL integration, and
bounded live-provider gates. Provider-consuming live suites remain manual and
bounded; production deploy smoke remains provider-free.

## Success Definition

The roadmap is complete when church members can discover and use only their
authorized functions, branch groups cannot consume one another's workflow
state, formal church data remains current and intentionally shared, and every
release is verifiably recoverable without building a SaaS platform.

# Kernel v1 Local Live Acceptance Design

## Status

Approved on 2026-07-26. This design replaces the pending user-led LINE
acceptance window with a bounded local simulation that exercises the real LINE
webhook transport and the real DeepSeek and Azure embedding providers without
using a production LINE account or production data stores.

It closes the remaining Kernel v1 live-provider and privacy-safe observation
gate. It does not add a production route, a second router, a runtime switch, a
scheduled test, or a new cloud service.

## Outcome

A single operator command starts disposable local containers, obtains only the
two required provider secrets without printing or persisting them, sends a
small fixed set of signed LINE webhook journeys through the real controlled
runtime, writes an allowlisted report, and removes every container, volume, and
secret file on success, failure, interruption, or timeout.

The successful report is sufficient to update the Kernel v1 acceptance
baseline and permit the roadmap transition to R4 Product Experience.

## Safety Boundaries

- Production PostgreSQL, Redis, LINE, Graph, OneDrive, Notion, queues, and
  ClamAV publication are never called.
- Only DeepSeek function routing and the existing Azure
  `text-embedding-3-small` deployment are live.
- The local LINE channel secret and LINE identities are synthetic.
- LINE replies are captured locally instead of sent to LINE.
- External writes use local fakes and remain subject to the normal preview,
  confirmation, authorization, audit, and outbox contracts.
- No raw messages, model prompts or payloads, names, URLs, provider responses,
  sharing links, credentials, or secret values may enter reports or logs.
- Production code must not import `src/testing/*`. The acceptance executable is
  test/tooling composition and is never selected by production startup.

## Local Topology

One Compose project owns four disposable services:

1. `acceptance-app`
   - Builds the same repository revision as production.
   - Starts an acceptance-only composition executable, not `src/index.ts`.
   - Uses the real Fastify LINE webhook transport, controlled turn runtime,
     candidate generation, planner, validator, capability registry, and state
     transitions.
   - Injects the real DeepSeek and Azure embedding clients.
   - Injects local adapters for replies and every other external dependency.

2. `acceptance-driver`
   - Creates canonical LINE webhook payloads, signatures, event IDs, direct and
     group sources, requester IDs, reply tokens, and postbacks.
   - Sends one turn at a time over the private Compose network.
   - Reads captured replies and bounded trace metadata from Redis.
   - Owns the journey assertions and final report.

3. `postgres`
   - Uses the repository's pgvector-compatible PostgreSQL image.
   - Creates only the disposable `hhc_line_acceptance` database.
   - Runs the real application migrations.
   - Receives deterministic, non-sensitive fixture data.

4. `redis`
   - Uses a unique run-scoped key prefix.
   - Stores sessions, active tasks, selections, idempotency, reply capture, and
     allowlisted observations.

The project name includes an opaque run ID. Host ports bind only to loopback
when a host port is required. The application and driver communicate on an
internal Compose network.

## Composition And Dependency Direction

The acceptance composition lives under `src/testing/` and is invoked from a
tool under `src/tools/`. It may construct:

- local PostgreSQL and Redis stores;
- the production DeepSeek client;
- the production Azure embedding client;
- a capture `LineReplyClient`;
- deterministic identity, Graph, Notion, catalog, attachment, queue, and clock
  fakes.

The production composition root and production profile file remain unchanged.
No `ACCEPTANCE_MODE`, environment-driven router selection, alternate semantic
provider, or production test endpoint is allowed.

The architecture checker must continue to reject imports from `src/testing/`
by production layers.

## Secret Lifecycle

The host runner obtains exactly:

- ACA secret `deepseek-api-key`;
- ACA secret `azure-openai-embedding-key`.

The runner must:

1. require an authenticated Azure CLI session;
2. disable shell tracing before reading any secret;
3. query the two secret values without writing them to stdout;
4. create a random directory under WSL `/dev/shm`;
5. set directory mode `0700` and file mode `0600`;
6. mount the files read-only at `/run/secrets`;
7. let the container entrypoint read the files internally;
8. install a cleanup trap before starting Compose;
9. run `docker compose down --volumes --remove-orphans`;
10. remove the memory-backed directory on every exit path.

Secret values must not appear in:

- command arguments;
- shell history;
- Compose interpolation output;
- Docker image layers;
- Docker `Config.Env`;
- Git or `.env` files;
- reports, test snapshots, errors, or CI output.

The runner never retrieves production LINE, database, Redis, Graph, Notion,
queue, observability, or administrator secrets.

## Provider Budget

The live provider budget is a runtime authority boundary, not documentation.

- DeepSeek: maximum 10 HTTP requests per complete run.
- Azure embedding: maximum 3 batch requests per complete run.
- Provider concurrency: exactly 1.
- Each simulated turn may start at most one DeepSeek request.
- Automatic provider and suite retries: 0.
- A failed case may be manually rerun once only when its case ID is explicitly
  supplied.
- Full-run deadline: 10 minutes.
- No cron, watcher, daemon, background rerun, or recursive invocation.

A shared budget object wraps the two live clients. It increments before each
outbound call, rejects an over-budget request with `budget_exhausted`, and
records only provider name, bounded case ID, ordinal, and outcome class.

Before obtaining secrets, the runner prints the selected case IDs and maximum
request counts. A budget or deadline failure stops the suite immediately.

## Fixed Acceptance Journeys

The default suite contains eight versioned journeys:

1. `schedule-explicit`
   - Maximum live cost: 1 DeepSeek request, 0 embedding batches.
   - One direct-user request for a focused upcoming service role.
   - Proves signed entrance, candidate selection, DeepSeek proposal,
     deterministic validation, schedule execution, and focused projection.

2. `schedule-refinement`
   - Maximum live cost: 2 DeepSeek requests, 0 embedding batches.
   - A schedule result followed by one role refinement.
   - Proves requester-scoped active-task continuation.

3. `schedule-ambiguity`
   - Maximum live cost: 1 DeepSeek request, 0 embedding batches.
   - Uses an ambiguous role and expects a bounded clarification.
   - Proves the model cannot choose an undeclared entity.

4. `capability-switch`
   - Maximum live cost: 2 DeepSeek requests, 0 embedding batches.
   - Starts with one read task and explicitly switches capability.
   - Proves current-message evidence supersedes the active task.

5. `knowledge-follow-up`
   - Maximum live cost: 2 DeepSeek requests, 3 embedding batches.
   - Queries a small seeded knowledge source and asks one elliptical follow-up.
   - Uses one small embedding seed batch plus bounded query embedding.
   - Proves pgvector retrieval, opaque anchoring, and grounded continuation.

6. `group-requester-isolation`
   - Maximum live cost: 1 DeepSeek request, 0 embedding batches.
   - Seeds requester A's task through the real task-store contract, then sends
     a continuation from requester B through the webhook in the same synthetic
     group.
   - Proves no inherited task, selection, memory, or job state.

7. `provider-unavailable`
   - Maximum live cost: 0 DeepSeek requests, 0 embedding batches.
   - Forces a local DeepSeek failure without making an API request.
   - Proves one-provider fail-closed behavior and zero semantic fallback.

8. `write-preview-confirm`
   - Maximum live cost: 1 DeepSeek request, 0 embedding batches.
   - Uses a granted synthetic requester and a local write adapter.
   - Proves preview, confirmation, audit, idempotency, and outbox behavior
     without publishing externally.

No journey may contain loops. A journey has a statically bounded number of
turns and declares its maximum DeepSeek and embedding cost next to the case
definition. The default suite therefore has a static ceiling of 10 DeepSeek
requests and 3 embedding batches. Static suite validation must prove the sum
fits the global budget before secrets are read.

## Webhook And Reply Flow

For each turn, the driver:

1. constructs a canonical LINE event with an opaque event ID;
2. serializes the exact request body;
3. signs it with the synthetic channel secret;
4. sends it to `/api/line/webhook/acceptance`;
5. expects the normal webhook acknowledgement;
6. fetches the captured reply for the synthetic reply token;
7. asserts only allowlisted structure and outcome metadata;
8. advances to the next declared turn or stops.

Separate entrance checks send one invalid signature and one duplicate event.
They do not call DeepSeek or embedding and therefore do not consume live
budget.

## Fixtures

Fixtures are synthetic, minimal, and deterministic:

- one profile and bootstrap administrator;
- two direct users;
- one group with two requesters;
- a small service schedule with only the roles required by the cases;
- one knowledge source, one document, and at most two short chunks;
- one write grant and one local write target.

Fixture text must not contain real church member names, real LINE IDs, private
URLs, production source identifiers, or copied production content.

## Observability And Report

The driver writes ignored artifacts:

- `artifacts/kernel-v1/local-live-report.json`;
- `artifacts/kernel-v1/local-live-report.md`.

The schema contains only:

- schema and case-set versions;
- run start/end timestamps;
- commit under test;
- selected case IDs;
- pass/fail and bounded failure reason;
- DeepSeek request count;
- embedding batch count;
- disposition, capability, validator reason, result class, and lifecycle
  outcome enums;
- cleanup result.

The report generator rejects unknown keys. Secret-leak scanning checks the
report, captured console output, Compose config output, and Git diff for the
retrieved secret byte sequences without printing those sequences.

## Error Handling And Cleanup

- Azure authentication or secret retrieval failure stops before Compose.
- Missing `/dev/shm`, Docker, Compose, or a healthy dependency fails rather
  than skips.
- Migration or fixture failure stops before live provider calls.
- A provider timeout counts as one request and stops the current suite.
- Assertion failure stops the suite; it does not retry or continue spending
  budget.
- Signal handlers cover normal exit, error, timeout, `SIGINT`, and `SIGTERM`.
- Cleanup failure makes the command fail even if every journey passed.
- The cleanup verifier confirms the run-scoped containers, network, volumes,
  Redis namespace, temporary directory, and secret files are absent.

## Commands

The intended operator surface is:

```text
pnpm eval:kernel:local-live
pnpm eval:kernel:local-live -- --case <case-id>
```

The case-specific form is the only rerun path. It still uses the same secret,
budget, cleanup, and report rules.

This command remains manual and local. It is not added to pull-request CI,
release CI, a scheduler, or an automation.

## Verification

Implementation must add deterministic tests for:

- suite static cost validation;
- DeepSeek and embedding budget exhaustion;
- zero automatic retry;
- serial execution;
- deadline enforcement;
- signed, invalid-signature, and duplicate webhook behavior;
- reply capture isolation;
- requester isolation;
- report allowlisting and secret rejection;
- cleanup on success, failure, timeout, and interruption;
- rejection of production secret names and production connection settings;
- production layers remaining unable to import acceptance composition.

The implementation branch must pass:

- `pnpm format:check`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm architecture:check`;
- `pnpm test`;
- `pnpm config:validate`;
- `pnpm eval:agent`;
- `pnpm eval:kernel`;
- `pnpm eval:kernel:integration`;
- `pnpm build`.

After deterministic verification, run the local live suite once. Do not rerun
the complete suite automatically if it fails.

## Acceptance And Roadmap Handoff

Kernel v1 may be marked accepted only when:

- all eight journeys pass;
- the real provider counters remain within 10 DeepSeek requests and 3 embedding
  batches;
- no external write occurs;
- the report and output pass secret-leak checks;
- cleanup verification passes;
- the result identifies the exact commit under test;
- the Kernel acceptance baseline records the limitations of local simulation.

The baseline must state that this proves:

- real DeepSeek routing;
- real Azure embedding;
- real webhook signing and controlled runtime behavior;
- local PostgreSQL/Redis lifecycle and requester isolation.

It does not prove:

- LINE platform delivery or reply-token behavior;
- production network latency;
- production PostgreSQL/Redis failover;
- Graph, Notion, OneDrive, queue, or ClamAV availability.

Those remain operational checks for R5 and must not block the R4 product
experience transition once this bounded Kernel v1 gate succeeds.

## Non-Goals

- No production acceptance API.
- No Tailscale, VNet, VM, ACA acceptance app, or new Azure database.
- No new semantic provider or fallback.
- No copying of production records into local fixtures.
- No live write to LINE, Graph, Notion, OneDrive, queues, or ClamAV.
- No load, soak, fuzz, randomized, or open-ended conversational testing.
- No automatic full-suite rerun.

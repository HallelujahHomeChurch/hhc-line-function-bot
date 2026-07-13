# Task 9 Final Re-review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix body-only controlled knowledge routing, source-max evidence comparison, durable staged permanent expiry, revision-safe failure health, and Latin metadata token boundaries.

**Architecture:** Extend controlled routing with a declarative provider registry that returns only bounded retrieval evidence, and reuse one bounded top-per-source store operation for both routing probes and answer-source resolution. Add an explicit staging migration marker and a revision-conditional failure API, rotating the revision on successful publication so stale syncs cannot damage newer health.

**Tech Stack:** TypeScript, Fastify runtime wiring, Vitest, PostgreSQL/pgvector SQL, pnpm, Prettier, ESLint.

## Global Constraints

- Preserve profile/function/source policy and all previous Task 9 fixes.
- Probe no more than 20 promoted eligible sources in one profile.
- Never send knowledge content, titles, URLs, source names, or opaque source IDs to DeepSeek.
- Reject retrieval probing for explicit small talk and write intent.
- Compare one top result per eligible source before the answer-context limit.
- Treat `knowledge_source_staging_changed` as stale with no health mutation.
- Do not push or deploy.

---

### Task 1: Declarative retrieval-evidence candidate

**Files:**

- Modify: `src/functions/definitions.ts`
- Modify: `src/agent/capability-candidates.ts`
- Modify: `src/agent/controlled-agent-router.ts`
- Modify: `src/agent/planner.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/capability-candidates.test.ts`
- Test: `src/__tests__/controlled-agent-router.test.ts`
- Test: `src/__tests__/agent-turn-runtime.test.ts`

**Interfaces:**

- Consumes: promoted knowledge sources and the bounded store operation introduced in Task 2.
- Produces: `retrievalEvidence?: { provider: string }` on `AgentCapabilityContract`, generic `retrieval_evidence` candidates, and a provider registry whose result is capability-only evidence.

- [x] **Step 1: Write the failing tests**

Add candidate/router/runtime tests that require a `retrieval_evidence` candidate for a profile-scoped body-only match, verify the planner input contains no knowledge content or metadata, and verify no probe/candidate for explicit small talk or a disabled `query_knowledge` function.

- [x] **Step 2: Run focused tests to verify RED**

Run the three focused test files and confirm failures are caused by the missing provider contract/reason and missing end-to-end body-only candidate.

- [x] **Step 3: Implement the declarative provider path**

Add the contract field and reason enum/schema, clone the contract safely, discover provider keys only from eligible enabled read definitions, invoke registered providers fail-closed, and feed matched capability names into `buildCapabilityCandidates`. The top-level router must not branch on `query_knowledge`.

- [x] **Step 4: Wire the bounded knowledge provider**

In `src/index.ts`, register the `knowledge` provider. It rejects write intent and explicit small talk, lists at most 20 eligible sources in the requested profile, performs only the bounded lexical probe, and returns no content-bearing fields.

- [x] **Step 5: Run focused tests to verify GREEN**

Run the candidate, controlled-router, and runtime tests and confirm the new positives and negatives pass.

### Task 2: Top evidence per eligible source

**Files:**

- Modify: `src/knowledge/store.ts`
- Modify: `src/knowledge/postgres-store.ts`
- Modify: `src/functions/query-knowledge.ts`
- Test: `src/__tests__/knowledge-store.test.ts`
- Test: `src/__tests__/knowledge-postgres-store.test.ts`
- Test: `src/__tests__/query-knowledge.test.ts`

**Interfaces:**

- Consumes: profile, query, optional query embedding metadata, and 1-20 opaque source IDs.
- Produces: `KnowledgeStore.searchTopPerSource(...)` returning at most one ranked result per source.

- [x] **Step 1: Write the failing tests**

Create memory, PostgreSQL SQL-shape/result, and query-handler cases where eight source-A chunks precede an equal source-B top result. Require a tie clarification; also require a unique source maximum to constrain the later context search.

- [x] **Step 2: Run focused tests to verify RED**

Run the three focused files and confirm the current global eight-result truncation hides source B.

- [x] **Step 3: Implement one bounded per-source operation**

Validate a maximum of 20 source IDs. In memory, scan once and retain the best result per source. In PostgreSQL, rank one SQL candidate set using `row_number() over (partition by source_id order by score desc, ordinal asc)` and return rank one rows without N+1 queries.

- [x] **Step 4: Resolve the source before context retrieval**

For search-all, call `searchTopPerSource`, compare exact top scores, clarify exact ties, and then run the existing limit-eight search constrained to the unique winning source. Preserve explicit source and continuation behavior.

- [x] **Step 5: Run focused tests to verify GREEN**

Run all Task 2 focused tests and confirm tie and unique-source behavior.

### Task 3: One-time staging initialization

**Files:**

- Modify: `src/knowledge/migrations.ts`
- Modify: `src/knowledge/postgres-store.ts`
- Test: `src/__tests__/knowledge-migrations.test.ts`
- Test: `src/__tests__/knowledge-postgres-store.test.ts`

**Interfaces:**

- Consumes: existing `knowledge_sources` rows from before the staging schema.
- Produces: `staging_initialized boolean not null default true` with an exact one-time live-to-staged backfill.

- [x] **Step 1: Write the failing migration-rerun test**

Model a legacy row, run migration initialization, stage `staged_expires_at = NULL`, rerun migrations, and assert the staged permanent expiry remains `NULL`.

- [x] **Step 2: Run the migration test to verify RED**

Confirm the current repeated `coalesce` backfill restores the live expiry.

- [x] **Step 3: Implement the initialization marker**

Add the marker to fresh schema creation, add it false for upgraded schemas, backfill every staged field only where false (assigning expiry exactly, including `NULL`), flip true, and set the default true. Ensure upserted rows are initialized.

- [x] **Step 4: Run migration and PostgreSQL tests to verify GREEN**

Confirm initial upgrades and restart reruns both preserve the intended staged state.

### Task 4: Revision-safe synchronization failure health

**Files:**

- Modify: `src/knowledge/store.ts`
- Modify: `src/knowledge/postgres-store.ts`
- Modify: `src/knowledge/sync-service.ts`
- Create: `src/knowledge/scheduled-sync.ts`
- Modify: `src/actions/admin-registry.ts`
- Modify: `src/tools/sync-catalog.ts`
- Test: `src/__tests__/knowledge-store.test.ts`
- Test: `src/__tests__/knowledge-postgres-store.test.ts`
- Test: `src/__tests__/knowledge-admin-actions.test.ts`
- Create: `src/__tests__/knowledge-scheduled-sync.test.ts`

**Interfaces:**

- Consumes: source identity, expected staging revision, and sanitized error code.
- Produces: `markSourceSyncFailed(...) => "updated" | "stale" | "not_found"`; successful publication rotates revision; scheduled sync is directly testable.

- [x] **Step 1: Write the failing concurrency tests**

In memory and PostgreSQL tests, start from revision A, publish a newer ready snapshot that rotates to B, submit failure for A, and require `stale` with ready health unchanged. Add admin add/sync and scheduled-helper cases that simulate `knowledge_source_staging_changed` after a newer success.

- [x] **Step 2: Run focused tests to verify RED**

Confirm stale failure currently marks the source failed and successful publication does not rotate the revision.

- [x] **Step 3: Implement the conditional failure API and revision rotation**

Compare revision atomically in memory/SQL. Rotate revision in successful publication. Add a shared stale-error classifier/failure marker and update admin add/sync to retain the source revision captured for that invocation.

- [x] **Step 4: Extract and wire scheduled synchronization**

Move the scheduled knowledge loop to `src/knowledge/scheduled-sync.ts`, call it from `src/tools/sync-catalog.ts`, and ensure stale results increase neither failed health nor overwrite the newer ready state.

- [x] **Step 5: Run focused tests to verify GREEN**

Run store, PostgreSQL, admin, and scheduled-sync tests and confirm current failures still mark failed while stale failures do not mutate health.

### Task 5: Exact Latin metadata tokens

**Files:**

- Modify: `src/knowledge/routing-metadata.ts`
- Test: `src/__tests__/knowledge-routing-metadata.test.ts`

**Interfaces:**

- Consumes: normalized Latin text tokens and a metadata term.
- Produces: exact equality for one token and exact contiguous equality for multi-token/hyphenated terms.

- [x] **Step 1: Write the failing boundary tests**

Assert `care` does not match `scared`, `art` does not match `party`, and a phrase such as `pastoral-care` still matches `pastoral care` as an exact contiguous token sequence.

- [x] **Step 2: Run the focused test to verify RED**

Confirm the single-token substring branch causes both false positives.

- [x] **Step 3: Implement exact token equality**

Replace the single-token `includes` fallback with strict token equality and retain the existing contiguous multi-token matcher.

- [x] **Step 4: Run the focused test to verify GREEN**

Confirm all new boundary cases and existing metadata matching tests pass.

### Task 6: Documentation, full verification, report, and local commit

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `AGENTS.md` only if the durable workflow contract changes
- Modify: `.superpowers/sdd/task-9-implementer-report.md` (ignored report)
- Modify: this plan checkbox state

**Interfaces:**

- Consumes: all focused-green implementation from Tasks 1-5.
- Produces: aligned documentation, fresh complete verification evidence, exact local commit SHA, and a clean worktree.

- [x] **Step 1: Update user-facing and architecture documentation**

Document the content-free bounded pre-planner probe, per-source evidence-before-context behavior, durable staging initialization, and revision-safe stale failures.

- [x] **Step 2: Run the full verification gate**

Run `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm eval:router`, `pnpm eval:admin`, and `git diff --check`. Record exact counts and failures if any.

- [x] **Step 3: Update the ignored implementation report**

Record focused RED/GREEN evidence, design decisions, full gate results, changed scope, and the final commit hash.

- [x] **Step 4: Stage, inspect, and commit locally**

Run `git diff --cached --check`, inspect staged files/statistics, commit with `fix: close final knowledge review gaps`, mark this plan complete, amend bookkeeping if needed, and do not push.

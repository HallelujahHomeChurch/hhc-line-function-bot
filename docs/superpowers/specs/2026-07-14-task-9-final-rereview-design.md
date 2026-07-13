# Task 9 Final Re-review Design

## Goal

Close the five remaining knowledge-routing and synchronization correctness gaps without exposing knowledge content to the controlled planner, weakening profile/function policy, or regressing the atomic snapshot behavior already implemented.

## Declarative Retrieval Evidence

`AgentCapabilityContract` gains an optional retrieval-evidence provider key. The `query_knowledge` definition declares the knowledge provider key, while the controlled router remains function-agnostic: it discovers eligible enabled read definitions, groups them by declared provider, and asks a bounded provider registry for evidence.

The knowledge provider rejects write intent and explicit small talk before storage access. It loads no more than 20 promoted, enabled, unexpired sources for the current profile and performs a read-only lexical probe. Its result is bounded to a boolean, count, or opaque source IDs. Candidate construction receives only the matched capability name and emits the generic `retrieval_evidence` reason. DeepSeek receives the existing sanitized candidate summary and never receives source names, titles, URLs, chunks, document content, or opaque source IDs.

Disabled or source-ineligible functions cannot request evidence and cannot become candidates through the probe. Provider failures fail closed to no evidence.

## Per-source Evidence Before Answer Limits

`KnowledgeStore` gains a bounded `searchTopPerSource` operation. It accepts at most 20 source IDs and returns at most one highest-scoring result per eligible source. The in-memory store computes maxima in one scan. PostgreSQL uses one ranked query with `row_number() over (partition by source_id order by score desc, ordinal asc)` and selects rank one, avoiding per-source queries.

For a source-unspecified knowledge query, the handler first compares these per-source maxima. An exact top-score tie across sources opens the existing requester-scoped clarification flow. A unique maximum selects that source, after which the handler performs the existing bounded context search with the eight-result maximum constrained to the selected source. Explicit source and continuation paths keep their current scoped search behavior.

The same bounded operation powers the controlled-router retrieval probe without answer generation or content disclosure.

## Durable Staging Initialization

The knowledge source schema gains `staging_initialized`. Existing installations add it with a temporary false default. A one-time migration copies every live field into its staged field, including assigning `staged_expires_at = expires_at` when both are `NULL`, then marks the row initialized. The default becomes true for new rows. Fresh schema creation and source upserts create initialized rows.

Subsequent startup migrations skip initialized rows. Therefore an administrator's staged permanent expiry remains `NULL` across restarts instead of being restored from the live expiry.

## Revision-conditional Failure Health

`KnowledgeStore` gains `markSourceSyncFailed`, taking the profile, source key, expected staging revision, and sanitized error code. It returns `updated`, `stale`, or `not_found`. Both stores compare the expected revision atomically with the health update.

Every successful snapshot publication rotates the staging revision in the same atomic memory swap or PostgreSQL transaction. Thus a failed older invocation cannot mark a newer published snapshot failed. A `knowledge_source_staging_changed` publication error is classified as stale; admin add, admin sync, and scheduled catalog sync record or report the stale outcome without changing source health.

Scheduled knowledge synchronization moves behind an importable helper used by `src/tools/sync-catalog.ts`, so its stale-failure behavior is directly testable without importing the CLI entrypoint.

## Latin Metadata Matching

A single Latin metadata term matches only a complete normalized Latin token. `care` does not match `scared`, and `art` does not match `party`. Multiword and hyphenated terms continue to match only an exact contiguous token sequence.

## Error and Security Behavior

- Retrieval-probe failures return no evidence and do not change routing state.
- The probe is profile-scoped, read-only, and capped at 20 eligible sources.
- Planner inputs remain content-free and bounded.
- Stale synchronization failures do not mutate health.
- Genuine current-revision failures retain sanitized failed health and audit behavior.
- Existing last-known-good snapshots remain available after failed refreshes.

## Test Strategy

Focused tests will first demonstrate each current failure:

- Runtime body-only knowledge routing with no metadata/hint match, plus small-talk and disabled-function negatives and planner non-leakage.
- In-memory and PostgreSQL per-source maxima where eight higher-ranked chunks from source A previously hid source B's tied maximum.
- Migration rerun after staging a permanent `NULL` expiry.
- In-memory and PostgreSQL stale failure after newer publication, plus admin add/sync and scheduled helper paths.
- Single Latin token boundary cases and retained multiword/hyphen behavior.

After focused green tests, run Prettier, typecheck, lint, all tests, build, offline router eval, admin eval, and diff checks before committing locally. No push is part of this task.

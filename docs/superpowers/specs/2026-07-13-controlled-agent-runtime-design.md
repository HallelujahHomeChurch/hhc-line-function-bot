# Controlled Agent Runtime Refactor

Date: 2026-07-13
Status: Review requested

## Summary

Refactor the LINE bot from a model-selected function router with function-specific recovery patches into a controlled agent runtime. The target runtime uses DeepSeek as the primary semantic planner, Ollama as the model fallback, and deterministic code as the final authority for access, capability selection, argument grounding, clarification, tool execution, and state transitions.

The immediate production schedule issue is the first migration slice, not a standalone keyword patch. Notion schedule rows must be normalized into canonical meetings and assignments before they are searched, rendered, or stored as continuation context. The same runtime contracts must then support arbitrary administrator-registered church knowledge without adding travel-, SOP-, or source-specific routing code.

## Goals

- Make short and referential follow-ups work consistently for every eligible read function.
- Preserve the bot's restricted capability and access model.
- Let administrators add arbitrary Notion knowledge sources without code changes per topic.
- Keep model output constrained, grounded, and non-authoritative.
- Normalize source-specific data before it reaches search, continuation, or presentation.
- Make production failures diagnosable at each agent boundary without storing raw group chat or secrets.
- Prevent a new function or source from requiring another top-level router patch.

## Non-goals

- Do not create an open-ended autonomous assistant.
- Do not allow the model to invent function names, call arbitrary tools, or bypass confirmation.
- Do not feed whole group conversations or full knowledge documents into the planner.
- Do not replace hybrid knowledge retrieval with model memory.
- Do not require one function per knowledge topic.
- Do not add general web browsing.
- Do not redesign LINE access registration, admin authorization, file intake, or job delivery.

## Current Failure Pattern

The runtime currently asks the routing model to select a function and arguments, then applies deterministic recovery after the route. The recovery layer knows about schedules explicitly. Continuation policy can carry named arguments but cannot describe result entities, reference resolution, ambiguity, or valid follow-up operations. Function results are primarily reply text with a small untyped continuation record.

This creates three recurring failure modes:

1. A short follow-up is routed as small talk because the model must infer the active task again.
2. The recovery layer cannot rescue functions it does not explicitly recognize.
3. A result may render correctly for a human while exposing too little structured data for the next agent turn.

The production schedule source demonstrated the third failure. A Notion record contains an empty role property and a multiline roster in the person property. Rendering parses that multiline text, while schedule search and continuation use the empty role field. Tests used one normalized row per role and therefore did not exercise the production shape.

The knowledge subsystem already provides useful ingestion, lexical/vector retrieval, evidence-bounded generation, and document anchoring. Its remaining weakness is before retrieval: dynamic source metadata is not used for capability candidates, and short knowledge follow-ups have no generic deterministic recovery when the model selects small talk or deny.

## Architectural Principles

### The model proposes; the runtime decides

DeepSeek interprets natural language and proposes a constrained plan. It does not directly execute a function. A deterministic validator checks enabled functions, effective access, allowed source type, current-message evidence, active-task references, required slots, side-effect policy, and ambiguity.

### Normalize at the source boundary

Adapters may understand Notion, LINE text, OneDrive, or future sources. The agent runtime and function query layer only consume canonical domain records. Formatting code must not be the first place raw data becomes structured.

### Continuation is an active task, not copied arguments

The runtime stores a typed, requester-scoped active task derived from an actual function result. It describes anchors, entities, supported refinements, references, and expiry. The next turn may continue, refine, advance, select, switch, clarify, cancel, or chat.

### Result data and reply text are separate

Functions return a structured result envelope. A response composer produces LINE text from that envelope. The active task is updated from canonical result data, never by parsing reply text or trusting model-invented fields.

### Ambiguity produces clarification

When more than one function, source, entity, date, role, or document is plausible, the runtime asks a focused question. It must not silently choose or fall through to small talk.

## Target Turn Flow

1. LINE entrance validates signature, profile, source policy, access, requester identity, wake behavior, and message type.
2. The runtime resolves pending confirmations, selections, attachments, and slot-clarification sessions.
3. It reads the requester-scoped active task and a bounded summary of enabled dynamic knowledge sources.
4. The capability candidate generator produces a small set of allowed candidates from explicit domain evidence, active task, function metadata, source metadata, and side-effect evidence.
5. The semantic planner uses DeepSeek to propose one of: `execute`, `continue`, `refine`, `advance`, `select`, `switch`, `clarify`, `chat`, or `deny`.
6. If DeepSeek is unavailable or invalid, Ollama receives the same constrained schema and candidate set. If both fail, deterministic resolution executes only high-confidence explicit intents; otherwise it clarifies or denies.
7. The plan validator removes unsupported arguments and rejects any field not grounded in the current message or active task.
8. The selected capability prepares a typed domain query and executes its tool.
9. Source adapters return canonical domain data.
10. The function returns a structured result envelope with evidence, anchors, entities, references, supported operations, and a controlled status.
11. The response composer generates the LINE reply.
12. The runtime records a new active task only from a successful structured result.

## Provider Policy

- Semantic planning uses the `function_routing` lane with DeepSeek primary and Ollama fallback.
- Deterministic capability candidate generation runs before either model.
- The model receives only enabled candidate actions, safe active-task context, dynamic source metadata, and the current message.
- The existing profile allowlist and subscription-provider restrictions still apply.
- A provider failure must not broaden capability access.
- Low-confidence or invalid planner output falls back to clarification, not an unrestricted retry loop.
- Evidence-grounded answer generation may continue to use the existing `general_agent` provider policy.

The production profile therefore changes `function_routing` from Ollama-only to `deepseek -> ollama`. This is a model-policy change, not a transfer of authorization to DeepSeek.

## Core Contracts

### Capability definition

Extend function metadata with a declarative agent contract:

```ts
interface AgentCapabilityContract {
  intents: string[];
  candidateHints: string[];
  inputSchema: ZodType;
  resultSchema: ZodType;
  continuation?: {
    anchorFields: string[];
    entityTypes: string[];
    refinableFields: string[];
    operations: Array<"continue" | "refine" | "advance" | "select">;
    ambiguity: "clarify";
  };
}
```

Function-specific code may normalize domain language after the capability is selected, but top-level runtime code must not import schedule, sheet-music, or knowledge parsers.

### Planner proposal

```ts
interface AgentPlanProposal {
  disposition:
    | "execute"
    | "continue"
    | "refine"
    | "advance"
    | "select"
    | "switch"
    | "clarify"
    | "chat"
    | "deny";
  capability?: FunctionName;
  arguments?: JsonRecord;
  references?: Array<{ type: string; value: string | number }>;
  confidence: number;
}
```

The proposal schema must reject unknown fields and unknown actions.

### Validated plan

```ts
interface ValidatedAgentPlan {
  disposition: "execute" | "clarify" | "chat" | "deny";
  capability?: FunctionName;
  arguments?: JsonRecord;
  continuation?: FunctionContinuationState;
  reasonCode: string;
}
```

Only a validated plan reaches the function registry.

### Structured result envelope

```ts
interface AgentResultEnvelope<TData = unknown> {
  status: "success" | "not_found" | "ambiguous" | "unavailable";
  data?: TData;
  anchors?: JsonRecord;
  entities?: Array<{
    type: string;
    key: string;
    label: string;
    value?: unknown;
    aliases?: string[];
  }>;
  evidence?: Array<{ kind: string; reference: JsonRecord }>;
  supportedOperations?: string[];
  clarification?: { prompt: string; choices?: string[] };
  replyText: string;
  quickReplies?: QuickReplyItem[];
}
```

Temporary sharing links may appear in the reply but must not enter anchors, entities, evidence, or active-task state.

## Active Task Context

Replace the shallow continuation meaning with a versioned active-task record while preserving the existing profile/source/requester Redis scope:

```ts
interface ActiveTaskContext {
  version: 1;
  capability: FunctionName;
  anchors: JsonRecord;
  entities: Array<{
    type: string;
    key: string;
    label: string;
    aliases?: string[];
  }>;
  references?: JsonRecord;
  supportedOperations: string[];
  createdAt: string;
  expiresAt: string;
}
```

Rules:

- It remains scoped by profile, LINE source, and requester user id.
- It has an absolute expiry and is not refreshed by unrelated small talk.
- A successful switch to another function replaces it.
- A failed or `not_found` refinement preserves the last successful task unless the capability explicitly opts out.
- A disabled function, removed source, expired source, or access loss invalidates it.
- It stores identifiers and bounded labels, never raw files, whole documents, sharing links, secrets, or group chat history.

## Capability Candidate Generation

Candidate generation is deterministic and precedes the planner. Inputs include:

- enabled functions and effective user/group grants;
- explicit function/domain terms from capability metadata;
- active task capability and entity aliases;
- read/write evidence;
- dynamic knowledge source metadata;
- pending selection or clarification sessions.

Candidate generation should return at most three user functions plus `chat`, `clarify`, and `deny`. Explicit domain evidence outranks continuation. For example, an active knowledge task followed by `下一場服事表的音控` must switch to `query_schedule`; a bare `第二天呢` remains a `query_knowledge` continuation candidate.

## Schedule Canonical Model

All schedule adapters return:

```ts
interface ScheduleMeeting {
  sourceKey: string;
  externalId?: string;
  serviceDate: string;
  meeting: string;
  scheduleType?: string;
  assignments: Array<{
    role: string;
    assignees: string[];
    notes?: string;
    aliases?: string[];
  }>;
}
```

The Notion adapter must support both:

- one row per role with separate role and person properties;
- one row per meeting with a multiline `role: people` roster in the person property.

Malformed roster lines remain visible as a generic assignment and produce sanitized adapter diagnostics. Valid lines are split once at ingestion. Search, continuation, and rendering consume the same assignments.

Role resolution uses current result entities, not a global hard-coded list. Exact normalized matches win. A unique partial or alias match may resolve automatically. Multiple matches produce a clarification with the matching roles.

Schedule storage identity must avoid collisions when one Notion page produces multiple assignments. Tombstoning remains page-aware so a removed page removes every derived assignment.

## Dynamic Knowledge Model

`query_knowledge` remains one generic function for administrator-registered internal knowledge. Adding a trip, SOP, retreat, policy, or ministry page does not add a new function.

Each knowledge source stores bounded routing metadata in addition to current source fields:

- display name;
- normalized aliases;
- topics derived from title, headings, and optional administrator input;
- lifecycle and sync health;
- optional expiry;
- safe sample queries used for evaluation.

Only bounded metadata is supplied to candidate generation and the semantic planner. Full content remains in PostgreSQL and is accessed only through hybrid retrieval.

Knowledge execution remains:

1. exact title/date/ordinal evidence;
2. lexical and pgvector retrieval;
3. optional reranking within retrieved evidence;
4. source-bounded grounded answer generation;
5. controlled excerpt fallback if generation fails.

The result envelope exposes the selected source/document, heading or ordinal entities, and safe evidence references. Follow-ups first search the anchored document or section, then fall back profile-wide only when the current text supports a topic switch or the anchor has no evidence.

## Error And Ambiguity Handling

- `not_found`: explain that enabled sources do not contain enough evidence; do not convert to small talk.
- `ambiguous`: ask one focused question and provide bounded quick replies when possible.
- provider unavailable: use Ollama fallback; then deterministic explicit routing or clarification.
- adapter malformed data: retain readable information, omit unsafe inferred structure, and emit a sanitized reason code.
- source unavailable during sync: preserve the last known good version and report stale/unavailable status to admins.
- active task invalid: discard it and re-evaluate the current message without inherited anchors.
- write action without explicit evidence: deny or clarify before tool execution.

## Observability

Add sanitized trace phases for:

- active-task read outcome;
- candidate capability names and count;
- planner provider, disposition, and confidence bucket;
- validator outcome and reason code;
- capability execution status;
- result-envelope status, anchor count, and entity types;
- active-task write, preserve, replace, expire, or clear.

Do not log raw user text, raw filenames, people values, source URLs, invite codes, model prompts, evidence content, tokens, or sharing links. Admin diagnostics should answer where the turn stopped without revealing conversation data.

## Testing Strategy

### Adapter contract tests

- Production-shaped multiline Notion roster with an empty role property.
- One-row-per-role Notion records.
- Mixed punctuation, whitespace, multiple assignees, malformed lines, and duplicate roles.
- Notion pagination and derived-assignment tombstoning.
- Notion knowledge pages, databases, nested blocks, tables, and pagination.

### Capability contract suite

Every read capability with continuation support must pass a shared suite:

- complete first query;
- short follow-up;
- explicit follow-up;
- refinement;
- advance/select when declared;
- ambiguous reference;
- no result;
- unrelated small talk;
- explicit function switch;
- disabled capability;
- different requester in the same group;
- expired context.

### Planner evaluation

- Deterministic offline fixtures validate candidate generation and plan validation.
- DeepSeek live eval validates semantic proposals against the same expected dispositions.
- Ollama live eval validates fallback behavior.
- Model disagreement never changes deterministic policy expectations.

### End-to-end tests

- LINE text turn through context, candidates, planner, validator, registry, adapter, envelope, reply, and next turn.
- Redis-backed active-task behavior.
- Production-shaped schedule fixtures.
- Dynamic knowledge source whose title contains none of the fixed words `SOP`, `計畫`, or `知識`.
- API Gateway/Dapr webhook smoke remains part of deployment verification.

## Required Acceptance Scenarios

1. `幫我查下一場聚會服事的導播` returns only the matching assignment when the source stores a multiline roster.
2. After a full roster, bare `前攝影` returns the people for that role rather than small talk.
3. `攝影是誰` resolves automatically only when one current role matches; otherwise it asks which photography role.
4. `下一場服事表的前攝影是誰` resolves from now and does not advance from the prior result unless the utterance is an elliptical advance command.
5. An administrator adds a source named `2026 青年出隊`; `第一天去哪裡` routes to knowledge without requiring the word `計畫`.
6. After that answer, `那幾點集合` stays in the same document and section when supported by evidence.
7. `那主日音控呢` explicitly switches from knowledge to schedule.
8. `最近好累` remains controlled small talk even while an active task exists.
9. Another group member cannot inherit the requester's active task.
10. A removed or expired knowledge source cannot be used through stale context.
11. The model cannot inject a date, source, document, role, or write operation absent from current-text or validated context evidence.

## Migration Plan Boundaries

Implementation should be delivered in reviewable slices while keeping production usable:

1. Add production-shaped golden fixtures and sanitized boundary traces.
2. Introduce structured result envelopes and active-task types behind compatibility adapters.
3. Normalize schedule adapters and migrate `query_schedule` to the canonical meeting model.
4. Add deterministic capability candidates, the DeepSeek-primary planner, and the plan validator.
5. Replace schedule-specific continuation recovery with the shared active-task resolver.
6. Add dynamic knowledge routing metadata and migrate `query_knowledge` continuation.
7. Migrate remaining eligible read functions and remove obsolete top-level function-specific guards.
8. Run full local verification, live DeepSeek/Ollama evals, production-shaped end-to-end tests, deployment, catalog/knowledge resync, and LINE acceptance tests.

Compatibility adapters may temporarily translate legacy `FunctionExecutionResult.continuation` into active-task records. New code must not add additional function-specific checks to `turn-runtime.ts`, `function-intent-guard.ts`, or `function-continuation.ts`.

## Rollout And Safety

- Gate the new planner flow behind a profile-level feature flag during migration.
- Support shadow evaluation that records sanitized proposal/validator outcomes without changing replies.
- Enable the new flow for direct admin testing before managed groups.
- Keep the legacy route available for immediate rollback until schedule and knowledge acceptance cases pass.
- Changing `main` remains a production deployment action and must pass the repository's complete verification suite.
- After deployment, verify the new ACA revision, API Gateway/Dapr webhook path, schedule catalog sync, knowledge sync health, and signed LINE acceptance scenarios.

## Success Criteria

- No top-level runtime branch names a specific read function for continuation recovery.
- Every eligible function uses the same candidate, planner, validator, envelope, and active-task lifecycle.
- Source-specific parsing exists only in adapters.
- New Notion knowledge topics require source registration and metadata, not code changes.
- Production-shaped tests cover every active adapter.
- Short follow-up success is measured across schedule and knowledge, not only in isolated handlers.
- Ambiguous or unsupported requests clarify or deny instead of hallucinating or becoming unrelated small talk.

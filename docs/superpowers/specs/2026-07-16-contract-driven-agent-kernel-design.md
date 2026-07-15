# Contract-Driven Agent Kernel Design

## Status

Approved on 2026-07-16. The production LINE bot remains a restricted church helper. This design makes it more capable inside declared functions without turning model output into authority.

## Goals

1. Route and continue conversations through reusable capability contracts instead of function-specific keyword patches.
2. Let stored schedules, files, memories, and dynamic knowledge help nominate the correct function even when the user does not name that function.
3. Preserve the subject of the current task across natural follow-ups while keeping group context requester-scoped and content-safe.
4. Ask a concrete, resumable clarification when more than one capability is plausible.
5. Answer only the field the user requested by default. Full records remain available when explicitly requested.
6. Make every function participate in one structured result and transition lifecycle.
7. Remove dead or competing legacy paths rather than retaining hidden fallback behavior.
8. Keep autonomous code improvement outside the production bot and make the maintenance worker replaceable across Codex, Claude Code, Hermes Agent, or a future backend.

## Non-Goals

- The LINE runtime will not edit, deploy, or retrain itself.
- The planner will not receive raw whole-group history, stored private content, person names, temporary links, secrets, or provider payloads.
- There will be no unrestricted ReAct loop and no model-owned permission or confirmation decision.
- No travel-, SOP-, morning-prayer-, or media-specific router branch will be added. New Notion topics continue to use `query_knowledge`; new schedule types continue to use `query_schedule`.
- The work will not introduce a second binary publication path beside `save_resource`.

## Findings in the Current Runtime

The existing controlled router is a good base: it bounds candidate functions, uses DeepSeek as an advisory planner with Ollama fallback, validates plans deterministically, scopes group state by requester, and requires confirmation for writes. The repeated failures come from lifecycle gaps around that base:

- Recent conversation turns are stored but are not used by controlled planning. The planner sees only the current text, candidates, and one same-function active task.
- Most read functions declare no supported continuation operation, so a successful result immediately clears the active task.
- The active-task expiry incorrectly reuses the 60-second group conversation-window setting.
- Only dynamic Notion knowledge provides pre-planner retrieval evidence. Stored resources, structured schedules, and explicit text memories cannot nominate their function from content alone.
- Write success does not hand off to the corresponding read capability.
- Multiple candidates fall into a generic clarification that does not preserve the original request.
- Result rendering is owned by each handler, so a one-field question can receive a full record.
- `retrieve_memory` is exact normalized substring retrieval rather than grounded semantic question answering.
- The top-level turn precedence is distributed across `server.ts`, ordered text-handler iteration, pre-route memory regex logic, generic query clarification, and the controlled router.
- `find_resource` does not reuse the generic requester-scoped selection mechanism.
- Deployment still carries `KEYWORD_FALLBACK_ENABLED`, although runtime code does not read it. Context-budget configuration is also present without a wired controlled-planner consumer.

## Target Architecture

```text
LINE entrance and access gate
        |
        v
Controlled turn state machine
  1. pending cancel / confirm
  2. pending capability or entity selection
  3. required-slot collection
  4. attachment workflow
  5. explicit capability switch
  6. task-frame continuation or handoff
  7. new capability planning
        |
        v
Capability evidence registry
  - declarative intent and argument evidence
  - catalog probe
  - schedule probe
  - scoped memory probe
  - dynamic knowledge probe
        |
        v
Advisory LLM planner (DeepSeek -> Ollama)
        |
        v
Deterministic plan validator and policy gate
        |
        v
Function execution -> structured result envelope
        |
        +--> response projection
        +--> selection / clarification state
        +--> typed task frame / write-to-read handoff
```

## 1. Capability Contract

Every enabled function must declare enough metadata for the generic kernel to reason about it. The contract gains four concepts:

```ts
interface AgentCapabilityContract {
  intents: string[];
  candidateHints: string[];
  semanticDescription: string;
  retrievalEvidence?: { provider: string };
  entityTypes?: string[];
  refinableFields?: string[];
  operations: AgentOperation[];
  responseProjection?: {
    defaultMode: "focused" | "full";
    fields: Record<string, { label: string; aliases: string[] }>;
  };
  handoffs?: Array<{
    on: "success";
    to: FunctionName;
    map: Record<string, string>;
  }>;
  ambiguity?: "clarify";
}
```

`semanticDescription` and bounded required-slot summaries are safe planner input. They explain product behavior without exposing stored content. `responseProjection` describes safe output fields generically. `handoffs` describes transitions declaratively; the kernel must not contain `if (functionName === ...)` branches.

Definitions remain the source of truth for allowed sources, required slots, side effects, grants, and resource/memory policy. The planner can only choose from candidates generated from effective functions for the current requester and source.

## 2. Evidence Provider Registry

The existing retrieval-evidence interface becomes a general registry. Each provider is read-only, bounded, profile-scoped, and returns only whether a match exists plus opaque references and a confidence band. It never returns raw content to the planner.

Required providers:

- `knowledge`: existing eligible-source metadata and pgvector probe.
- `catalog`: title/alias search across authorized presentation, sheet-music, and general resource kinds; the contract maps a match to the correct capability.
- `schedule`: date, meeting, role, schedule type, and stored schedule-series evidence.
- `memory`: profile/source/requester-visible explicit memory evidence.

Evidence is advisory. Provider failure yields no evidence and never broadens authority. A cross-provider tie produces a pending capability resolution instead of a guess.

## 3. Typed Task Frame

Replace version-1 same-capability active task with a version-2 task frame:

```ts
interface AgentTaskFrame {
  version: 2;
  currentCapability: FunctionName;
  allowedCapabilities: FunctionName[];
  anchors: JsonRecord;
  entities: AgentEntity[];
  references?: JsonRecord;
  supportedOperations: AgentOperation[];
  responseContext?: {
    availableFields: string[];
    defaultProjection: "focused" | "full";
  };
  createdAt: string;
  expiresAt: string;
}
```

The frame contains canonical dates, schedule types, opaque document/item references, safe entity labels, and declared operations. It excludes raw result bodies, links, file names when a hashed/opaque reference is sufficient, and arbitrary conversation history.

Frames are scoped by profile, LINE source, and requester. Their default TTL is 10 minutes and is configured independently from the short group wake-word conversation window. Permission, effective-function, source, expiry, operation, and current-message evidence are revalidated on every continuation.

All successful structured read results may create a frame when the result and contract share an operation. At minimum:

- schedule: continue, refine, advance, select;
- knowledge: continue, refine, select;
- PPT, sheet music, and general resources: continue, refine, select;
- Wikipedia: continue, refine;
- explicit memory retrieval: continue, refine, select.

## 4. Write-to-Read Handoffs

Write functions return structured success envelopes. Their contracts declare the next readable capability:

- `save_schedule` -> `query_schedule`;
- `save_memory` -> `retrieve_memory`;
- `save_resource` -> `find_ppt_slides`, `find_sheet_music`, or `find_resource`, selected from the validated saved purpose/result kind.

The transition is created only after the final write succeeds. Preview and pending confirmation do not create a readable frame. A later bare `保存` belongs to the pending write by state-machine precedence and cannot be reinterpreted as a new generic memory request.

## 5. Resumable Ambiguity

When multiple capabilities remain plausible, the kernel stores a requester-scoped `PendingCapabilityResolution` containing:

- candidate function names and safe display labels;
- the original normalized request;
- already grounded arguments and references;
- expiry and source/requester scope.

LINE replies with concrete Quick Reply choices, for example `影視服事表` and `晨更家族服事`. Selecting a choice resumes the original request through the validator. It does not require the user to retype the question, and another group member cannot consume the selection.

This same mechanism handles ambiguity between a stored song score, a presentation, a general file, a schedule series, or a dynamic knowledge source. Domain-specific wording may live in function metadata, not in the generic router.

## 6. Focused Response Projection

Every successful read result includes structured reply data in addition to a safe agent envelope. The response projector determines what the user requested and renders only those fields by default.

Examples:

- `直播是誰` -> `直播：銹姐、家睿`
- `音控是誰` -> `音控：資恆`
- `7/21 晨更服事家族是誰` -> `晨更家族：黃弘家族 1`
- `第一個地點是哪裡` -> `第一個地點：…`

The reply may include a short disambiguating date or title only when omission would make the answer unsafe or ambiguous. It must not repeat the entire schedule or document. Users can request `完整內容`, and ambiguous/multiple records can expose a `查看完整內容` Quick Reply.

Projection is deterministic when a declared field maps to structured data. Grounded LLM answer synthesis is used only for unstructured knowledge or semantic memory answers and must cite only supplied retrieved context.

## 7. Explicit Memory Retrieval

Explicit text memory remains consent-based and scoped. Its retrieval becomes hybrid:

1. PostgreSQL full-text/lexical matching;
2. existing private `bge-m3` embeddings with 1024 dimensions and pgvector;
3. reciprocal-rank or bounded weighted fusion;
4. grounded answer generation constrained to retrieved memories;
5. structured not-found/unavailable envelopes.

The same embedding service used for dynamic knowledge is reused; no second model is installed. Existing rows are backfilled idempotently. Expired memory is excluded before lexical or vector ranking. Group-visible memory remains available only in its registered source and requester/grant rules remain unchanged.

## 8. One Turn State Machine

`turn-runtime.ts` becomes the single owner of text-turn precedence. `server.ts` retains LINE signature verification, profile/access checks, attachment event entrance, and delivery. Function-specific state handlers expose typed transitions rather than relying on insertion order.

The state-machine reducer produces one of:

```ts
type TurnDecision =
  | { type: "reply"; result: FunctionExecutionResult }
  | { type: "collect"; state: PendingCollection }
  | { type: "resolve"; state: PendingCapabilityResolution }
  | { type: "plan"; taskFrame?: AgentTaskFrame }
  | { type: "deny"; reason: string };
```

Pre-route exact-regex memory lookup and hardcoded generic query clarification are removed once equivalent contract/state behavior is covered. Small talk may use a bounded requester-scoped conversation window, but controlled function planning receives only current text plus the safe task frame and capability summaries.

## 9. Result and Selection Consistency

All function modules return `agentResult` for success, not-found, ambiguous, and unavailable outcomes. All ambiguous lists use the generic requester-scoped resolution store and support numeric/postback selection where LINE permits it. `find_resource` is migrated to this shared path.

The kernel records allowlist-only traces for state phase, candidate names/count, provider/confidence bucket, validator reason, result status/entity types, projection mode, and transition outcome. It never logs raw text, file names, people, URLs, content, source titles, or provider payloads.

## 10. Removal and Refactoring

Remove after replacement tests pass:

- unused `KEYWORD_FALLBACK_ENABLED` deployment configuration;
- pre-route memory regex lookup that competes with controlled planning;
- generic query clarification branches duplicated outside slot/capability resolution;
- same-capability-only version-1 active-task assumptions;
- stale legacy function names in test fixtures;
- unwired context-budget/compression settings, unless they are wired only to small-talk context in the same change.

Split large files by responsibility while preserving public composition points:

- `turn-state-machine.ts`: precedence and decisions;
- `capability-evidence.ts`: provider registry and bounded probes;
- `task-frame.ts`: storage-safe frame creation/validation;
- `response-projector.ts`: focused/full rendering;
- existing function modules: domain retrieval and structured result production;
- `server.ts`: transport/entrance only;
- `turn-runtime.ts`: orchestrates the kernel and function execution.

## 11. Autonomous Improvement Control Plane

The maintenance system is separate from the LINE runtime and agent-backend agnostic.

### What to borrow

- Hermes Agent: bounded memory versus on-demand procedural skills, scheduled fresh sessions, isolated delegates, toolset restriction, and staged memory/skill writes with approval. Its official documentation explicitly separates memory from skills and supports approval-gated self-improvement writes.
- Claude Code: deterministic lifecycle hooks, managed permissions, OS sandboxing, specialized isolated subagents, and worktree isolation. Its documentation distinguishes behavioral instructions from enforced settings/hooks.
- Codex: durable `AGENTS.md`, reusable skills, scheduled work in isolated worktrees, narrow sandbox defaults, verification evidence, and PR-oriented workflows.

### Control-plane components

1. **Feedback intake:** sanitized LINE issue records, optional screenshot references in a dedicated OneDrive issue folder, production trace identifiers, severity, and expected behavior. No secrets or full group transcripts.
2. **Triage:** classify the issue as data/config, function implementation, shared kernel, or infrastructure. Generate a reproducible journey/eval before code changes whenever possible.
3. **Backend adapter:** a stable worker interface can invoke Codex, Claude Code, Hermes Agent, or another coding agent. Backend choice is configuration, not issue schema.
4. **Isolated execution:** fresh branch and worktree, narrow credentials, workspace-write sandbox, explicit network allowlist, bounded turns/time/cost, and no direct production mutation.
5. **Quality gates:** required tests/evals, static analysis, security checks, diff review, and GitHub protected-branch PR. CI is authority; an agent's self-assessment is not.
6. **Learning proposal:** successful fixes may propose an eval, `AGENTS.md` rule, or skill update. Proposals are reviewable diffs. They do not silently rewrite production instructions.
7. **Rollout and observation:** merge only after required checks, release through GitHub Actions, run smoke tests, and monitor for a bounded period. Failed rollout reopens or creates an issue with evidence.

The old `.codex/autonomous-issue-worker-plan.md` is treated only as historical input. Azure Pipeline assumptions are obsolete, and a single fixed cron/agent is replaced by a backend-neutral queue and adapter boundary.

## 12. Testing Strategy

Component tests remain necessary but are insufficient. Add journey-level tests that drive the same turn runtime and state stores used by LINE:

- save schedule -> confirm -> ask a date/role/family field;
- save memory -> confirm -> semantic content-only question;
- save attachment -> confirm -> title-only resource lookup;
- next schedule -> `音控是誰` -> focused answer;
- resource result -> follow-up refinement and selection;
- Wikipedia result -> follow-up;
- multiple capability candidates -> explicit choice -> resume original request;
- task-frame expiry independent from group wake-word window;
- group requester isolation for clarification, selection, attachment, and task frames;
- permission revocation between turns fails closed;
- provider failure and malformed planner output fail closed;
- all write previews require final confirmation and do not create readable state early.

`pnpm eval:agent` gains positive, typo, missing-slot, ambiguous, content-only, disabled, cross-function, handoff, and focused-projection cases for every capability contract. Live DeepSeek/Ollama eval remains manual and is not added to CI.

## 13. Rollout

Implementation is split into independently reviewable phases:

1. Contract/result/task-frame foundations and focused schedule replies.
2. Evidence registry and resumable capability ambiguity.
3. Read-function continuation and write-to-read handoffs.
4. Hybrid explicit-memory retrieval.
5. state-machine consolidation, dead-path removal, and file splitting.
6. journey/eval/docs completion and deployment cleanup.

The branch must pass format, typecheck, lint, unit/journey tests, config validation, deterministic agent eval, and build. After protected-branch PR CI succeeds, merge and let the release workflow build/deploy. Verify the public API Gateway path still reaches the Dapr-enabled internal bot and returns `400 {"ok":false,"error":"missing_line_signature"}` for an unsigned webhook body.

## References

- [Hermes skills and write approval](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Claude Code project memory and instruction hierarchy](https://code.claude.com/docs/en/memory)
- [Claude Code permissions and sandboxing](https://code.claude.com/docs/en/permissions)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code subagents and isolation](https://code.claude.com/docs/en/sub-agents)
- [Codex use cases and verified improvement loops](https://developers.openai.com/codex/use-cases)

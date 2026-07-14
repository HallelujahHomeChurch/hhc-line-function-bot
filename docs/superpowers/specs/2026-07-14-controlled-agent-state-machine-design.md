# Controlled Agent State Machine

## Goal

Make LINE conversations feel intelligent inside enabled church functions while
keeping side effects deterministic, permissioned, requester-scoped, and
auditable. Adding a new function should require metadata, normalization, a
handler, and tests—not a new top-level router branch.

## Authority boundaries

- The model proposes semantics over a deterministic, permission-filtered
  candidate set.
- The validator owns capability, evidence, source, schema, and side-effect
  policy.
- The state machine owns cancel, switch, collect, execute, preview, confirm,
  and active-task lifecycle.
- Registered handlers alone perform function work. A write never commits from
  model confidence or candidate inclusion.

## Turn precedence

1. Apply an exact confirmation or cancellation to the owned pending operation.
2. Release it when the current message explicitly selects another capability
   with domain evidence; a bare confirmation is not a capability switch.
3. Fill the next required slot for the same requester and source.
4. Resolve a live requester-scoped active task.
5. Build and validate a new plan.

Missing required data is `collect`, not a model-owned clarification. Collection
uses function definitions for prompts and required-slot ordering, supports
multiple slots, and rechecks the effective function set before execution.

## Write safety

Explicit unnegated current-message write intent is required to nominate a write
capability. Model-invented payload is discarded or denied. Completing required
slots reaches only the handler's preview path; persistence still requires the
function's permission and confirmation policy.

## Presentation

Focused schedule-role questions return only the role and assignees for one
meeting. When multiple meetings match, each line keeps date and meeting context.
Full schedule requests retain the full schedule format.

## Diagnostics and acceptance

Sanitized traces record candidate names/count, planner disposition, validator
disposition including `collect`, reason codes, result status, and lifecycle
outcome. They never store raw user text or slot content. Acceptance covers model
execute/clarify/chat/low-confidence/no-plan variants, cancellation, function
switches, multi-slot collection, direct/group user grants, requester isolation,
and compact role replies.

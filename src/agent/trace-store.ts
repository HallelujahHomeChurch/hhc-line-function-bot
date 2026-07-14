import { sanitizeActionTelemetryEvent } from "../observability/action-telemetry.js";
import type { AgentPlanDisposition, FunctionName } from "../types.js";

export type AgentTurnTracePhase =
  | "context"
  | "pre_route_memory"
  | "query_clarification"
  | "text_handler"
  | "admin_action_route"
  | "admin_action_result"
  | "active_task"
  | "capability_candidates"
  | "planner"
  | "plan_validation"
  | "result_envelope"
  | "controlled_route"
  | "route"
  | "small_talk"
  | "slot_clarification"
  | "memory_alias"
  | "in_flight"
  | "function"
  | "function_error";

export interface AgentTurnTraceStep {
  phase: AgentTurnTracePhase;
  outcome?: string;
  action?: string;
  provider?: string;
  lane?: string;
  reason?: string;
  query?: "present" | "empty" | "missing";
  ok?: boolean;
  errorName?: string;
  dedup?: string;
  durationMs?: number;
  candidates?: FunctionName[];
  candidateCount?: number;
  disposition?: AgentPlanDisposition | "collect";
  confidenceBucket?: "low" | "medium" | "high";
  validatorReason?: AgentValidatorReason;
  resultStatus?: "success" | "not_found" | "ambiguous" | "unavailable";
  anchorCount?: number;
  entityTypes?: string[];
  lifecycleOutcome?: AgentTaskLifecycleOutcome;
}

export type AgentTaskLifecycleOutcome =
  "read" | "missing" | "invalid" | "write" | "preserve" | "replace" | "expire" | "clear";

export type AgentValidatorReason =
  | "active_task_refinement"
  | "active_task_unavailable"
  | "ambiguous_entity"
  | "candidate_not_allowed"
  | "capability_evidence_unresolved"
  | "capability_not_agent_enabled"
  | "deterministic_explicit_intent"
  | "explicit_capability_switch"
  | "explicit_intent"
  | "explicit_switch_required"
  | "function_disabled"
  | "invalid_arguments"
  | "invalid_policy"
  | "low_confidence"
  | "missing_required_slot"
  | "no_capability_evidence"
  | "operation_not_allowed"
  | "planner_clarification"
  | "planner_denied"
  | "planner_unavailable"
  | "source_not_allowed"
  | "write_evidence_missing";

export type AgentTraceEntityType =
  | "date"
  | "document"
  | "meeting"
  | "memory"
  | "ordinal"
  | "resource"
  | "role"
  | "scheduleType"
  | "section"
  | "source"
  | "topic";

export interface AgentTurnTraceRecord {
  requestId: string;
  occurredAt: string;
  profileName: string;
  sourceType: string;
  steps: AgentTurnTraceStep[];
}

export interface AgentTraceStore {
  record(record: AgentTurnTraceRecord): Promise<void>;
  list(limit?: number): Promise<AgentTurnTraceRecord[]>;
  clear(): Promise<number>;
}

export class InMemoryAgentTraceStore implements AgentTraceStore {
  private readonly traces: AgentTurnTraceRecord[] = [];

  constructor(private readonly maxEntries = 20) {}

  async record(record: AgentTurnTraceRecord): Promise<void> {
    this.traces.unshift(sanitizeAgentTurnTrace(record));
    this.traces.splice(this.maxEntries);
  }

  async list(limit?: number): Promise<AgentTurnTraceRecord[]> {
    return this.traces.slice(0, limit ?? this.maxEntries);
  }

  async clear(): Promise<number> {
    const count = this.traces.length;
    this.traces.splice(0);
    return count;
  }
}

export function formatAgentTurnTraces(traces: AgentTurnTraceRecord[]): string {
  if (traces.length === 0) {
    return "Agent turns\n(none)";
  }
  return [
    "Agent turns",
    ...traces.map((trace) =>
      [
        `- ${trace.occurredAt}`,
        `requestId=${trace.requestId}`,
        `profile=${trace.profileName}`,
        `source=${trace.sourceType}`,
        `steps=${trace.steps.map(formatStep).join(">")}`
      ].join(" ")
    )
  ].join("\n");
}

export function sanitizeAgentTurnTrace(record: AgentTurnTraceRecord): AgentTurnTraceRecord {
  const metadata = sanitizeActionTelemetryEvent({
    requestId: record.requestId,
    profileName: record.profileName,
    sourceType: record.sourceType
  }) as Record<string, unknown>;
  return {
    requestId: (metadata.requestId as string | undefined) ?? "missing",
    occurredAt: safeTimestamp(record.occurredAt),
    profileName: (metadata.profileName as string | undefined) ?? "configured",
    sourceType: (metadata.sourceType as string | undefined) ?? "unknown",
    steps: record.steps.flatMap((step) => {
      const sanitized = sanitizeStep(step);
      return sanitized ? [sanitized] : [];
    })
  };
}

function sanitizeStep(step: AgentTurnTraceStep): AgentTurnTraceStep | undefined {
  const sanitized = sanitizeActionTelemetryEvent(step) as Record<string, unknown>;
  return typeof sanitized.phase === "string"
    ? (sanitized as unknown as AgentTurnTraceStep)
    : undefined;
}

function formatStep(step: AgentTurnTraceStep): string {
  return [
    step.phase,
    step.outcome,
    step.action ? `action:${step.action}` : undefined,
    step.provider ? `provider:${step.provider}` : undefined,
    step.lane ? `lane:${step.lane}` : undefined,
    step.reason ? `reason:${step.reason}` : undefined,
    step.query ? `query:${step.query}` : undefined,
    typeof step.ok === "boolean" ? `ok:${step.ok}` : undefined,
    step.dedup ? `dedup:${step.dedup}` : undefined,
    step.errorName ? `error:${step.errorName}` : undefined,
    step.candidates?.length ? `candidates:${step.candidates.join(",")}` : undefined,
    typeof step.candidateCount === "number" ? `count:${step.candidateCount}` : undefined,
    step.disposition ? `disposition:${step.disposition}` : undefined,
    step.confidenceBucket ? `confidence:${step.confidenceBucket}` : undefined,
    step.validatorReason ? `validator:${step.validatorReason}` : undefined,
    step.resultStatus ? `status:${step.resultStatus}` : undefined,
    typeof step.anchorCount === "number" ? `anchors:${step.anchorCount}` : undefined,
    step.entityTypes?.length ? `entities:${step.entityTypes.join(",")}` : undefined,
    step.lifecycleOutcome ? `lifecycle:${step.lifecycleOutcome}` : undefined
  ]
    .filter(Boolean)
    .join(":");
}

function safeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : "1970-01-01T00:00:00.000Z";
}

import { redactSensitiveText } from "../observability/action-telemetry.js";
import {
  AGENT_PLAN_DISPOSITIONS,
  isFunctionName,
  MODEL_PROVIDER_NAMES,
  type AgentPlanDisposition,
  type FunctionName,
  type ModelProviderName
} from "../types.js";

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
  disposition?: AgentPlanDisposition;
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
  return {
    requestId: redactSensitiveText(record.requestId),
    occurredAt: record.occurredAt,
    profileName: redactSensitiveText(record.profileName),
    sourceType: redactSensitiveText(record.sourceType),
    steps: record.steps.map(sanitizeStep)
  };
}

function sanitizeStep(step: AgentTurnTraceStep): AgentTurnTraceStep {
  if (CONTROLLED_PHASES.has(step.phase)) return sanitizeControlledStep(step);
  const base: AgentTurnTraceStep = compact({
    phase: step.phase,
    outcome: sanitizeString(step.outcome),
    action: step.action && isFunctionName(step.action) ? step.action : sanitizeString(step.action),
    provider: sanitizeProvider(step.provider),
    lane: sanitizeString(step.lane),
    reason: sanitizeString(step.reason),
    query: step.query,
    ok: step.ok,
    errorName: sanitizeString(step.errorName),
    dedup: sanitizeString(step.dedup),
    durationMs:
      typeof step.durationMs === "number" && Number.isFinite(step.durationMs)
        ? Math.max(0, step.durationMs)
        : undefined
  });
  return base;
}

function sanitizeControlledStep(step: AgentTurnTraceStep): AgentTurnTraceStep {
  return compact({
    phase: step.phase,
    outcome: CONTROLLED_OUTCOMES.has(step.outcome ?? "") ? step.outcome : undefined,
    action: step.action && isFunctionName(step.action) ? step.action : undefined,
    provider: sanitizeProvider(step.provider),
    candidates: sanitizeCandidates(step.candidates),
    candidateCount: boundedCount(step.candidateCount, 5),
    disposition: AGENT_PLAN_DISPOSITIONS.includes(step.disposition as AgentPlanDisposition)
      ? step.disposition
      : undefined,
    confidenceBucket: CONFIDENCE_BUCKETS.has(step.confidenceBucket ?? "")
      ? step.confidenceBucket
      : undefined,
    validatorReason:
      step.validatorReason && VALIDATOR_REASONS.has(step.validatorReason)
        ? step.validatorReason
        : undefined,
    resultStatus: RESULT_STATUSES.has(step.resultStatus ?? "") ? step.resultStatus : undefined,
    anchorCount: boundedCount(step.anchorCount, 32),
    entityTypes: sanitizeEntityTypes(step.entityTypes),
    lifecycleOutcome:
      step.lifecycleOutcome && TASK_LIFECYCLE_OUTCOMES.has(step.lifecycleOutcome)
        ? step.lifecycleOutcome
        : undefined
  });
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

const CONTROLLED_PHASES = new Set<AgentTurnTracePhase>([
  "active_task",
  "capability_candidates",
  "planner",
  "plan_validation",
  "result_envelope"
]);
const CONFIDENCE_BUCKETS = new Set(["low", "medium", "high"]);
const CONTROLLED_OUTCOMES = new Set([
  "present",
  "missing",
  "invalid",
  "transition",
  "proposed",
  "no_plan",
  "accepted",
  "rejected"
]);
const RESULT_STATUSES = new Set(["success", "not_found", "ambiguous", "unavailable"]);
const TASK_LIFECYCLE_OUTCOMES = new Set<AgentTaskLifecycleOutcome>([
  "read",
  "missing",
  "invalid",
  "write",
  "preserve",
  "replace",
  "expire",
  "clear"
]);
const VALIDATOR_REASONS = new Set<AgentValidatorReason>([
  "active_task_refinement",
  "active_task_unavailable",
  "ambiguous_entity",
  "candidate_not_allowed",
  "capability_evidence_unresolved",
  "capability_not_agent_enabled",
  "deterministic_explicit_intent",
  "explicit_capability_switch",
  "explicit_intent",
  "explicit_switch_required",
  "function_disabled",
  "invalid_arguments",
  "invalid_policy",
  "low_confidence",
  "missing_required_slot",
  "no_capability_evidence",
  "operation_not_allowed",
  "planner_clarification",
  "planner_denied",
  "planner_unavailable",
  "source_not_allowed",
  "write_evidence_missing"
]);
const ENTITY_TYPES = new Set<AgentTraceEntityType>([
  "date",
  "document",
  "meeting",
  "memory",
  "ordinal",
  "resource",
  "role",
  "scheduleType",
  "section",
  "source",
  "topic"
]);

function sanitizeCandidates(values: readonly string[] | undefined): FunctionName[] | undefined {
  if (!values) return undefined;
  const candidates = [...new Set(values.filter(isFunctionName))].slice(0, 5);
  return candidates.length > 0 ? candidates : [];
}

function sanitizeEntityTypes(
  values: readonly string[] | undefined
): AgentTraceEntityType[] | undefined {
  if (!values) return undefined;
  return [
    ...new Set(
      values.filter((value): value is AgentTraceEntityType =>
        ENTITY_TYPES.has(value as AgentTraceEntityType)
      )
    )
  ].slice(0, 16);
}

function sanitizeProvider(
  value: string | undefined
): ModelProviderName | "keyword" | "router" | undefined {
  if (value === "keyword" || value === "router") return value;
  return MODEL_PROVIDER_NAMES.includes(value as ModelProviderName)
    ? (value as ModelProviderName)
    : undefined;
}

function boundedCount(value: number | undefined, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return Math.min(maximum, Math.max(0, value));
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sanitizeString(value: string | undefined): string | undefined {
  return value ? redactSensitiveText(value) : undefined;
}

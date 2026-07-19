import { sanitizeActionTelemetryEvent } from "../observability/action-telemetry.js";
import type { AgentPlanDisposition, FunctionName } from "../types.js";
import type { RetrievalDiagnostics } from "../observability/retrieval-diagnostics.js";

export type AgentTurnTracePhase =
  | "context"
  | "query_clarification"
  | "text_handler"
  | "admin_action_route"
  | "admin_action_result"
  | "active_task"
  | "capability_resolution"
  | "capability_candidates"
  | "planner"
  | "plan_validation"
  | "argument_grounding"
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
  groundedFieldCount?: number;
  droppedFieldCount?: number;
  disposition?: AgentPlanDisposition | "collect";
  confidenceBucket?: "low" | "medium" | "high";
  validatorReason?: AgentValidatorReason;
  resultStatus?: "success" | "not_found" | "ambiguous" | "unavailable";
  anchorCount?: number;
  entityTypes?: string[];
  lifecycleOutcome?: AgentTaskLifecycleOutcome;
  executionMode?: RetrievalDiagnostics["executionMode"];
  stateAgeBucket?: RetrievalDiagnostics["stateAgeBucket"];
  freshnessStatus?: RetrievalDiagnostics["freshnessStatus"];
  sourceRevision?: RetrievalDiagnostics["sourceRevision"];
  queryFingerprint?: string;
  referenceFingerprint?: string;
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
  | "retrieval_unavailable"
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
  requestId?: string;
  supportId?: string;
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

export interface RedisAgentTraceClient {
  lPush(key: string, value: string): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string | string[]): Promise<number>;
}

export class RedisAgentTraceStore implements AgentTraceStore {
  private readonly key: string;

  constructor(
    private readonly options: {
      client: RedisAgentTraceClient;
      keyPrefix: string;
      maxEntries?: number;
    }
  ) {
    this.key = `${options.keyPrefix}:agent-turn-traces:v1`;
  }

  async record(record: AgentTurnTraceRecord): Promise<void> {
    await this.options.client.lPush(this.key, JSON.stringify(sanitizeAgentTurnTrace(record)));
    await this.options.client.lTrim(this.key, 0, this.maxEntries - 1);
  }

  async list(limit?: number): Promise<AgentTurnTraceRecord[]> {
    const bounded = Math.max(0, Math.min(limit ?? this.maxEntries, this.maxEntries));
    if (bounded === 0) return [];
    const values = await this.options.client.lRange(this.key, 0, bounded - 1);
    return values.flatMap((value) => {
      try {
        return [sanitizeAgentTurnTrace(JSON.parse(value) as AgentTurnTraceRecord)];
      } catch {
        return [];
      }
    });
  }

  async clear(): Promise<number> {
    return this.options.client.del(this.key);
  }

  private get maxEntries(): number {
    return Math.max(1, Math.min(this.options.maxEntries ?? 20, 100));
  }
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
        `supportId=${trace.supportId ?? "missing"}`,
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
    supportId: record.supportId,
    profileName: record.profileName,
    sourceType: record.sourceType
  }) as Record<string, unknown>;
  return {
    supportId: (metadata.supportId as string | undefined) ?? "missing",
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
    step.lifecycleOutcome ? `lifecycle:${step.lifecycleOutcome}` : undefined,
    step.executionMode ? `mode:${step.executionMode}` : undefined,
    step.stateAgeBucket ? `age:${step.stateAgeBucket}` : undefined,
    step.freshnessStatus ? `freshness:${step.freshnessStatus}` : undefined,
    step.sourceRevision ? `revision:${step.sourceRevision}` : undefined
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

import { redactSensitiveText } from "../observability/action-telemetry.js";

export type AgentTurnTracePhase =
  | "context"
  | "pre_route_memory"
  | "query_clarification"
  | "text_handler"
  | "admin_action_route"
  | "admin_action_result"
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
}

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
  return {
    phase: step.phase,
    outcome: sanitizeString(step.outcome),
    action: sanitizeString(step.action),
    provider: sanitizeString(step.provider),
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
  };
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
    step.errorName ? `error:${step.errorName}` : undefined
  ]
    .filter(Boolean)
    .join(":");
}

function sanitizeString(value: string | undefined): string | undefined {
  return value ? redactSensitiveText(value) : undefined;
}

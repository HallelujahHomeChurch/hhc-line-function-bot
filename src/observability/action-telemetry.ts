import type { RouteObserverEvent } from "../types.js";
import { AGENT_PLAN_DISPOSITIONS, isFunctionName } from "../types.js";
import type { LastErrorRecord } from "./last-error-store.js";
import type { LastRouteRecord } from "./last-route-store.js";

type TelemetryInput = object;

const allowedTelemetryKeys = new Set([
  "kind",
  "requestId",
  "profileName",
  "sourceType",
  "phase",
  "provider",
  "lane",
  "outcome",
  "action",
  "reason",
  "confidence",
  "fallbackProvider",
  "fallbackReason",
  "handler",
  "command",
  "authorized",
  "ok",
  "errorName",
  "durationMs",
  "engagement",
  "smallTalkCategory",
  "dedup",
  "queryHash",
  "candidates",
  "candidateCount",
  "disposition",
  "confidenceBucket",
  "validatorReason",
  "resultStatus",
  "anchorCount",
  "entityTypes",
  "lifecycleOutcome"
]);

export function sanitizeActionTelemetryEvent(event: TelemetryInput): Partial<RouteObserverEvent> {
  const input = event as Record<string, unknown>;
  const controlled =
    typeof input.phase === "string" && CONTROLLED_TELEMETRY_PHASES.has(input.phase);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !allowedTelemetryKeys.has(key) ||
      (controlled && !allowedControlledTelemetryKeys.has(key))
    ) {
      continue;
    }
    const safeValue = sanitizeTelemetryValueForKey(key, value, controlled);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return sanitized as Partial<RouteObserverEvent>;
}

const TRACE_ENTITY_TYPES = new Set([
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
const CONTROLLED_TELEMETRY_PHASES = new Set([
  "active_task",
  "capability_candidates",
  "planner",
  "plan_validation",
  "result_envelope"
]);
const allowedControlledTelemetryKeys = new Set([
  "kind",
  "requestId",
  "profileName",
  "sourceType",
  "phase",
  "provider",
  "outcome",
  "action",
  "candidates",
  "candidateCount",
  "disposition",
  "confidenceBucket",
  "validatorReason",
  "resultStatus",
  "anchorCount",
  "entityTypes",
  "lifecycleOutcome"
]);
const TRACE_CONTROLLED_OUTCOMES = new Set([
  "present",
  "missing",
  "invalid",
  "transition",
  "proposed",
  "no_plan",
  "accepted",
  "rejected"
]);
const TRACE_LIFECYCLE_OUTCOMES = new Set([
  "read",
  "missing",
  "invalid",
  "write",
  "preserve",
  "replace",
  "expire",
  "clear"
]);
const TRACE_VALIDATOR_REASONS = new Set([
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

function sanitizeTelemetryValueForKey(key: string, value: unknown, controlled: boolean): unknown {
  if (controlled && key === "action") {
    return typeof value === "string" && isFunctionName(value) ? value : undefined;
  }
  if (controlled && key === "outcome") {
    return typeof value === "string" && TRACE_CONTROLLED_OUTCOMES.has(value) ? value : undefined;
  }
  if (key === "candidates") {
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => isFunctionName(item)))].slice(0, 5)
      : undefined;
  }
  if (key === "entityTypes") {
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => TRACE_ENTITY_TYPES.has(item)))].slice(
          0,
          16
        )
      : undefined;
  }
  if (key === "candidateCount") return boundedTelemetryCount(value, 5);
  if (key === "anchorCount") return boundedTelemetryCount(value, 32);
  if (key === "disposition") {
    return typeof value === "string" && AGENT_PLAN_DISPOSITIONS.includes(value as never)
      ? value
      : undefined;
  }
  if (key === "confidenceBucket") {
    return value === "low" || value === "medium" || value === "high" ? value : undefined;
  }
  if (key === "validatorReason") {
    return typeof value === "string" && TRACE_VALIDATOR_REASONS.has(value) ? value : undefined;
  }
  if (key === "resultStatus") {
    return value === "success" ||
      value === "not_found" ||
      value === "ambiguous" ||
      value === "unavailable"
      ? value
      : undefined;
  }
  if (key === "lifecycleOutcome") {
    return typeof value === "string" && TRACE_LIFECYCLE_OUTCOMES.has(value) ? value : undefined;
  }
  return sanitizeTelemetryValue(value);
}

function boundedTelemetryCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(0, value))
    : undefined;
}

export function sanitizeLastRouteRecord(record: LastRouteRecord): LastRouteRecord {
  const sanitized: LastRouteRecord = {
    requestId: record.requestId,
    occurredAt: record.occurredAt,
    profileName: record.profileName,
    sourceType: record.sourceType,
    phase: record.phase
  };
  if (record.provider) sanitized.provider = record.provider;
  if (record.lane) sanitized.lane = record.lane;
  if (record.outcome) sanitized.outcome = record.outcome;
  if (record.action) sanitized.action = record.action;
  if (record.reason) sanitized.reason = record.reason;
  if (record.fallbackProvider) sanitized.fallbackProvider = record.fallbackProvider;
  if (record.fallbackReason) sanitized.fallbackReason = record.fallbackReason;
  if (record.query) sanitized.query = sanitizeQueryMarker(record.query);
  if (record.fileType) sanitized.fileType = record.fileType;
  if (typeof record.ok === "boolean") sanitized.ok = record.ok;
  if (typeof record.durationMs === "number") sanitized.durationMs = Math.max(0, record.durationMs);
  if (record.errorName) sanitized.errorName = record.errorName;
  return sanitized;
}

export function sanitizeLastErrorRecord(error: LastErrorRecord): LastErrorRecord {
  return {
    ...error,
    message: redactSensitiveText(error.message)
  };
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(token|secret|code|inviteCode|invite_code|key)=\S+/gi, "$1=[redacted]");
}

function sanitizeTelemetryValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, value) : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function sanitizeQueryMarker(value: LastRouteRecord["query"]): "present" | "empty" | "missing" {
  if (value === "empty" || value === "missing") {
    return value;
  }
  return value ? "present" : "missing";
}

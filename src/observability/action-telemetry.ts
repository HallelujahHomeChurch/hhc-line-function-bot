import type { RouteObserverEvent } from "../types.js";
import {
  ADMIN_ACTION_NAMES,
  AGENT_PLAN_DISPOSITIONS,
  isFunctionName,
  MODEL_PROVIDER_NAMES,
  SMALL_TALK_CATEGORIES,
  SYSTEM_ACTION_NAMES
} from "../types.js";
import type { LastErrorRecord } from "./last-error-store.js";
import type { LastRouteRecord } from "./last-route-store.js";

type TelemetryInput = object;

export function sanitizeActionTelemetryEvent(event: TelemetryInput): Partial<RouteObserverEvent> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    const safeValue = sanitizeTelemetryValueForKey(key, value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return sanitized as Partial<RouteObserverEvent>;
}

function sanitizeTelemetryValueForKey(key: string, value: unknown): unknown {
  switch (key) {
    case "kind":
      return allowedString(value, EVENT_KINDS);
    case "requestId":
      return presentMarker(value);
    case "profileName":
      return presentMarker(value) ? "configured" : undefined;
    case "sourceType":
      return allowedString(value, SOURCE_TYPES);
    case "phase":
      return allowedString(value, PHASES);
    case "provider":
    case "fallbackProvider":
      return allowedString(value, PROVIDERS);
    case "lane":
      return allowedString(value, LANES);
    case "outcome":
      return allowedString(value, OUTCOMES);
    case "action":
      return safeAction(value);
    case "reason":
    case "fallbackReason":
      return allowedString(value, REASONS);
    case "handler":
      return allowedString(value, HANDLERS);
    case "authorized":
    case "ok":
      return typeof value === "boolean" ? value : undefined;
    case "errorName":
      return presentMarker(value) ? "Error" : undefined;
    case "durationMs":
      return boundedTelemetryNumber(value, 60_000);
    case "engagement":
      return allowedString(value, ENGAGEMENTS);
    case "smallTalkCategory":
      return allowedString(value, new Set(SMALL_TALK_CATEGORIES));
    case "dedup":
      return allowedString(value, DEDUP_MARKERS);
    case "query":
      return allowedString(value, QUERY_MARKERS);
    case "candidates":
      return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => isFunctionName(item)))].slice(0, 5)
        : undefined;
    case "entityTypes":
      return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => TRACE_ENTITY_TYPES.has(item)))].slice(
            0,
            16
          )
        : undefined;
    case "candidateCount":
      return boundedTelemetryCount(value, 5);
    case "groundedFieldCount":
    case "droppedFieldCount":
      return boundedTelemetryCount(value, 32);
    case "anchorCount":
      return boundedTelemetryCount(value, 32);
    case "disposition":
      return allowedString(value, AGENT_TRACE_DISPOSITIONS);
    case "confidenceBucket":
      return allowedString(value, CONFIDENCE_BUCKETS);
    case "validatorReason":
      return allowedString(value, VALIDATOR_REASONS);
    case "resultStatus":
      return allowedString(value, RESULT_STATUSES);
    case "lifecycleOutcome":
      return allowedString(value, LIFECYCLE_OUTCOMES);
    default:
      return undefined;
  }
}

export function sanitizeLastRouteRecord(record: LastRouteRecord): LastRouteRecord {
  const event = sanitizeActionTelemetryEvent(record) as Record<string, unknown>;
  return compact({
    requestId: (event.requestId as string | undefined) ?? "missing",
    occurredAt: safeTimestamp(record.occurredAt),
    profileName: (event.profileName as string | undefined) ?? "configured",
    sourceType: (event.sourceType as string | undefined) ?? "unknown",
    phase: (allowedString(record.phase, LAST_ROUTE_PHASES) ?? "route") as LastRouteRecord["phase"],
    provider: event.provider as string | undefined,
    lane: event.lane as string | undefined,
    outcome: event.outcome as LastRouteRecord["outcome"],
    action: event.action as string | undefined,
    reason: event.reason as string | undefined,
    fallbackProvider: event.fallbackProvider as string | undefined,
    fallbackReason: event.fallbackReason as string | undefined,
    query: record.query ? sanitizeQueryMarker(record.query) : undefined,
    fileType: allowedString(record.fileType, FILE_TYPES),
    ok: event.ok as boolean | undefined,
    durationMs: event.durationMs as number | undefined,
    errorName: event.errorName as string | undefined
  });
}

export function sanitizeLastErrorRecord(error: LastErrorRecord): LastErrorRecord {
  const event = sanitizeActionTelemetryEvent(error) as Record<string, unknown>;
  return compact({
    requestId: (event.requestId as string | undefined) ?? "missing",
    occurredAt: safeTimestamp(error.occurredAt),
    profileName: (event.profileName as string | undefined) ?? "configured",
    sourceType: (event.sourceType as string | undefined) ?? "unknown",
    phase: (allowedString(error.phase, LAST_ERROR_PHASES) ?? "router") as LastErrorRecord["phase"],
    action: event.action as string | undefined,
    errorName: event.errorName as string | undefined,
    message: "redacted"
  });
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\b(token|secret|code|inviteCode|invite_code|key)=\S+/giu, "$1=[redacted]");
}

const EVENT_KINDS = new Set([
  "route",
  "function_result",
  "function_error",
  "admin_action_route",
  "admin_action_result",
  "text_handler",
  "postback",
  "admin_command",
  "rate_limited"
]);
const SOURCE_TYPES = new Set(["user", "group", "room"]);
const PHASES = new Set([
  "context",
  "query_clarification",
  "text_handler",
  "admin_action_route",
  "admin_action_result",
  "active_task",
  "capability_candidates",
  "planner",
  "plan_validation",
  "argument_grounding",
  "result_envelope",
  "controlled_route",
  "route",
  "small_talk",
  "slot_clarification",
  "memory_alias",
  "in_flight",
  "function",
  "function_error",
  "router",
  "admin",
  "postback",
  "admin_route",
  "admin_action"
]);
const PROVIDERS = new Set([...MODEL_PROVIDER_NAMES, "keyword", "router"]);
const LANES = new Set(["function_routing", "admin_routing", "smart_talk", "web_summarization"]);
const OUTCOMES = new Set([
  "execute",
  "collect",
  "continue",
  "refine",
  "advance",
  "select",
  "switch",
  "clarify",
  "chat",
  "respond",
  "deny",
  "handled",
  "miss",
  "hit",
  "busy",
  "started",
  "executed",
  "function",
  "router",
  "generated",
  "fallback",
  "template",
  "compressed",
  "full",
  "present",
  "missing",
  "invalid",
  "transition",
  "proposed",
  "no_plan",
  "accepted",
  "rejected",
  "success",
  "not_found",
  "ambiguous",
  "unavailable"
]);
const AGENT_TRACE_DISPOSITIONS = new Set([...AGENT_PLAN_DISPOSITIONS, "collect"]);
const REASONS = new Set([
  "active_task_refinement",
  "active_task_unavailable",
  "admin_action_disabled",
  "ambiguous_entity",
  "candidate_not_allowed",
  "capability_evidence_unresolved",
  "capability_not_agent_enabled",
  "deterministic_explicit_intent",
  "explicit_capability_switch",
  "explicit_intent",
  "explicit_switch_required",
  "function_disabled",
  "generation_failed",
  "generator_missing",
  "invalid_arguments",
  "invalid_policy",
  "keyword_ambiguous",
  "keyword_fallback_not_configured",
  "keyword_no_match",
  "low_confidence",
  "missing_required_slot",
  "no_capability_evidence",
  "not_matched",
  "operation_not_allowed",
  "ollama_unreachable",
  "planner_clarification",
  "planner_denied",
  "planner_unavailable",
  "primary_failed",
  "router_failed",
  "source_not_allowed",
  "system_route_evidence_missing",
  "template_mode",
  "unknown_action",
  "write_evidence_missing"
]);
const HANDLERS = new Set(["agent_runtime"]);
const ENGAGEMENTS = new Set([
  "command",
  "small_talk",
  "intro",
  "mention_only",
  "third_person",
  "ignore",
  "conversation_window"
]);
const DEDUP_MARKERS = new Set(["agent_memory", "busy", "started"]);
const QUERY_MARKERS = new Set(["present", "empty", "missing"]);
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
const CONFIDENCE_BUCKETS = new Set(["low", "medium", "high"]);
const VALIDATOR_REASONS = REASONS;
const RESULT_STATUSES = new Set(["success", "not_found", "ambiguous", "unavailable"]);
const LIFECYCLE_OUTCOMES = new Set([
  "read",
  "missing",
  "invalid",
  "write",
  "preserve",
  "replace",
  "expire",
  "clear"
]);
const LAST_ROUTE_PHASES = new Set(["route", "function", "admin_route", "admin_action"]);
const LAST_ERROR_PHASES = new Set(["router", "function", "admin", "postback", "text_handler"]);
const FILE_TYPES = new Set(["ppt", "pdf", "image", "any"]);
const SAFE_ACTIONS: ReadonlySet<string> = new Set([...SYSTEM_ACTION_NAMES, ...ADMIN_ACTION_NAMES]);

function safeAction(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return isFunctionName(value) || SAFE_ACTIONS.has(value) ? value : undefined;
}

function allowedString(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function presentMarker(value: unknown): "present" | undefined {
  return typeof value === "string" && value.length > 0 ? "present" : undefined;
}

function boundedTelemetryCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(0, value))
    : undefined;
}

function boundedTelemetryNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, value))
    : undefined;
}

function safeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : "1970-01-01T00:00:00.000Z";
}

function sanitizeQueryMarker(value: LastRouteRecord["query"]): "present" | "empty" | "missing" {
  if (value === "empty" || value === "missing") return value;
  return value ? "present" : "missing";
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

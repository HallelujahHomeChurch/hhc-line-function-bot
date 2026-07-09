import type { RouteObserverEvent } from "../types.js";
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
  "queryHash"
]);

export function sanitizeActionTelemetryEvent(event: TelemetryInput): Partial<RouteObserverEvent> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (!allowedTelemetryKeys.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeTelemetryValue(value);
  }
  return sanitized as Partial<RouteObserverEvent>;
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

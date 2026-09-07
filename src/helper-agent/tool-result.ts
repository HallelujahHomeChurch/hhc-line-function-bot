import type { AgentReplyData } from "../agent/result-envelope.js";
import type { FunctionExecutionResult, JsonRecord } from "../types.js";

export type HelperToolStatus = "success" | "not_found" | "ambiguous" | "unavailable" | "denied";
export type HelperToolSourceType = "official" | "knowledge" | "saved_note" | "public";

export interface HelperToolResult<T = unknown> {
  status: HelperToolStatus;
  sourceType: HelperToolSourceType;
  asOf?: string;
  truncated?: true;
  freshness?: "fresh" | "stale";
  data?: T;
  clarification?: string;
}

const MAX_CHARS = 2_000;
const MAX_RECORDS = 10;
const MAX_STRING_CHARS = 320;
const blockedField =
  /(?:secret|token|password|authorization|api[_-]?key|prompt|payload|response[_-]?data|url|uri|link|href|(?:id|key)s?$|source|document|section|resource|memory|drive|item)/iu;
const url = /(?:https?|ftp):\/\/|www\./iu;

export function projectToolResult(
  result: FunctionExecutionResult,
  sourceType: HelperToolSourceType
): HelperToolResult<AgentReplyData> {
  const agentResult = result.agentResult;
  const projected: HelperToolResult<AgentReplyData> = {
    status: agentResult?.status ?? (result.ok ? "success" : "unavailable"),
    sourceType
  };
  const freshness = result.diagnostics?.freshnessStatus;
  if (freshness === "fresh" || freshness === "stale_allowed") {
    projected.freshness = freshness === "fresh" ? "fresh" : "stale";
    const timestamp = result.diagnostics?.dataAsOf;
    if (timestamp && Number.isFinite(Date.parse(timestamp))) {
      projected.asOf = new Date(timestamp).toISOString();
    }
  }
  const coverage = { truncated: false };
  const clarification = safeString(agentResult?.clarification?.prompt);
  if (clarification) projected.clarification = clarification;
  const data = projectReplyData(agentResult?.replyData, coverage);
  if (data) projected.data = data;
  if (coverage.truncated) projected.truncated = true;
  return fit(projected);
}

function projectReplyData(
  replyData: AgentReplyData | undefined,
  coverage: { truncated: boolean }
): AgentReplyData | undefined {
  if (!replyData) return undefined;
  const kind = safeString(replyData.kind);
  if (!kind) return undefined;
  if ((replyData.records?.length ?? 0) > MAX_RECORDS) coverage.truncated = true;
  const fields = safeRecord(replyData.fields, 0, coverage);
  const records = replyData.records
    ?.slice(0, MAX_RECORDS)
    .map((record) => safeRecord(record, 0, coverage))
    .filter((record) => Object.keys(record).length > 0);
  if (!Object.keys(fields).length && !records?.length) return undefined;
  return { kind: kind.slice(0, 80), fields, ...(records?.length ? { records } : {}) };
}

function safeRecord(value: JsonRecord, depth = 0, coverage = { truncated: false }): JsonRecord {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blockedField.test(key))
      .flatMap(([key, entry]) => {
        const safe = safeValue(entry, depth, coverage);
        return safe === undefined ? [] : [[key, safe]];
      })
  );
}

function safeValue(value: unknown, depth: number, coverage: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    if (!url.test(value) && value.length > MAX_STRING_CHARS) coverage.truncated = true;
    return safeString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 2 || Array.isArray(value) || !value || typeof value !== "object") return undefined;
  return safeRecord(value as JsonRecord, depth + 1, coverage);
}

function safeString(value: string | undefined): string | undefined {
  if (!value || url.test(value)) return undefined;
  return value.slice(0, MAX_STRING_CHARS);
}

function fit(result: HelperToolResult<AgentReplyData>): HelperToolResult<AgentReplyData> {
  if (JSON.stringify(result).length > MAX_CHARS) result.truncated = true;
  while (JSON.stringify(result).length > MAX_CHARS && result.data?.records?.length) {
    result.data.records.pop();
  }
  while (JSON.stringify(result).length > MAX_CHARS && result.data?.fields) {
    const key = Object.keys(result.data.fields).pop();
    if (!key) break;
    delete result.data.fields[key];
  }
  if (JSON.stringify(result).length > MAX_CHARS) delete result.data;
  if (JSON.stringify(result).length > MAX_CHARS) delete result.clarification;
  return result;
}

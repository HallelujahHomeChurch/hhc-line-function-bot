import type { AgentReplyData } from "../agent/result-envelope.js";
import type { FunctionExecutionResult, JsonRecord } from "../types.js";

export type HelperToolStatus = "success" | "not_found" | "ambiguous" | "unavailable" | "denied";
export type HelperToolSourceType = "official" | "knowledge" | "saved_note" | "public";

export interface HelperToolResult<T = unknown> {
  status: HelperToolStatus;
  sourceType: HelperToolSourceType;
  asOf?: string;
  revision?: string;
  freshness?: "fresh" | "stale";
  data?: T;
  clarification?: string;
}

const MAX_CHARS = 2_000;
const MAX_RECORDS = 10;
const MAX_STRING_CHARS = 320;
const blockedField =
  /(?:secret|token|password|authorization|api[_-]?key|prompt|payload|response[_-]?data|source[_-]?id|document[_-]?id|memory[_-]?id|resource[_-]?id|drive[_-]?id|item[_-]?id|url|uri|link|href)/iu;
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
  const clarification = safeString(agentResult?.clarification?.prompt);
  if (clarification) projected.clarification = clarification;
  const data = projectReplyData(agentResult?.replyData);
  if (data) projected.data = data;
  return fit(projected);
}

function projectReplyData(replyData: AgentReplyData | undefined): AgentReplyData | undefined {
  if (!replyData) return undefined;
  const fields = safeRecord(replyData.fields);
  const records = replyData.records
    ?.slice(0, MAX_RECORDS)
    .map(safeRecord)
    .filter((record) => Object.keys(record).length > 0);
  if (!Object.keys(fields).length && !records?.length) return undefined;
  return { kind: replyData.kind.slice(0, 80), fields, ...(records?.length ? { records } : {}) };
}

function safeRecord(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blockedField.test(key))
      .flatMap(([key, entry]) => {
        const safe = safeValue(entry);
        return safe === undefined ? [] : [[key, safe]];
      })
  );
}

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 2 || Array.isArray(value) || !value || typeof value !== "object") return undefined;
  return safeRecord(value as JsonRecord);
}

function safeString(value: string | undefined): string | undefined {
  if (!value || url.test(value)) return undefined;
  return value.slice(0, MAX_STRING_CHARS);
}

function fit(result: HelperToolResult<AgentReplyData>): HelperToolResult<AgentReplyData> {
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

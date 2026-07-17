import { getFunctionDefinition } from "../functions/definitions.js";
import type { FunctionExecutionResult, FunctionName, JsonRecord } from "../types.js";

const FULL_REPLY_PATTERN = /(?:完整(?:內容|資訊|結果|服事表)?|全部|整份|查看全文|全文)/u;

export function projectAgentReply(input: {
  capability: FunctionName;
  text: string;
  result: FunctionExecutionResult;
}): FunctionExecutionResult {
  const envelope = input.result.agentResult;
  const replyData = input.result.responseData ?? envelope?.replyData;
  if (!input.result.ok || envelope?.status !== "success" || !replyData) {
    return input.result;
  }
  if (FULL_REPLY_PATTERN.test(input.text.normalize("NFKC"))) {
    return withProjection(input.result, input.result.replyText, "full");
  }
  const projection = getFunctionDefinition(input.capability)?.agentCapability?.responseProjection;
  if (!projection) return input.result;
  const roleReply = projectNamedRecord(input.text, replyData.records ?? []);
  if (roleReply) return withProjection(input.result, roleReply, "focused");

  const field = requestedField(input.text, projection.fields);
  if (!field) return input.result;
  const value = printableValue(replyData.fields[field]);
  return value
    ? withProjection(input.result, `${projection.fields[field].label}：${value}`, "focused")
    : input.result;
}

function projectNamedRecord(text: string, records: JsonRecord[]): string | undefined {
  const normalizedText = normalize(text);
  const matches = records.flatMap((record) => {
    const role = printableValue(record.role);
    const people = printableValue(record.people ?? record.assignee ?? record.value);
    return role && people && normalizedText.includes(normalize(role))
      ? [{ record, role, people }]
      : [];
  });
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return `${matches[0].role}：${matches[0].people}`;
  return matches
    .map(({ record, role, people }) => {
      const anchor = printableValue(record.date ?? record.meeting);
      return anchor ? `${anchor} ${role}：${people}` : `${role}：${people}`;
    })
    .join("\n");
}

function requestedField(
  text: string,
  fields: Record<string, { label: string; aliases: string[] }>
): string | undefined {
  const normalizedText = normalize(text);
  return Object.entries(fields).find(([, field]) =>
    field.aliases.some((candidate) => normalizedText.includes(normalize(candidate)))
  )?.[0];
}

function printableValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value.flatMap((item) => printableValue(item) ?? []);
    return values.length > 0 ? values.join("、") : undefined;
  }
  return undefined;
}

function withProjection(
  result: FunctionExecutionResult,
  replyText: string,
  projectionHint: "focused" | "full"
): FunctionExecutionResult {
  return {
    ...result,
    replyText,
    agentResult: result.agentResult
      ? { ...result.agentResult, replyText, projectionHint }
      : result.agentResult
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,，、:：。.!！?？/\\_-]+/gu, "");
}

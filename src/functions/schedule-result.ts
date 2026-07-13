import type { AgentEntity, AgentResultEnvelope } from "../agent/result-envelope.js";
import type { QuickReplyItem } from "../types.js";

export interface ScheduleResultRow {
  date?: string;
  serviceDate?: string;
  meeting?: string;
  meetingName?: string;
  role?: string;
  sourceKey?: string;
}

export interface ScheduleResultFilters {
  replyText: string;
  role?: string;
  sourceKeys?: string[];
  quickReplies?: QuickReplyItem[];
}

export interface ScheduleRoleResolution<T extends ScheduleResultRow> {
  status: "success" | "ambiguous";
  rows: T[];
  choices: string[];
}

const SCHEDULE_OPERATIONS = ["continue", "refine", "advance"];

export function scheduleResultEnvelope(
  rows: ScheduleResultRow[],
  filters: ScheduleResultFilters
): AgentResultEnvelope {
  if (rows.length === 0) {
    return {
      status: "not_found",
      replyText: filters.replyText,
      ...(filters.quickReplies ? { quickReplies: filters.quickReplies } : {})
    };
  }

  const entities = roleEntities(rows);
  const ambiguousChoices = ambiguousRoleChoices(entities, filters.role);
  if (ambiguousChoices.length > 1) {
    const requestedRole = filters.role?.trim() || "這個角色";
    const prompt = `「${requestedRole}」可能是多個服事角色，請選擇：${ambiguousChoices.join("、")}。`;
    return {
      status: "ambiguous",
      replyText: prompt,
      anchors: scheduleAnchors(rows, filters.sourceKeys),
      entities,
      clarification: { prompt, choices: ambiguousChoices }
    };
  }

  return {
    status: "success",
    replyText: filters.replyText,
    anchors: scheduleAnchors(rows, filters.sourceKeys),
    entities,
    supportedOperations: [...SCHEDULE_OPERATIONS]
  };
}

export function resolveScheduleResultRows<T extends ScheduleResultRow>(
  rows: T[],
  requestedRole?: string
): ScheduleRoleResolution<T> {
  const normalizedRequested = normalizeRole(requestedRole ?? "");
  if (!normalizedRequested) {
    return { status: "success", rows, choices: [] };
  }

  const entities = roleEntities(rows);
  const exact = entities.find((entity) => entity.key === normalizedRequested);
  if (exact) {
    return {
      status: "success",
      rows: rows.filter((row) => normalizeRole(row.role ?? "") === exact.key),
      choices: []
    };
  }

  const candidates = entities.filter(
    (entity) =>
      entity.key.includes(normalizedRequested) ||
      entity.aliases?.some((alias) => normalizeRole(alias) === normalizedRequested)
  );
  if (candidates.length === 1) {
    return {
      status: "success",
      rows: rows.filter((row) => normalizeRole(row.role ?? "") === candidates[0].key),
      choices: []
    };
  }
  if (candidates.length > 1) {
    const keys = new Set(candidates.map((entity) => entity.key));
    return {
      status: "ambiguous",
      rows: rows.filter((row) => keys.has(normalizeRole(row.role ?? ""))),
      choices: candidates.map((entity) => entity.label)
    };
  }
  return { status: "success", rows, choices: [] };
}

function roleEntities(rows: ScheduleResultRow[]): AgentEntity[] {
  const roles = new Map<string, string>();
  for (const row of rows) {
    const label = row.role?.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const key = normalizeRole(label ?? "");
    if (label && key && !roles.has(key)) {
      roles.set(key, label);
    }
  }

  const labels = Array.from(roles.values());
  return Array.from(roles, ([key, label]) => {
    const aliases = unambiguousSuffixes(label, labels);
    return {
      type: "role",
      key,
      label,
      ...(aliases.length > 0 ? { aliases } : {})
    };
  });
}

function unambiguousSuffixes(label: string, labels: string[]): string[] {
  const characters = Array.from(label);
  const candidates = characters
    .slice(1, -1)
    .map((_, index) => characters.slice(index + 1).join(""));
  return candidates.filter((candidate) => {
    const normalizedCandidate = normalizeRole(candidate);
    return (
      normalizedCandidate.length >= 2 &&
      labels.filter((other) => normalizeRole(other).endsWith(normalizedCandidate)).length === 1
    );
  });
}

function ambiguousRoleChoices(entities: AgentEntity[], requestedRole?: string): string[] {
  const normalizedRequested = normalizeRole(requestedRole ?? "");
  if (!normalizedRequested || entities.some((entity) => entity.key === normalizedRequested)) {
    return [];
  }
  return entities
    .filter(
      (entity) =>
        entity.key.includes(normalizedRequested) ||
        entity.aliases?.some((alias) => normalizeRole(alias) === normalizedRequested)
    )
    .map((entity) => entity.label);
}

function scheduleAnchors(rows: ScheduleResultRow[], sourceKeys: string[] = []) {
  const dates = unique(
    rows.map((row) => extractDateKey(row.date ?? row.serviceDate ?? "")).filter(Boolean)
  );
  const meetings = unique(
    rows.map((row) => (row.meeting ?? row.meetingName ?? "").trim()).filter(Boolean)
  );
  const sources = unique(
    [...sourceKeys, ...rows.map((row) => row.sourceKey ?? "")].filter(Boolean)
  );
  return {
    ...(dates.length === 1 ? { date: dates[0] } : {}),
    ...(meetings.length === 1 ? { meeting: meetings[0] } : {}),
    ...(sources.length > 0 ? { sourceKeys: sources } : {})
  };
}

function normalizeRole(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[\s：:，,。.!！?？]+/gu, "")
    .toLowerCase();
}

function extractDateKey(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/u)?.[0] ?? "";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

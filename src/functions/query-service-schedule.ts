import { randomUUID } from "node:crypto";

import {
  queryServiceScheduleArgumentsSchema,
  type QueryServiceScheduleArguments
} from "../function-arguments.js";
import { readTimeZone } from "../time-zone.js";
import type {
  FunctionExecutionResult,
  FunctionHandler,
  JsonRecord,
  NotionDatabaseClient
} from "../types.js";
import { withRequesterDisplayName } from "../requester-personalization.js";
import type { SessionStore } from "../state/session-store.js";
import { normalizeNotionSchedulePage } from "../schedules/notion-adapter.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import { resolveScheduleResultRows, scheduleResultEnvelope } from "./schedule-result.js";

export interface QueryServiceScheduleOptions {
  notion: NotionDatabaseClient;
  databaseId: string;
  properties: {
    date: string;
    meeting: string;
    role: string;
    person: string;
  };
  now?: () => Date;
  timeZone?: string;
  sessionStore?: SessionStore;
  requestIdFactory?: () => string;
  sourceKeys?: string[];
}

export interface ServiceRow {
  date: string;
  meeting: string;
  role: string;
  person: string;
}

export interface DerivedFilters {
  date?: string;
  meeting?: string;
  role?: string;
  limit?: number;
  nextMeetingOnly?: boolean;
  range?: {
    start: string;
    endExclusive: string;
  };
}

export function createQueryServiceScheduleHandler(
  options: QueryServiceScheduleOptions
): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const timeZone = readTimeZone(options.timeZone, "timeZone");
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async (rawArgs, context) => {
    const args = queryServiceScheduleArgumentsSchema.parse(rawArgs);

    if (options.sessionStore && needsServiceScheduleClarification(args)) {
      await storePendingFunctionQuery({
        sessionStore: options.sessionStore,
        requestId: requestIdFactory(),
        action: "query_service_schedule",
        arguments: args,
        context,
        now: now()
      });

      return {
        ok: true,
        replyText: withRequesterDisplayName(
          context,
          "要查哪個服事表範圍？請選擇或直接回覆：下一場、本週、明天、主日。"
        ),
        quickReplies: [
          {
            label: "下一場",
            action: { type: "message", label: "下一場", text: "下一場" }
          },
          {
            label: "本週",
            action: { type: "message", label: "本週", text: "本週" }
          },
          {
            label: "明天",
            action: { type: "message", label: "明天", text: "明天" }
          },
          {
            label: "主日",
            action: { type: "message", label: "主日", text: "主日服事" }
          }
        ]
      };
    }

    const derivedFilters = deriveFilters(args, now(), timeZone);
    const pages = await options.notion.queryDatabase(
      options.databaseId,
      buildNotionQuery(derivedFilters, options.properties.date)
    );

    const rows = pages.flatMap((page) => {
      const date = configuredPropertyToText(page.properties, options.properties.date);
      const serviceDate = extractDateKey(date);
      if (!serviceDate) return [];
      const normalized = normalizeNotionSchedulePage({
        pageId: page.id,
        serviceDate,
        meeting: configuredPropertyToText(page.properties, options.properties.meeting),
        role: configuredPropertyToText(page.properties, options.properties.role),
        person: configuredPropertyToText(page.properties, options.properties.person)
      });
      return normalized.meeting.assignments.map((assignment) => ({
        date,
        meeting: normalized.meeting.meeting,
        role: assignment.role,
        person: assignment.assignees.join(",")
      }));
    });

    const filteredRows = rows
      .filter((row) => matchesOptional(row.date, derivedFilters.date))
      .filter((row) => matchesOptional(row.meeting, derivedFilters.meeting))
      .filter((row) => matchesOptional(row.role, derivedFilters.role))
      .filter((row) => matchesDateRange(row.date, derivedFilters.range));
    const meetingRows = derivedFilters.nextMeetingOnly
      ? limitToFirstUpcomingGroup(filteredRows, now(), timeZone)
      : filteredRows;
    const roleResolution = resolveScheduleResultRows(meetingRows, derivedFilters.role);
    const filtered =
      derivedFilters.nextMeetingOnly || roleResolution.status === "ambiguous"
        ? roleResolution.rows
        : roleResolution.rows.slice(0, derivedFilters.limit ?? 10);

    if (filtered.length === 0) {
      const replyText = "查不到符合的服事表。";
      const quickReplies = [
        {
          label: "查本週服事",
          action: { type: "message" as const, label: "查本週服事", text: "小哈 查本週服事" }
        },
        {
          label: "查主日服事",
          action: { type: "message" as const, label: "查主日服事", text: "小哈 查主日服事" }
        }
      ];
      return {
        ok: true,
        replyText,
        quickReplies,
        agentResult: scheduleResultEnvelope([], {
          replyText,
          role: derivedFilters.role,
          quickReplies
        })
      };
    }

    const replyText = formatServiceScheduleReply(filtered, args, derivedFilters);
    const agentResult = scheduleResultEnvelope(filtered, {
      replyText,
      role: derivedFilters.role,
      sourceKeys: options.sourceKeys
    });
    return {
      ok: true,
      continuation: liveScheduleContinuation(
        filtered,
        derivedFilters.role,
        continuationRoles(context.continuation?.arguments),
        options.sourceKeys
      ),
      replyText: agentResult.replyText,
      agentResult
    };
  };
}

function liveScheduleContinuation(
  rows: ServiceRow[],
  role?: string,
  previousRoles: string[] = [],
  sourceKeys: string[] = []
): FunctionExecutionResult["continuation"] | undefined {
  const dates = Array.from(new Set(rows.map((row) => extractDateKey(row.date)).filter(Boolean)));
  const meetings = Array.from(new Set(rows.map((row) => row.meeting).filter(Boolean)));
  if (dates.length !== 1 || meetings.length !== 1) return undefined;
  return {
    arguments: {
      date: dates[0],
      meeting: meetings[0],
      availableRoles: Array.from(
        new Set([...previousRoles, ...rows.map((row) => row.role).filter(Boolean)])
      ),
      ...(sourceKeys.length > 0
        ? { scheduleRoute: "live_notion", sourceKeys: Array.from(new Set(sourceKeys)) }
        : {}),
      ...(role ? { role } : {})
    },
    resultReferences: {
      kind: "notion_schedule",
      ...(sourceKeys.length > 0 ? { sourceKeys: Array.from(new Set(sourceKeys)) } : {})
    }
  };
}

function continuationRoles(arguments_: unknown): string[] | undefined {
  if (!arguments_ || typeof arguments_ !== "object") return undefined;
  const roles = (arguments_ as Record<string, unknown>).availableRoles;
  return Array.isArray(roles) && roles.every((role) => typeof role === "string")
    ? roles
    : undefined;
}

function needsServiceScheduleClarification(args: QueryServiceScheduleArguments): boolean {
  const hasStructuredMetadata = [
    args.date,
    args.dateIntent,
    args.specificDate,
    args.meeting,
    args.role
  ].some((value) => typeof value === "string" && value.trim());
  if (hasStructuredMetadata) {
    return false;
  }

  const normalized = args.query
    .normalize("NFKC")
    .trim()
    .replace(/^小哈[，,\s]*/i, "")
    .replace(/^(請|幫我|幫忙|查詢|查|找|搜尋)\s*/u, "")
    .replace(/\s+/g, "");

  return [
    "",
    "服事",
    "服事表",
    "服事人員",
    "服事安排",
    "聚會服事",
    "聚會服事表",
    "聚會服事人員",
    "聚會服事安排"
  ].includes(normalized);
}

function buildNotionQuery(filters: DerivedFilters, dateProperty: string): JsonRecord {
  if (!filters.range) {
    return {};
  }

  return {
    filter: {
      and: [
        {
          property: dateProperty,
          date: {
            on_or_after: filters.range.start
          }
        },
        {
          property: dateProperty,
          date: {
            before: filters.range.endExclusive
          }
        }
      ]
    }
  };
}

export function deriveFilters(
  args: QueryServiceScheduleArguments,
  now: Date,
  timeZone: string
): DerivedFilters {
  const query = args.query.trim();
  const filters: DerivedFilters = {
    date: args.date,
    meeting: cleanOptionalText(args.meeting),
    role: cleanOptionalText(args.role),
    limit: args.limit
  };

  applyStructuredDateIntent(filters, args, now, timeZone);

  if (!filters.range && isDateKey(args.date)) {
    filters.range = dateKeyRange(args.date);
  }

  if (!filters.range && query.includes("今天")) {
    filters.range = dayRange(now, 0, timeZone);
  } else if (!filters.range && query.includes("明天")) {
    filters.range = dayRange(now, 1, timeZone);
  } else if (!filters.range && (query.includes("後天") || query.includes("后天"))) {
    filters.range = dayRange(now, 2, timeZone);
  }

  if (!filters.range && /(本週|本周|這週|這周|这週|这周)/.test(query)) {
    filters.range = upcomingRange(now, timeZone);
  }

  if (!args.dateIntent && /(下一場|下場|最近一場|下一次|下次)/.test(query)) {
    filters.nextMeetingOnly = true;
    filters.range ??= upcomingRange(now, timeZone);
  }

  if (!filters.meeting && query.includes("主日")) {
    filters.meeting = "主日";
  }

  if (!filters.role) {
    filters.role = extractKnownScheduleRole(query);
  }

  if (!filters.range && !filters.date && /服事/.test(query)) {
    filters.range = upcomingRange(now, timeZone);
  }

  return filters;
}

function applyStructuredDateIntent(
  filters: DerivedFilters,
  args: QueryServiceScheduleArguments,
  now: Date,
  timeZone: string
): void {
  switch (args.dateIntent) {
    case "today":
      filters.range = dayRange(now, 0, timeZone);
      break;
    case "tomorrow":
      filters.range = dayRange(now, 1, timeZone);
      break;
    case "day_after_tomorrow":
      filters.range = dayRange(now, 2, timeZone);
      break;
    case "this_week":
    case "upcoming":
      filters.range = upcomingRange(now, timeZone);
      break;
    case "next_meeting":
      filters.nextMeetingOnly = true;
      filters.range = upcomingRange(now, timeZone);
      break;
    case "specific_date": {
      const date = args.specificDate ?? args.date;
      if (date) {
        filters.date = date;
        filters.range = dateKeyRange(date);
      }
      break;
    }
    default:
      break;
  }
}

function limitToFirstUpcomingGroup(rows: ServiceRow[], now: Date, timeZone: string): ServiceRow[] {
  const [first] = groupRows(rows)
    .map((group) => ({ group, window: inferServiceGroupWindow(group, timeZone) }))
    .filter(({ window }) => !window?.end || window.end > now)
    .sort((left, right) => {
      const leftTime = left.window?.start.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.window?.start.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
  return first?.group.rows ?? [];
}

function upcomingRange(now: Date, timeZone: string): NonNullable<DerivedFilters["range"]> {
  const start = toDateKey(now, timeZone);
  return {
    start,
    endExclusive: addDaysToDateKey(start, 7)
  };
}

function dayRange(
  now: Date,
  offsetDays: number,
  timeZone: string
): NonNullable<DerivedFilters["range"]> {
  const start = addDaysToDateKey(toDateKey(now, timeZone), offsetDays);
  return dateKeyRange(start);
}

function dateKeyRange(dateKey: string): NonNullable<DerivedFilters["range"]> {
  return {
    start: dateKey,
    endExclusive: addDaysToDateKey(dateKey, 1)
  };
}

function isDateKey(value: string | undefined): value is string {
  return Boolean(value?.match(/^\d{4}-\d{2}-\d{2}$/));
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function extractKnownScheduleRole(query: string): string | undefined {
  const knownRoles = [
    "司會",
    "主席",
    "領詩",
    "敬拜",
    "司琴",
    "招待",
    "音控",
    "投影",
    "兒童",
    "講員"
  ];
  return knownRoles.find((role) => {
    let start = query.indexOf(role);
    while (start >= 0) {
      const suffix = query.slice(start + role.length, start + role.length + 1);
      if (!(role === "投影" && suffix === "片")) return true;
      start = query.indexOf(role, start + role.length);
    }
    return false;
  });
}

function matchesOptional(value: string, expected?: string): boolean {
  if (!expected?.trim()) {
    return true;
  }
  return value.toLowerCase().includes(expected.trim().toLowerCase());
}

function matchesDateRange(value: string, range: DerivedFilters["range"]): boolean {
  if (!range) {
    return true;
  }
  const date = extractDateKey(value);
  if (!date) {
    return false;
  }
  return date >= range.start && date < range.endExclusive;
}

function extractDateKey(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function toDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function formatServiceScheduleReply(
  rows: ServiceRow[],
  args: QueryServiceScheduleArguments,
  filters: DerivedFilters
): string {
  const title = scheduleTitle(args, filters);
  const firstDateKey = extractDateKey(rows[0]?.date ?? "");
  const dateLine = firstDateKey ? formatMonthDay(firstDateKey) : rows[0]?.date || "未填日期";
  const lines = [title, dateLine, ""];

  const groups = groupRows(rows);
  groups.forEach((group, index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(`【${group.meeting || formatMonthDay(group.dateKey) || "未填聚會"}】`);
    lines.push("服事同工：");
    for (const row of group.rows) {
      lines.push(...formatRosterLines(row));
    }
  });

  return lines.join("\n");
}

function scheduleTitle(args: QueryServiceScheduleArguments, filters: DerivedFilters): string {
  const query = args.query.trim();
  if (filters.nextMeetingOnly || args.dateIntent === "next_meeting") {
    return "下一場聚會服事表";
  }
  if (args.dateIntent === "tomorrow" || query.includes("明天")) {
    return "明天聚會服事表";
  }
  if (args.dateIntent === "today" || query.includes("今天")) {
    return "今天聚會服事表";
  }
  if (
    args.dateIntent === "day_after_tomorrow" ||
    query.includes("後天") ||
    query.includes("后天")
  ) {
    return "後天聚會服事表";
  }
  return "聚會服事表";
}

interface ServiceGroup {
  dateKey: string;
  meeting: string;
  rows: ServiceRow[];
}

interface MeetingTimeRule {
  pattern: RegExp;
  weekdays?: number[];
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

const MEETING_TIME_RULES: MeetingTimeRule[] = [
  {
    pattern: /晨更/u,
    weekdays: [2, 5],
    startHour: 6,
    startMinute: 30,
    endHour: 8,
    endMinute: 30
  },
  {
    pattern: /仙履奇緣/u,
    weekdays: [4],
    startHour: 6,
    startMinute: 30,
    endHour: 9,
    endMinute: 0
  },
  {
    pattern: /福音餐會/u,
    weekdays: [4],
    startHour: 12,
    startMinute: 0,
    endHour: 14,
    endMinute: 0
  },
  {
    pattern: /門訓禱告會/u,
    weekdays: [5],
    startHour: 19,
    startMinute: 0,
    endHour: 21,
    endMinute: 30
  },
  {
    pattern: /國度禱告會/u,
    weekdays: [6],
    startHour: 9,
    startMinute: 0,
    endHour: 11,
    endMinute: 30
  },
  {
    pattern: /主日/u,
    weekdays: [0],
    startHour: 9,
    startMinute: 0,
    endHour: 12,
    endMinute: 0
  }
];

function groupRows(rows: ServiceRow[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const row of rows) {
    const dateKey = extractDateKey(row.date);
    const meeting = row.meeting || "";
    const key = `${dateKey}\u0000${meeting}`;
    const group = groups.get(key) ?? { dateKey, meeting, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function inferServiceGroupWindow(
  group: ServiceGroup,
  timeZone: string
): { start: Date; end: Date } | undefined {
  const rawDate = group.rows[0]?.date ?? "";
  const explicitWindow = parseDateTimeWindow(rawDate);
  if (explicitWindow) {
    return explicitWindow;
  }

  if (!group.dateKey) {
    return undefined;
  }
  const rule = inferMeetingTimeRule(group.meeting, group.dateKey);
  return {
    start: zonedDateTimeToUtc(group.dateKey, rule.startHour, rule.startMinute, timeZone),
    end: zonedDateTimeToUtc(group.dateKey, rule.endHour, rule.endMinute, timeZone)
  };
}

function parseDateTimeWindow(value: string): { start: Date; end: Date } | undefined {
  const matches = value.match(/\d{4}-\d{2}-\d{2}T[^\s~]+/g);
  if (!matches || matches.length === 0) {
    return undefined;
  }
  const first = matches[0];
  const last = matches.length > 1 ? matches.at(-1) : matches[0];
  if (!first || !last) {
    return undefined;
  }
  const start = new Date(first);
  const parsed = new Date(last);
  if (Number.isNaN(start.getTime()) || Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return {
    start,
    end: matches.length > 1 ? parsed : new Date(parsed.getTime() + 3 * 60 * 60 * 1000)
  };
}

function inferMeetingTimeRule(meeting: string, dateKey: string): MeetingTimeRule {
  const weekday = weekdayFromDateKey(dateKey);
  const rule = MEETING_TIME_RULES.find(
    (candidate) =>
      candidate.pattern.test(meeting) &&
      (!candidate.weekdays || candidate.weekdays.includes(weekday))
  );
  if (rule) {
    return rule;
  }
  return {
    pattern: /.*/u,
    startHour: 0,
    startMinute: 0,
    endHour: 23,
    endMinute: 59
  };
}

function weekdayFromDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function zonedDateTimeToUtc(dateKey: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(utcGuess.getTime() - timeZoneOffsetMs(utcGuess, timeZone));
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return zonedAsUtc - date.getTime();
}

function formatMonthDay(dateKey: string): string {
  const match = dateKey.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function formatRosterLines(row: ServiceRow): string[] {
  return [`- ${row.role.trim() || "服事"}：${row.person || "未填人員"}`];
}

function propertyToText(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const value = property as JsonRecord;
  const type = typeof value.type === "string" ? value.type : "";

  switch (type) {
    case "title":
      return richTextArrayToText(value.title);
    case "rich_text":
      return richTextArrayToText(value.rich_text);
    case "date": {
      const date = value.date as { start?: string; end?: string } | null | undefined;
      return [date?.start, date?.end].filter(Boolean).join(" ~ ");
    }
    case "select": {
      const select = value.select as { name?: string } | null | undefined;
      return select?.name ?? "";
    }
    case "multi_select": {
      const items = value.multi_select as Array<{ name?: string }> | undefined;
      return (items ?? [])
        .map((item) => item.name)
        .filter(Boolean)
        .join(", ");
    }
    case "people": {
      const people = value.people as
        Array<{ name?: string; person?: { email?: string } }> | undefined;
      return (people ?? [])
        .map((person) => person.name ?? person.person?.email)
        .filter(Boolean)
        .join(", ");
    }
    case "formula": {
      const formula = value.formula as JsonRecord | undefined;
      if (!formula || typeof formula.type !== "string") {
        return "";
      }
      const formulaValue = formula[formula.type];
      return typeof formulaValue === "string" || typeof formulaValue === "number"
        ? String(formulaValue)
        : "";
    }
    case "number":
      return typeof value.number === "number" ? String(value.number) : "";
    case "url":
    case "email":
    case "phone_number":
      return typeof value[type] === "string" ? value[type] : "";
    case "checkbox":
      return typeof value.checkbox === "boolean" ? String(value.checkbox) : "";
    default:
      return "";
  }
}

export function configuredPropertyToText(
  properties: Record<string, unknown>,
  configuredKey: string
): string {
  return propertyToText(findConfiguredProperty(properties, configuredKey));
}

function findConfiguredProperty(
  properties: Record<string, unknown>,
  configuredKey: string
): unknown {
  if (configuredKey in properties) {
    return properties[configuredKey];
  }

  return Object.values(properties).find(
    (property) =>
      property &&
      typeof property === "object" &&
      "id" in property &&
      String((property as { id?: unknown }).id) === configuredKey
  );
}

function richTextArrayToText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (item && typeof item === "object" && "plain_text" in item) {
        return String((item as { plain_text?: string }).plain_text ?? "");
      }
      return "";
    })
    .join("");
}

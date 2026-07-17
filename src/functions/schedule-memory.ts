import { randomUUID } from "node:crypto";

import {
  queryScheduleMemoryArgumentsSchema,
  saveScheduleMemoryArgumentsSchema,
  type QueryScheduleMemoryArguments,
  type SaveScheduleMemoryArguments
} from "../function-arguments.js";
import type {
  AgentMemoryStore,
  AgentScheduleEntryInput,
  AgentScheduleEntryRecord,
  AgentScheduleType
} from "../agent/memory-store.js";
import { normalizeLookupText } from "../agent/memory-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandler,
  FunctionHandlerContext,
  FunctionName
} from "../types.js";
import type { SessionStore } from "../state/session-store.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import { resolveScheduleResultRows, scheduleResultEnvelope } from "./schedule-result.js";
import { selectFirstUpcomingOccurrence } from "../schedules/occurrence-policy.js";
import type { MeetingWindowRule } from "../types.js";
import { readTimeZone } from "../time-zone.js";

const SCHEDULE_MEMORY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface ParsedScheduleMemory {
  scheduleType: AgentScheduleType;
  title: string;
  entries: AgentScheduleEntryInput[];
}

export interface ParseScheduleMemoryContentInput {
  content: string;
  now?: Date;
  scheduleType?: AgentScheduleType;
  title?: string;
}

export interface ScheduleMemoryFunctionOptions {
  memoryStore: AgentMemoryStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
  action?: FunctionName;
  timeZone?: string;
}

export function parseScheduleMemoryContent(
  input: ParseScheduleMemoryContentInput
): ParsedScheduleMemory {
  const now = input.now ?? new Date();
  const scheduleType = input.scheduleType ?? inferScheduleType(input.content);
  const title = input.title?.trim() || defaultScheduleTitle(scheduleType);
  const entries = input.content
    .split(/\r?\n/)
    .map((line) => parseScheduleLine(line, scheduleType, now))
    .filter((entry): entry is AgentScheduleEntryInput => Boolean(entry));

  return { scheduleType, title, entries };
}

export function createSaveScheduleMemoryHandler(
  options: ScheduleMemoryFunctionOptions
): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const action = options.action ?? "save_schedule";
  return async (rawArgs, context) => {
    const args = saveScheduleMemoryArgumentsSchema.parse(rawArgs);
    const content = scheduleMemoryContent(args);

    if (args.cancel || isCancelText(args.query)) {
      return { ok: true, replyText: "好，我先不保存。" };
    }

    if (args.operation && args.operation !== "replace") {
      return handleScheduleMutation({
        args,
        context,
        options,
        now: now(),
        action,
        requestIdFactory
      });
    }

    if (!content) {
      return { ok: true, replyText: "請貼上要記住的服事表文字內容。" };
    }

    const parsed = parseScheduleMemoryContent({
      content,
      now: now(),
      scheduleType: args.scheduleType,
      title: args.title
    });

    if (parsed.entries.length === 0) {
      return {
        ok: true,
        replyText: "我還整理不出日期和服事內容，請貼文字版服事表，先不要傳圖片。"
      };
    }

    if (!args.confirm && !isConfirmText(args.query)) {
      const periodKey = parsed.entries[0]?.serviceDate.slice(0, 7);
      const existing = periodKey
        ? (
            await options.memoryStore.listScheduleMemories({
              profileName: context.profile.name,
              limit: 20
            })
          ).find(
            (schedule) =>
              schedule.scheduleType === parsed.scheduleType && schedule.periodKey === periodKey
          )
        : undefined;
      if (options.sessionStore) {
        await storePendingFunctionQuery({
          sessionStore: options.sessionStore,
          requestId: requestIdFactory(),
          action,
          arguments: {
            scheduleType: parsed.scheduleType,
            title: parsed.title,
            content,
            confirm: true
          },
          context,
          now: now()
        });
      }

      return {
        ok: true,
        replyText: formatSchedulePreview(parsed, existing?.title),
        quickReplies: [
          { label: "保存", action: { type: "message", label: "保存", text: "保存" } },
          { label: "取消", action: { type: "message", label: "取消", text: "取消" } }
        ]
      };
    }

    const expiresAt = new Date(now().getTime() + SCHEDULE_MEMORY_TTL_MS).toISOString();
    const saved = await options.memoryStore.saveScheduleMemory({
      profileName: context.profile.name,
      source: context.event.source,
      createdBy: context.event.source.userId,
      visibility: "profile",
      scheduleType: parsed.scheduleType,
      periodKey: parsed.entries[0]?.serviceDate.slice(0, 7),
      title: parsed.title,
      originalText: content,
      entries: parsed.entries,
      expiresAt
    });

    return {
      ok: true,
      writePhase: "commit",
      replyText: `已保存 ${parsed.entries.length} 筆${scheduleTypeLabel(parsed.scheduleType)}，之後可以請我查。`,
      agentResult: {
        status: "success",
        replyText: "服事表已保存。",
        anchors: { scheduleType: saved.scheduleType, memoryId: saved.id },
        entities: [
          {
            type: "scheduleType",
            key: saved.scheduleType,
            label: scheduleTypeLabel(saved.scheduleType)
          }
        ]
      }
    };
  };
}

async function handleScheduleMutation(input: {
  args: SaveScheduleMemoryArguments;
  context: FunctionHandlerContext;
  options: ScheduleMemoryFunctionOptions;
  now: Date;
  action: FunctionName;
  requestIdFactory: () => string;
}): Promise<FunctionExecutionResult> {
  const { args, context, options } = input;
  if (args.operation !== "add_entry" && context.requesterIsAdmin !== true) {
    return { ok: true, replyText: "只有管理員可以修改或刪除既有服事內容。" };
  }
  if (args.operation === "add_entry") {
    if (!args.entry || !args.scheduleType) {
      return { ok: true, replyText: "請告訴我要新增的日期、服事項目和家族或同工。" };
    }
    if (!args.confirm) {
      await storeMutationConfirmation(input);
      return mutationPreview(
        ["請確認這筆新服事：", formatEntryInput(args.entry), "要新增嗎？"],
        "保存"
      );
    }
    const added = await options.memoryStore.addScheduleEntry({
      profileName: context.profile.name,
      scheduleType: args.scheduleType,
      entry: args.entry
    });
    return {
      ok: true,
      replyText: added ? "已新增這筆服事。" : "找不到同月份的服事表，請先保存完整服事表。"
    };
  }

  if (args.operation === "delete_schedule") {
    const schedules = await options.memoryStore.listScheduleMemories({
      profileName: context.profile.name,
      limit: 20
    });
    const target = schedules.filter((schedule) =>
      normalizeLookupText(schedule.title).includes(normalizeLookupText(args.targetQuery ?? ""))
    );
    if (target.length !== 1) {
      return {
        ok: true,
        replyText:
          target.length === 0
            ? "找不到要刪除的服事表。"
            : ["找到多份服事表，請說明完整名稱：", ...target.map((item) => `- ${item.title}`)].join(
                "\n"
              )
      };
    }
    if (!args.confirm) {
      await storeMutationConfirmation(input);
      return mutationPreview([`要刪除整份「${target[0].title}」嗎？`], "刪除");
    }
    const removed = await options.memoryStore.forgetScheduleMemory({
      profileName: context.profile.name,
      source: context.event.source,
      id: target[0].id,
      deletedBy: context.event.source.userId,
      isAdmin: true
    });
    return { ok: true, replyText: removed ? "已刪除這份服事表。" : "服事表已變更，請重新查詢。" };
  }

  const targetQuery = args.targetQuery?.trim();
  if (!targetQuery) {
    return { ok: true, replyText: "請告訴我要修改或刪除哪一筆服事。" };
  }
  const matches = await options.memoryStore.searchScheduleEntries({
    profileName: context.profile.name,
    source: context.event.source,
    query: targetQuery,
    limit: 5
  });
  if (matches.length !== 1) {
    return {
      ok: true,
      replyText:
        matches.length === 0
          ? "找不到符合的服事項目，請補上日期、聚會或家族。"
          : [
              "找到多筆符合的服事，請補上日期：",
              ...matches.map((entry) => `- ${formatEntryInput(entry)}`)
            ].join("\n")
    };
  }
  const current = matches[0];

  if (args.operation === "update_entry") {
    if (!args.changes || Object.keys(args.changes).length === 0) {
      return { ok: true, replyText: "請告訴我要把這筆服事改成什麼。" };
    }
    const updated = { ...current, ...args.changes };
    if (!args.confirm) {
      await storeMutationConfirmation(input);
      return mutationPreview(
        [
          "請確認這項修改：",
          `修改前：${formatEntryInput(current)}`,
          `修改後：${formatEntryInput(updated)}`,
          "要套用嗎？"
        ],
        "保存"
      );
    }
    const result = await options.memoryStore.updateScheduleEntry({
      profileName: context.profile.name,
      entryId: current.id,
      changes: args.changes
    });
    return { ok: true, replyText: result ? "已更新這筆服事。" : "服事項目已變更，請重新查詢。" };
  }

  if (args.operation === "delete_entry") {
    if (!args.confirm) {
      await storeMutationConfirmation(input);
      return mutationPreview(
        ["請確認要刪除這筆服事：", formatEntryInput(current), "要刪除嗎？"],
        "刪除"
      );
    }
    const removed = await options.memoryStore.deleteScheduleEntry({
      profileName: context.profile.name,
      entryId: current.id
    });
    return { ok: true, replyText: removed ? "已刪除這筆服事。" : "服事項目已變更，請重新查詢。" };
  }

  return { ok: true, replyText: "目前不支援這項服事表操作。" };
}

async function storeMutationConfirmation(input: {
  args: SaveScheduleMemoryArguments;
  context: FunctionHandlerContext;
  options: ScheduleMemoryFunctionOptions;
  now: Date;
  action: FunctionName;
  requestIdFactory: () => string;
}): Promise<void> {
  if (!input.options.sessionStore) {
    return;
  }
  await storePendingFunctionQuery({
    sessionStore: input.options.sessionStore,
    requestId: input.requestIdFactory(),
    action: input.action,
    arguments: { ...input.args, confirm: true },
    context: input.context,
    now: input.now
  });
}

function mutationPreview(lines: string[], confirmLabel: string): FunctionExecutionResult {
  return {
    ok: true,
    replyText: lines.join("\n"),
    quickReplies: [
      {
        label: confirmLabel,
        action: { type: "message", label: confirmLabel, text: confirmLabel }
      },
      { label: "取消", action: { type: "message", label: "取消", text: "取消" } }
    ]
  };
}

function formatEntryInput(entry: AgentScheduleEntryInput): string {
  return `${formatMonthDay(entry.serviceDate)} ${entry.meetingName}：${entry.assignee}${entry.notes ? `（${entry.notes}）` : ""}`;
}

export function createSaveScheduleHandler(options: ScheduleMemoryFunctionOptions): FunctionHandler {
  return createSaveScheduleMemoryHandler({ ...options, action: "save_schedule" });
}

export function createQueryScheduleMemoryHandler(
  options: ScheduleMemoryFunctionOptions
): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const timeZone = readTimeZone(options.timeZone, "timeZone");
  return async (rawArgs, context) => {
    const args = queryScheduleMemoryArgumentsSchema.parse(rawArgs);
    const query = args.query.trim();
    const inferredType = args.scheduleType ?? inferScheduleTypeFromQuery(query);
    const date = inferQueryDate(args, now());
    const cleanedQuery = cleanScheduleMemoryQuery(query);
    let entries = await options.memoryStore.searchScheduleEntries({
      profileName: context.profile.name,
      source: context.event.source,
      requesterUserId: context.event.source.userId,
      memoryId: scheduleMemoryId(context.activeTask?.references),
      scheduleType: inferredType,
      date,
      meetingName: args.meeting,
      role: args.role,
      query: args.participant ?? cleanedQuery,
      limit: 50
    });

    if (args.month) {
      entries = entries.filter((entry) => entry.serviceDate.startsWith(`${args.month}-`));
    }

    entries = applyScheduleDateIntent(
      entries,
      args,
      now(),
      scheduleAdvanceDate(args, context.activeTask?.anchors),
      context.profile.schedulePolicy?.meetingWindows,
      timeZone
    );
    const roleResolution = resolveScheduleResultRows(entries, args.role);
    entries =
      roleResolution.status === "ambiguous"
        ? roleResolution.rows
        : roleResolution.rows.slice(0, args.limit ?? 10);

    if (entries.length === 0) {
      const replyText = "我找不到符合的服事記憶。";
      return {
        ok: true,
        replyText,
        agentResult: scheduleResultEnvelope([], { replyText, role: args.role })
      };
    }

    const replyText = args.role
      ? formatFocusedMemoryRoleReply(entries, args.role)
      : ["我找到這些服事記憶：", ...entries.map(formatScheduleEntry)].join("\n");
    const agentResult = scheduleResultEnvelope(
      entries.map((entry) => ({
        date: entry.serviceDate,
        meeting: entry.meetingName,
        role: entry.role,
        assignee: entry.assignee,
        familyName: entry.familyName
      })),
      { replyText, role: args.role }
    );
    const memoryIds = [...new Set(entries.map((entry) => entry.memoryId))];
    return {
      ok: true,
      replyText: agentResult.replyText,
      agentResult: {
        ...agentResult,
        anchors: {
          ...agentResult.anchors,
          scheduleType: entries[0].scheduleType,
          ...(memoryIds.length === 1 ? { memoryId: memoryIds[0] } : {})
        },
        ...(memoryIds.length === 1
          ? {
              evidence: [{ kind: "schedule_memory", reference: { memoryId: memoryIds[0] } }]
            }
          : {})
      }
    };
  };
}

function formatFocusedMemoryRoleReply(
  entries: AgentScheduleEntryRecord[],
  requestedRole: string
): string {
  const role = entries.find((entry) => entry.role?.trim())?.role?.trim() || requestedRole;
  const assignees = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.assignee
          .split(/[,，、]/u)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    )
  );
  return `${role}：${assignees.join("、") || "未填人員"}`;
}

function scheduleMemoryId(references: unknown): string | undefined {
  if (!references || typeof references !== "object") return undefined;
  const record = references as Record<string, unknown>;
  return record.kind === "schedule_memory" && typeof record.memoryId === "string"
    ? record.memoryId
    : undefined;
}

function parseScheduleLine(
  line: string,
  scheduleType: AgentScheduleType,
  now: Date
): AgentScheduleEntryInput | undefined {
  const normalized = line.normalize("NFKC").trim();
  const match = normalized.match(
    /(?<month>\d{1,2}|[一二三四五六七八九十兩]{1,3})\s*[/／]\s*(?<day>\d{1,2})\s*(?<weekday>[一二三四五六日天])?\s*(?<rest>.+)$/u
  );
  if (!match?.groups) {
    return undefined;
  }

  const month = parseMonth(match.groups.month);
  const day = Number(match.groups.day);
  const rest = cleanupScheduleAssignee(match.groups.rest);
  if (!month || !day || !rest) {
    return undefined;
  }

  const serviceDate = buildDateKey(now, month, day);
  const weekday = normalizeWeekday(match.groups.weekday);

  if (scheduleType === "street_sign_service") {
    const { assignee, notes } = splitNotes(rest);
    if (!assignee) {
      return undefined;
    }
    return {
      serviceDate,
      weekday,
      meetingName: "為耶穌舉牌",
      role: "服事家族",
      assignee,
      familyName: assignee,
      notes
    };
  }

  if (scheduleType === "morning_prayer_family") {
    const meetingName = rest.includes("仙履奇緣") ? "仙履奇緣" : "晨更";
    return {
      serviceDate,
      weekday,
      meetingName,
      role: "帶領家族",
      assignee: rest,
      familyName: rest
    };
  }

  return {
    serviceDate,
    weekday,
    meetingName: inferCustomMeetingName(rest),
    assignee: rest
  };
}

function inferScheduleType(content: string): AgentScheduleType {
  if (/舉牌|為耶穌/u.test(content)) {
    return "street_sign_service";
  }
  if (/晨更|仙履奇緣|家族|家園/u.test(content)) {
    return "morning_prayer_family";
  }
  return "custom_service_schedule";
}

function inferScheduleTypeFromQuery(query: string): AgentScheduleType | undefined {
  if (/舉牌|為耶穌/u.test(query)) {
    return "street_sign_service";
  }
  if (/晨更|仙履奇緣/u.test(query)) {
    return "morning_prayer_family";
  }
  return undefined;
}

function defaultScheduleTitle(scheduleType: AgentScheduleType): string {
  switch (scheduleType) {
    case "morning_prayer_family":
      return "晨更家族服事表";
    case "street_sign_service":
      return "為耶穌舉牌服事表";
    default:
      return "服事表";
  }
}

function scheduleTypeLabel(scheduleType: AgentScheduleType): string {
  switch (scheduleType) {
    case "morning_prayer_family":
      return "晨更家族服事";
    case "street_sign_service":
      return "舉牌服事";
    default:
      return "服事";
  }
}

function scheduleMemoryContent(args: SaveScheduleMemoryArguments): string {
  return (args.content || args.query || "").trim();
}

function formatSchedulePreview(parsed: ParsedScheduleMemory, replacingTitle?: string): string {
  const sample = parsed.entries
    .slice(0, 3)
    .map(
      (entry) => `- ${formatMonthDay(entry.serviceDate)} ${entry.meetingName}：${entry.assignee}`
    );
  return [
    `我整理到 ${parsed.entries.length} 筆${scheduleTypeLabel(parsed.scheduleType)}。`,
    ...sample,
    replacingTitle ? `這將取代現有的「${replacingTitle}」。` : undefined,
    "要保存嗎？"
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatScheduleEntry(entry: AgentScheduleEntryRecord): string {
  const notes = entry.notes ? `（${entry.notes}）` : "";
  return `- ${formatMonthDay(entry.serviceDate)} ${entry.meetingName}：${entry.assignee}${notes}`;
}

function inferQueryDate(args: QueryScheduleMemoryArguments, now: Date): string | undefined {
  if (args.dateIntent === "specific_date") {
    return args.specificDate ?? args.date;
  }
  if (args.date) {
    return args.date;
  }
  switch (args.dateIntent) {
    case "today":
      return addDaysToDateKey(toDateKey(now), 0);
    case "tomorrow":
      return addDaysToDateKey(toDateKey(now), 1);
    default:
      break;
  }

  const match = args.query.match(
    /(?<month>\d{1,2}|[一二三四五六七八九十兩]{1,3})\s*[/／月]\s*(?<day>\d{1,2})/u
  );
  if (!match?.groups) {
    return undefined;
  }
  const month = parseMonth(match.groups.month);
  const day = Number(match.groups.day);
  return month && day ? buildDateKey(now, month, day) : undefined;
}

function cleanScheduleMemoryQuery(query: string): string {
  return query
    .normalize("NFKC")
    .replace(/小哈/g, " ")
    .replace(
      /幫我|請|查|找|看|給我|一下|記住的|服事表|服事|下一次|下次|下一場|下場|最近一場|什麼時候|哪時候|何時|晨更|仙履奇緣|為耶穌|舉牌|那|呢|是/g,
      " "
    )
    .replace(/(?:\d{1,2}|[一二三四五六七八九十兩]{1,3})\s*[/／月]\s*\d{1,2}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyScheduleDateIntent(
  entries: AgentScheduleEntryRecord[],
  args: QueryScheduleMemoryArguments,
  now: Date,
  afterDate?: string,
  meetingWindows?: MeetingWindowRule[],
  timeZone = "UTC"
): AgentScheduleEntryRecord[] {
  const today = toDateKey(now);
  switch (args.dateIntent) {
    case "next_meeting": {
      const candidates = entries
        .filter((entry) => !afterDate || entry.serviceDate > afterDate)
        .map((entry) => ({
          serviceDate: entry.serviceDate,
          meeting: entry.meetingName,
          entry
        }));
      return selectFirstUpcomingOccurrence({
        rows: candidates,
        now,
        timeZone,
        meetingWindows
      }).map(({ entry }) => entry);
    }
    case "upcoming":
      return entries.filter((entry) => entry.serviceDate >= today);
    case "this_week": {
      const end = addDaysToDateKey(today, 7);
      return entries.filter((entry) => entry.serviceDate >= today && entry.serviceDate < end);
    }
    case "day_after_tomorrow": {
      const target = addDaysToDateKey(today, 2);
      return entries.filter((entry) => entry.serviceDate === target);
    }
    default:
      return entries;
  }
}

function scheduleAdvanceDate(
  args: QueryScheduleMemoryArguments,
  activeTaskAnchors: unknown
): string | undefined {
  if (
    args.dateIntent !== "next_meeting" ||
    !/(?:下一場|下場|下一次|下次)/u.test(args.query) ||
    !activeTaskAnchors ||
    typeof activeTaskAnchors !== "object"
  ) {
    return undefined;
  }
  const record = activeTaskAnchors as Record<string, unknown>;
  const date = typeof record.date === "string" ? record.date : record.specificDate;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : undefined;
}

function isConfirmText(value: string | undefined): boolean {
  return /^(保存|確認|確定|好|可以|存)$/u.test(value?.trim() ?? "");
}

function isCancelText(value: string | undefined): boolean {
  return /^(取消|不要|先不要|不用)$/u.test(value?.trim() ?? "");
}

function cleanupScheduleAssignee(value: string): string {
  return value
    .replace(/^[✅✔☑🔆👉\s]+/u, "")
    .replace(/[。；;，,]+$/u, "")
    .trim();
}

function splitNotes(value: string): { assignee: string; notes?: string } {
  const notes = Array.from(value.matchAll(/[（(]([^()（）]+)[）)]/gu))
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .join("、");
  const assignee = value.replace(/[（(][^()（）]+[）)]/gu, "").trim();
  return { assignee, notes: notes || undefined };
}

function inferCustomMeetingName(value: string): string {
  return value.includes("：") ? value.split("：")[0]?.trim() || "服事" : "服事";
}

function parseMonth(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const month = Number(value);
    return month >= 1 && month <= 12 ? month : undefined;
  }
  const normalized = value.replace("兩", "二");
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12
  };
  return map[normalized];
}

function normalizeWeekday(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value === "天" ? "日" : value;
}

function buildDateKey(now: Date, month: number, day: number): string {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const year = month < currentMonth - 6 ? currentYear + 1 : currentYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function formatMonthDay(dateKey: string): string {
  const match = dateKey.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : dateKey;
}

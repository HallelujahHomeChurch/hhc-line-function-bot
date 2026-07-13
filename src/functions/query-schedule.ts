import {
  queryScheduleArgumentsSchema,
  type QueryScheduleArguments,
  type QueryServiceScheduleArguments
} from "../function-arguments.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandler,
  NotionDatabaseClient,
  QuickReplyItem
} from "../types.js";
import type { SessionStore } from "../state/session-store.js";
import type { ScheduleStore } from "../schedules/store.js";
import { createQueryScheduleMemoryHandler } from "./schedule-memory.js";
import {
  createQueryServiceScheduleHandler,
  deriveFilters,
  formatServiceScheduleReply,
  type ServiceRow
} from "./query-service-schedule.js";
import { readTimeZone } from "../time-zone.js";
import {
  extractScheduleRoleFocus,
  isScheduleAdvanceFollowUp,
  MEDIA_TEAM_SCHEDULE_SOURCE_KEYS,
  refineScheduleQuery
} from "./schedule-query-refinement.js";
import { resolveScheduleResultRows, scheduleResultEnvelope } from "./schedule-result.js";

export interface QueryScheduleFunctionOptions {
  memoryStore: AgentMemoryStore;
  scheduleStore?: ScheduleStore;
  notion?: NotionDatabaseClient;
  databaseId?: string;
  properties?: {
    date: string;
    meeting: string;
    role: string;
    person: string;
  };
  timeZone?: string;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

export function createQueryScheduleHandler(options: QueryScheduleFunctionOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const timeZone = readTimeZone(options.timeZone, "timeZone");
  const memoryHandler = createQueryScheduleMemoryHandler({
    memoryStore: options.memoryStore,
    now
  });
  const serviceHandler =
    options.notion && options.databaseId && options.properties
      ? createQueryServiceScheduleHandler({
          notion: options.notion,
          databaseId: options.databaseId,
          properties: options.properties,
          timeZone: options.timeZone,
          sessionStore: options.sessionStore,
          now,
          requestIdFactory: options.requestIdFactory
        })
      : undefined;

  return async (rawArgs, context) => {
    const args = queryScheduleArgumentsSchema.parse(rawArgs);
    if (isScheduleListRequest(args.query)) {
      const schedules = await options.memoryStore.listScheduleMemories({
        profileName: context.profile.name,
        limit: args.limit ?? 10
      });
      return {
        ok: true,
        replyText:
          schedules.length === 0
            ? "目前沒有保存的服事表。"
            : ["目前保存的服事表：", ...schedules.map((schedule) => `- ${schedule.title}`)].join(
                "\n"
              )
      };
    }
    const refinement = refineScheduleQuery(args, now(), timeZone);
    const roleFocus = extractScheduleRoleFocus({
      query: args.query,
      hasContinuation: context.continuation?.functionName === "query_schedule",
      availableRoles: continuationRoles(context.continuation?.arguments),
      now: now(),
      timeZone
    });
    const refinedArgs = queryScheduleArgumentsSchema.parse({
      ...args,
      ...refinement.structuredArguments,
      ...(roleFocus ? { role: roleFocus } : {}),
      query: roleFocus ? "" : refinement.residualQuery
    });
    const memorySpecific = Boolean(refinedArgs.scheduleType) || isMemorySpecificRequest(args.query);
    const continuationSourceKeys = scheduleReadModelSourceKeys(
      context.continuation?.resultReferences
    );
    const afterDate = scheduleAdvanceDate(args, context.continuation?.arguments);
    const results = [];

    if (memorySpecific || (!serviceHandler && !options.scheduleStore)) {
      results.push(await memoryHandler(refinedArgs, context));
    } else {
      if (refinement.structuredArguments.scheduleCategory !== "media_team") {
        const memory = await memoryHandler(refinedArgs, context);
        results.push(memory);
      }
      const readModel = options.scheduleStore
        ? await queryScheduleReadModel({
            scheduleStore: options.scheduleStore,
            args: refinedArgs,
            profileName: context.profile.name,
            now: now(),
            timeZone,
            afterDate,
            availableRoles: continuationRoles(context.continuation?.arguments),
            sourceKeys:
              refinement.structuredArguments.scheduleCategory === "media_team"
                ? [...MEDIA_TEAM_SCHEDULE_SOURCE_KEYS]
                : continuationSourceKeys
          })
        : undefined;
      if (readModel && !isNoScheduleResult(readModel.replyText)) {
        results.push(readModel);
      } else if (serviceHandler) {
        results.push(await serviceHandler(refinedArgs, context));
      } else if (readModel) {
        results.push(readModel);
      }
    }

    const found = results.filter((result) => !isNoScheduleResult(result.replyText));
    if (found.length === 0) {
      const replyText = "查不到符合的服事表。";
      const quickReplies: QuickReplyItem[] = [
        { label: "下一場", action: { type: "message", label: "下一場", text: "下一場服事" } },
        { label: "本週", action: { type: "message", label: "本週", text: "本週服事" } },
        { label: "主日", action: { type: "message", label: "主日", text: "主日服事" } }
      ];
      return {
        ok: true,
        replyText,
        quickReplies,
        agentResult: scheduleResultEnvelope([], {
          replyText,
          role: refinedArgs.role,
          quickReplies
        })
      };
    }
    if (found.length === 1) {
      return found[0];
    }
    return {
      ok: true,
      replyText: ["我找到這些服事安排：", ...found.map((result) => result.replyText)].join("\n\n")
    };
  };
}

function continuationRoles(arguments_: unknown): string[] | undefined {
  if (!arguments_ || typeof arguments_ !== "object") return undefined;
  const roles = (arguments_ as Record<string, unknown>).availableRoles;
  return Array.isArray(roles) && roles.every((role) => typeof role === "string")
    ? roles
    : undefined;
}

function scheduleReadModelSourceKeys(references: unknown): string[] | undefined {
  if (!references || typeof references !== "object") return undefined;
  const record = references as Record<string, unknown>;
  if (record.kind !== "schedule_read_model" || !Array.isArray(record.sourceKeys)) return undefined;
  const sourceKeys = record.sourceKeys.filter(
    (value): value is string => typeof value === "string"
  );
  return sourceKeys.length > 0 ? sourceKeys : undefined;
}

function isScheduleListRequest(query: string): boolean {
  return /(?:有|已)?(?:存|保存|記住).*(?:哪些|什麼|清單|列表)|有哪些.*服事表/u.test(query);
}

function isMemorySpecificRequest(query: string): boolean {
  return /舉牌|為耶穌|晨更家族|家族晨更|仙履奇緣|家族|家園/u.test(query);
}

function isNoScheduleResult(replyText: string): boolean {
  return /^(?:我找不到符合的服事記憶。|查不到符合的服事表。)$/u.test(replyText.trim());
}

async function queryScheduleReadModel(input: {
  scheduleStore: ScheduleStore;
  args: QueryScheduleArguments;
  profileName: string;
  now: Date;
  timeZone: string;
  afterDate?: string;
  availableRoles?: string[];
  sourceKeys?: string[];
}): Promise<Awaited<ReturnType<FunctionHandler>>> {
  const serviceArgs = input.args as QueryServiceScheduleArguments;
  const filters = deriveFilters(serviceArgs, input.now, input.timeZone);
  const rows = await input.scheduleStore.searchItems({
    profileName: input.profileName,
    sourceKeys: input.sourceKeys,
    query: input.args.query || undefined,
    serviceDate: filters.date,
    meeting: filters.meeting,
    role: filters.role,
    range: input.afterDate
      ? { start: nextDateKey(input.afterDate), endExclusive: "9999-12-31" }
      : filters.range,
    limit:
      filters.role || filters.nextMeetingOnly
        ? Math.max(filters.limit ?? 10, 50)
        : (filters.limit ?? 10)
  });
  const meetingRows = filters.nextMeetingOnly
    ? limitToFirstReadModelGroup(rows, input.now, input.timeZone)
    : rows;
  const roleResolution = resolveScheduleResultRows(meetingRows, filters.role);
  const limitedRows =
    filters.nextMeetingOnly || roleResolution.status === "ambiguous"
      ? roleResolution.rows
      : roleResolution.rows.slice(0, filters.limit ?? 10);
  const limited = limitedRows.map(scheduleItemToServiceRow);

  if (limited.length === 0) {
    const replyText = "查不到符合的服事表。";
    return {
      ok: true,
      replyText,
      agentResult: scheduleResultEnvelope([], { replyText, role: filters.role })
    };
  }
  const replyText = formatServiceScheduleReply(limited, serviceArgs, filters);
  const agentResult = scheduleResultEnvelope(
    limitedRows.map((row) => ({
      date: row.serviceDate,
      meeting: row.meeting,
      role: row.role,
      sourceKey: row.sourceKey
    })),
    { replyText, role: filters.role, sourceKeys: input.sourceKeys }
  );
  return {
    ok: true,
    continuation: readModelContinuation(limitedRows, filters.role, input.availableRoles),
    replyText: agentResult.replyText,
    agentResult
  };
}

function scheduleAdvanceDate(
  args: QueryScheduleArguments,
  continuationArguments: unknown
): string | undefined {
  if (
    args.dateIntent !== "next_meeting" ||
    !isScheduleAdvanceFollowUp(args.query) ||
    !continuationArguments ||
    typeof continuationArguments !== "object"
  ) {
    return undefined;
  }
  const record = continuationArguments as Record<string, unknown>;
  const date = typeof record.date === "string" ? record.date : record.specificDate;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : undefined;
}

function nextDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function readModelContinuation(
  rows: Array<{ sourceKey: string; serviceDate: string; meeting: string; role: string }>,
  role?: string,
  previousRoles: string[] = []
): FunctionExecutionResult["continuation"] | undefined {
  const sourceKeys = Array.from(new Set(rows.map((row) => row.sourceKey)));
  const dates = Array.from(new Set(rows.map((row) => row.serviceDate)));
  const meetings = Array.from(new Set(rows.map((row) => row.meeting)));
  if (sourceKeys.length !== 1 || dates.length !== 1 || meetings.length !== 1) return undefined;
  return {
    arguments: {
      date: dates[0],
      meeting: meetings[0],
      availableRoles: Array.from(
        new Set([...previousRoles, ...rows.map((row) => row.role).filter(Boolean)])
      ),
      ...(role ? { role } : {})
    },
    resultReferences: { kind: "schedule_read_model", sourceKeys }
  };
}

function scheduleItemToServiceRow(item: {
  serviceDate: string;
  meeting: string;
  role: string;
  assignee: string;
}): ServiceRow {
  return {
    date: item.serviceDate,
    meeting: item.meeting,
    role: item.role,
    person: item.assignee
  };
}

function limitToFirstReadModelGroup<T extends { serviceDate: string }>(
  rows: T[],
  now: Date,
  timeZone: string
): T[] {
  const firstFutureDate = rows
    .map((row) => row.serviceDate)
    .filter((date) => date >= toDateKey(now, timeZone))
    .sort()[0];
  return firstFutureDate ? rows.filter((row) => row.serviceDate === firstFutureDate) : [];
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

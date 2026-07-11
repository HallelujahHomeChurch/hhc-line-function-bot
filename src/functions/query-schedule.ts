import {
  queryScheduleArgumentsSchema,
  type QueryScheduleArguments,
  type QueryServiceScheduleArguments
} from "../function-arguments.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type { FunctionHandler, NotionDatabaseClient } from "../types.js";
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
    const memorySpecific = Boolean(args.scheduleType) || isMemorySpecificRequest(args.query);
    const results = [];

    if (memorySpecific || (!serviceHandler && !options.scheduleStore)) {
      results.push(await memoryHandler(args, context));
    } else {
      const memory = await memoryHandler(args, context);
      results.push(memory);
      const readModel = options.scheduleStore
        ? await queryScheduleReadModel({
            scheduleStore: options.scheduleStore,
            args,
            profileName: context.profile.name,
            now: now(),
            timeZone
          })
        : undefined;
      if (readModel && !isNoScheduleResult(readModel.replyText)) {
        results.push(readModel);
      } else if (serviceHandler) {
        results.push(await serviceHandler(args, context));
      } else if (readModel) {
        results.push(readModel);
      }
    }

    const found = results.filter((result) => !isNoScheduleResult(result.replyText));
    if (found.length === 0) {
      return {
        ok: true,
        replyText: "查不到符合的服事表。",
        quickReplies: [
          { label: "下一場", action: { type: "message", label: "下一場", text: "下一場服事" } },
          { label: "本週", action: { type: "message", label: "本週", text: "本週服事" } },
          { label: "主日", action: { type: "message", label: "主日", text: "主日服事" } }
        ]
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
}): Promise<Awaited<ReturnType<FunctionHandler>>> {
  const serviceArgs = input.args as QueryServiceScheduleArguments;
  const filters = deriveFilters(serviceArgs, input.now, input.timeZone);
  const rows = await input.scheduleStore.searchItems({
    profileName: input.profileName,
    query: input.args.query,
    serviceDate: filters.date,
    meeting: filters.meeting,
    role: filters.role,
    range: filters.range,
    limit: filters.limit ?? 10
  });
  const limited = filters.nextMeetingOnly
    ? limitToFirstReadModelGroup(rows.map(scheduleItemToServiceRow), input.now, input.timeZone)
    : rows.map(scheduleItemToServiceRow);

  if (limited.length === 0) {
    return { ok: true, replyText: "查不到符合的服事表。" };
  }
  return {
    ok: true,
    replyText: formatServiceScheduleReply(limited, serviceArgs, filters)
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

function limitToFirstReadModelGroup(rows: ServiceRow[], now: Date, timeZone: string): ServiceRow[] {
  const firstFutureDate = rows
    .map((row) => row.date)
    .filter((date) => date >= toDateKey(now, timeZone))
    .sort()[0];
  return firstFutureDate ? rows.filter((row) => row.date === firstFutureDate) : [];
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

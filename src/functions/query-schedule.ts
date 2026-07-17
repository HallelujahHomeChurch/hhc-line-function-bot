import { randomUUID } from "node:crypto";

import {
  queryScheduleArgumentsSchema,
  type QueryScheduleArguments,
  type QueryServiceScheduleArguments
} from "../function-arguments.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type {
  FunctionHandler,
  FunctionHandlerContext,
  FunctionExecutionResult,
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
import {
  aggregateScheduleResultEnvelopes,
  resolveScheduleResultRows,
  scheduleResultEnvelope
} from "./schedule-result.js";
import { selectFirstUpcomingOccurrence } from "../schedules/occurrence-policy.js";
import type { MeetingWindowRule } from "../types.js";
import {
  resolveScheduleDomain,
  scheduleDomainChoices,
  SCHEDULE_DOMAIN_KEYS
} from "./schedule-resolver.js";
import { storePendingResolution } from "./pending-resolution.js";

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
    now,
    timeZone
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
          requestIdFactory: options.requestIdFactory,
          sourceKeys: [...MEDIA_TEAM_SCHEDULE_SOURCE_KEYS]
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
      hasContinuation: context.activeTask?.capability === "query_schedule",
      availableRoles: activeTaskRoles(context.activeTask),
      now: now(),
      timeZone
    });
    const refinedArgs = queryScheduleArgumentsSchema.parse({
      ...args,
      ...refinement.structuredArguments,
      ...(roleFocus ? { role: roleFocus } : {}),
      query: roleFocus ? "" : refinement.residualQuery
    });
    const resolution =
      refinedArgs.scheduleType && refinedArgs.scheduleType !== "morning_prayer_family"
        ? ({ status: "not_found" } as const)
        : resolveScheduleDomain({
            text: args.query,
            requestedDomainKey: refinedArgs.domainKey,
            activeDomainKey: activeTaskDomainKey(context.activeTask?.anchors)
          });
    const selectedDomain =
      resolution.status === "selected" ? resolution.candidate.domainKey : undefined;
    const ambiguousDomains = resolution.status === "ambiguous";
    const memorySpecific =
      selectedDomain === SCHEDULE_DOMAIN_KEYS.family ||
      Boolean(refinedArgs.scheduleType) ||
      isMemorySpecificRequest(args.query);
    const afterDate = scheduleAdvanceDate(args, context.activeTask?.anchors);
    const results: Array<{ domainKey: string; result: FunctionExecutionResult }> = [];
    const familyArgs = queryScheduleArgumentsSchema.parse({
      ...refinedArgs,
      scheduleType: "morning_prayer_family",
      domainKey: SCHEDULE_DOMAIN_KEYS.family
    });
    const mediaArgs = queryScheduleArgumentsSchema.parse({
      ...refinedArgs,
      scheduleType: undefined,
      domainKey: SCHEDULE_DOMAIN_KEYS.media
    });
    const includeFamily =
      selectedDomain === SCHEDULE_DOMAIN_KEYS.family ||
      ambiguousDomains ||
      (!selectedDomain && refinement.structuredArguments.scheduleCategory !== "media_team");
    const includeMedia =
      selectedDomain === SCHEDULE_DOMAIN_KEYS.media ||
      ambiguousDomains ||
      (!selectedDomain && !memorySpecific);

    if (includeFamily) {
      const memoryArgs =
        selectedDomain === SCHEDULE_DOMAIN_KEYS.family || ambiguousDomains
          ? familyArgs
          : refinedArgs;
      const memoryResult = await memoryHandler(memoryArgs, context);
      const memoryDomainKey =
        selectedDomain === SCHEDULE_DOMAIN_KEYS.family ||
        ambiguousDomains ||
        memoryResult.agentResult?.anchors?.scheduleType === "morning_prayer_family"
          ? SCHEDULE_DOMAIN_KEYS.family
          : "saved_schedule";
      results.push({
        domainKey: memoryDomainKey,
        result:
          memoryDomainKey === SCHEDULE_DOMAIN_KEYS.family
            ? withScheduleDomain(memoryResult, SCHEDULE_DOMAIN_KEYS.family)
            : memoryResult
      });
    }
    if (includeMedia) {
      const readModel = options.scheduleStore
        ? await queryScheduleReadModel({
            scheduleStore: options.scheduleStore,
            args: mediaArgs,
            profileName: context.profile.name,
            now: now(),
            timeZone,
            afterDate,
            availableRoles: activeTaskRoles(context.activeTask),
            sourceKeys: [...MEDIA_TEAM_SCHEDULE_SOURCE_KEYS],
            meetingWindows: context.profile.schedulePolicy?.meetingWindows
          })
        : undefined;
      if (readModel && !isNoScheduleResult(readModel.replyText)) {
        results.push({
          domainKey: SCHEDULE_DOMAIN_KEYS.media,
          result: withScheduleDomain(readModel, SCHEDULE_DOMAIN_KEYS.media)
        });
      } else if (serviceHandler) {
        results.push({
          domainKey: SCHEDULE_DOMAIN_KEYS.media,
          result: withScheduleDomain(
            await serviceHandler(mediaArgs, context),
            SCHEDULE_DOMAIN_KEYS.media
          )
        });
      } else if (readModel) {
        results.push({
          domainKey: SCHEDULE_DOMAIN_KEYS.media,
          result: withScheduleDomain(readModel, SCHEDULE_DOMAIN_KEYS.media)
        });
      }
    }

    const found = results.filter(({ result }) => !isNoScheduleResult(result.replyText));
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
    const foundDomainKeys = new Set(found.map(({ domainKey }) => domainKey));
    const unresolvedGenericDomain =
      resolution.status === "not_found" &&
      !memorySpecific &&
      refinedArgs.dateIntent === "next_meeting" &&
      !isExplicitAllScheduleDomainsRequest(args.query);
    if ((ambiguousDomains || unresolvedGenericDomain) && foundDomainKeys.size > 1) {
      const candidates = (
        resolution.status === "ambiguous" ? resolution.candidates : scheduleDomainChoices()
      ).filter((candidate) => foundDomainKeys.has(candidate.domainKey));
      await storePendingResolution({
        sessionStore: options.sessionStore,
        requestId: options.requestIdFactory?.() ?? context.requestId ?? randomUUID(),
        capability: "query_schedule",
        groundedArguments: refinedArgs,
        candidates,
        context,
        now: now()
      });
      const replyText = `你要查哪一類服事：${candidates.map((item) => item.displayName).join("、")}？`;
      return {
        ok: true,
        replyText,
        quickReplies: candidates.map((item) => ({
          label: item.displayName,
          action: { type: "message", label: item.displayName, text: item.displayName }
        })),
        agentResult: {
          status: "ambiguous",
          replyText,
          clarification: { prompt: replyText, choices: candidates.map((item) => item.displayName) }
        }
      };
    }
    if (found.length === 1) {
      return found[0].result;
    }
    const replyText = ["我找到這些服事安排：", ...found.map(({ result }) => result.replyText)].join(
      "\n\n"
    );
    const agentResult = aggregateScheduleResultEnvelopes(
      found.flatMap(({ result }) => (result.agentResult ? [result.agentResult] : [])),
      { replyText, role: refinedArgs.role }
    );
    return {
      ok: true,
      replyText: agentResult.replyText,
      agentResult
    };
  };
}

function activeTaskDomainKey(anchors: unknown): string | undefined {
  if (!anchors || typeof anchors !== "object") return undefined;
  const domainKey = (anchors as Record<string, unknown>).domainKey;
  return typeof domainKey === "string" ? domainKey : undefined;
}

function withScheduleDomain(
  result: FunctionExecutionResult,
  domainKey: string
): FunctionExecutionResult {
  if (!result.agentResult) return result;
  return {
    ...result,
    agentResult: {
      ...result.agentResult,
      anchors: { ...result.agentResult.anchors, domainKey }
    }
  };
}

function activeTaskRoles(activeTask: FunctionHandlerContext["activeTask"]): string[] | undefined {
  const roles = activeTask?.entities
    .filter((entity) => entity.type === "role")
    .map((entity) => entity.label);
  return roles?.length ? roles : undefined;
}

function isScheduleListRequest(query: string): boolean {
  return /(?:有|已)?(?:存|保存|記住).*(?:哪些|什麼|清單|列表)|有哪些.*服事表/u.test(query);
}

function isMemorySpecificRequest(query: string): boolean {
  return /舉牌|為耶穌|晨更家族|家族晨更|仙履奇緣|家族|家園/u.test(query);
}

function isExplicitAllScheduleDomainsRequest(query: string): boolean {
  return /(?:所有|全部|各類|每一類|跨類型).*(?:服事|服事表)|(?:服事|服事表).*(?:所有|全部|各類|每一類|跨類型)/u.test(
    query.normalize("NFKC")
  );
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
  meetingWindows?: MeetingWindowRule[];
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
      : input.args.month
        ? monthRange(input.args.month)
        : filters.range,
    limit:
      filters.role || filters.nextMeetingOnly
        ? Math.max(filters.limit ?? 10, 50)
        : (filters.limit ?? 10)
  });
  const meetingRows = filters.nextMeetingOnly
    ? limitToFirstReadModelGroup(rows, input.now, input.timeZone, input.meetingWindows)
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
      assignee: row.assignee,
      sourceKey: row.sourceKey
    })),
    { replyText, role: filters.role, sourceKeys: input.sourceKeys }
  );
  return {
    ok: true,
    replyText: agentResult.replyText,
    agentResult
  };
}

function monthRange(month: string): { start: string; endExclusive: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return {
    start: `${month}-01`,
    endExclusive: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`
  };
}

function scheduleAdvanceDate(
  args: QueryScheduleArguments,
  activeTaskAnchors: unknown
): string | undefined {
  if (
    args.dateIntent !== "next_meeting" ||
    !isScheduleAdvanceFollowUp(args.query) ||
    !activeTaskAnchors ||
    typeof activeTaskAnchors !== "object"
  ) {
    return undefined;
  }
  const record = activeTaskAnchors as Record<string, unknown>;
  const date = typeof record.date === "string" ? record.date : record.specificDate;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : undefined;
}

function nextDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

function limitToFirstReadModelGroup<T extends { serviceDate: string; meeting: string }>(
  rows: T[],
  now: Date,
  timeZone: string,
  meetingWindows?: MeetingWindowRule[]
): T[] {
  return selectFirstUpcomingOccurrence({ rows, now, timeZone, meetingWindows });
}

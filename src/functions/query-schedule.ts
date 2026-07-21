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
  refineScheduleQuery
} from "./schedule-query-refinement.js";
import {
  aggregateScheduleResultEnvelopes,
  resolveScheduleResultRows,
  scheduleResultEnvelope
} from "./schedule-result.js";
import { selectFirstUpcomingOccurrence } from "../schedules/occurrence-policy.js";
import type { MeetingWindowRule } from "../types.js";
import { resolveScheduleDomain, scheduleDomainChoices } from "./schedule-resolver.js";
import type { ScheduleDomainConfig } from "../types.js";
import { DEFAULT_SCHEDULE_DOMAINS } from "../schedules/domain-registry.js";
import { storePendingResolution } from "./pending-resolution.js";

const DEFAULT_MEDIA_SOURCE_KEYS = (() => {
  const binding = DEFAULT_SCHEDULE_DOMAINS.find(({ key }) => key === "media_team_service")?.binding;
  return binding?.kind === "canonical" ? binding.sourceKeys : ["media_team_service_schedule"];
})();

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

async function queryScheduleDomain(input: {
  domain: ScheduleDomainConfig;
  args: QueryScheduleArguments;
  context: FunctionHandlerContext;
  options: QueryScheduleFunctionOptions;
  memoryHandler: FunctionHandler;
  serviceHandler?: FunctionHandler;
  now: Date;
  timeZone: string;
  afterDate?: string;
}): Promise<FunctionExecutionResult> {
  const domainArgs = queryScheduleArgumentsSchema.parse({
    ...input.args,
    query: stripDomainAliases(input.args.query, input.domain.aliases),
    domainKey: input.domain.key,
    scheduleType:
      input.domain.binding.kind === "saved_schedule" ? input.domain.binding.scheduleType : undefined
  });
  if (input.domain.binding.kind === "saved_schedule") {
    return withScheduleDomain(
      await input.memoryHandler(domainArgs, input.context),
      input.domain.key
    );
  }

  const readModel = input.options.scheduleStore
    ? await queryScheduleReadModel({
        scheduleStore: input.options.scheduleStore,
        args: domainArgs,
        profileName: input.context.profile.name,
        now: input.now,
        timeZone: input.timeZone,
        afterDate: input.afterDate,
        availableRoles: activeTaskRoles(input.context.activeTask),
        sourceKeys: input.domain.binding.sourceKeys,
        meetingWindows: input.context.profile.schedulePolicy?.meetingWindows
      })
    : undefined;
  if (readModel && !isNoScheduleResult(readModel.replyText)) {
    return withScheduleDomain(readModel, input.domain.key);
  }
  if (input.domain.binding.allowLiveFallback && input.serviceHandler) {
    return withScheduleDomain(
      await input.serviceHandler(domainArgs, input.context),
      input.domain.key
    );
  }
  return withScheduleDomain(
    readModel ?? {
      ok: true,
      replyText: "查不到符合的服事表。",
      agentResult: scheduleResultEnvelope([], { replyText: "查不到符合的服事表。" })
    },
    input.domain.key
  );
}

function stripDomainAliases(query: string, aliases: string[]): string {
  return [...aliases]
    .sort((left, right) => right.length - left.length)
    .reduce((value, alias) => value.replaceAll(alias, " "), query)
    .replace(/\s+/gu, " ")
    .trim();
}

async function storeAndReplyWithDomainClarification(input: {
  candidates: ReturnType<typeof scheduleDomainChoices>;
  args: QueryScheduleArguments;
  context: FunctionHandlerContext;
  options: QueryScheduleFunctionOptions;
  now: Date;
}): Promise<FunctionExecutionResult> {
  await storePendingResolution({
    sessionStore: input.options.sessionStore,
    requestId: input.options.requestIdFactory?.() ?? input.context.requestId ?? randomUUID(),
    capability: "query_schedule",
    groundedArguments: input.args,
    candidates: input.candidates,
    context: input.context,
    now: input.now
  });
  const replyText = `你要查哪一類服事：${input.candidates
    .map((item) => item.displayName)
    .join("、")}？`;
  return {
    ok: true,
    replyText,
    quickReplies: input.candidates.map((item) => ({
      label: item.displayName,
      action: { type: "message", label: item.displayName, text: item.displayName }
    })),
    agentResult: {
      status: "ambiguous",
      replyText,
      clarification: {
        prompt: replyText,
        choices: input.candidates.map((item) => item.displayName)
      }
    }
  };
}

function domainKeyForScheduleType(
  domains: ScheduleDomainConfig[],
  scheduleType?: string
): string | undefined {
  return scheduleType
    ? domains.find(
        (domain) =>
          domain.binding.kind === "saved_schedule" && domain.binding.scheduleType === scheduleType
      )?.key
    : undefined;
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
          sourceKeys: DEFAULT_MEDIA_SOURCE_KEYS
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
    const roleFocus =
      args.role ??
      extractScheduleRoleFocus({
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
    const domains = context.profile.schedulePolicy?.domains ?? DEFAULT_SCHEDULE_DOMAINS;
    const requestedDomainKey =
      refinedArgs.domainKey ?? domainKeyForScheduleType(domains, refinedArgs.scheduleType);
    const resolution = resolveScheduleDomain({
      domains,
      text: args.query,
      requestedDomainKey,
      activeDomainKey: activeTaskDomainKey(context.activeTask?.anchors)
    });
    if (resolution.status === "ambiguous") {
      return storeAndReplyWithDomainClarification({
        candidates: resolution.candidates,
        args: refinedArgs,
        context,
        options,
        now: now()
      });
    }
    const selectedDomainKey =
      resolution.status === "selected" ? resolution.candidate.domainKey : undefined;
    const afterDate = scheduleAdvanceDate(args, context.activeTask?.anchors);
    const results: Array<{ domainKey: string; result: FunctionExecutionResult }> = [];
    const eligibleDomains = selectedDomainKey
      ? domains.filter(({ key }) => key === selectedDomainKey)
      : domains;
    for (const domain of eligibleDomains) {
      results.push({
        domainKey: domain.key,
        result: await queryScheduleDomain({
          domain,
          args: refinedArgs,
          context,
          options,
          memoryHandler,
          serviceHandler,
          now: now(),
          timeZone,
          afterDate
        })
      });
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
    if (
      !selectedDomainKey &&
      foundDomainKeys.size > 1 &&
      !isExplicitAllScheduleDomainsRequest(args.query)
    ) {
      const candidates = scheduleDomainChoices(domains).filter((candidate) =>
        foundDomainKeys.has(candidate.domainKey)
      );
      return storeAndReplyWithDomainClarification({
        candidates,
        args: refinedArgs,
        context,
        options,
        now: now()
      });
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

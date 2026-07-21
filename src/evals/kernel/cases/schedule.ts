import { InMemoryAgentMemoryStore } from "../../../agent/memory-store.js";
import type { AgentPlanner } from "../../../agent/planner.js";
import { InMemoryConversationWindowStore } from "../../../agent/context-manager.js";
import { createPendingResolutionTextMessageHandler } from "../../../functions/pending-resolution.js";
import { createQueryScheduleHandler } from "../../../functions/query-schedule.js";
import { InMemoryScheduleStore } from "../../../schedules/store.js";
import { InMemorySessionStore } from "../../../state/session-store.js";
import type { BotProfileConfig, FunctionRegistry, ScheduleDomainConfig } from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelCaseContext,
  KernelCaseObservation,
  RecurrenceFamily
} from "../contracts.js";
import { createKernelRuntimeHarness } from "../runtime-harness.js";

const DOMAIN_MATRIX = [
  { alias: "影視團隊", role: "音控", assignee: "人員甲" },
  { alias: "晨更家族", role: "帶領家族", assignee: "家族乙" },
  { alias: "兒童主日", role: "主持", assignee: "人員丙" },
  { alias: "禱告會", role: "敬拜", assignee: "人員丁" },
  { alias: "主日", role: "導播", assignee: "人員戊" }
] as const;

const WORDING_MATRIX = [
  "下一場{domain}服事的{role}是誰",
  "請幫我查{domain}下一次{role}",
  "我想知道下一場{domain}的{role}",
  "{domain}下一場服事，{role}是誰",
  "幫我找{domain}服事表裡下一場的{role}",
  "下一次{domain}{role}",
  "查詢{domain}下一場{role}",
  "麻煩給我{domain}下一場的{role}",
  "下一場{domain}聚會由誰負責{role}",
  "{domain}下一場{role}是哪位"
] as const;

const canonicalCases = DOMAIN_MATRIX.flatMap((domain, domainIndex) =>
  WORDING_MATRIX.map((wording, wordingIndex) =>
    canonicalScheduleCase({
      id: `kernel-v1/schedule/d${domainIndex + 1}-w${wordingIndex + 1}@1`,
      text: wording.replace("{domain}", domain.alias).replace("{role}", domain.role),
      alias: domain.alias,
      role: domain.role,
      assignee: domain.assignee,
      recurrenceFamily:
        wordingIndex % 2 === 0 ? "wrapper_words_hide_subject" : "explicit_domain_lost"
    })
  )
);

const ambiguityCases: KernelAcceptanceCase[] = [
  ambiguityCase("generic-1", "下一場服事", "generic_schedule_domain_ambiguity", true),
  ambiguityCase("generic-2", "請查下一場服事安排", "generic_schedule_domain_ambiguity", true),
  ambiguityCase("generic-3", "最近一場服事表", "generic_schedule_domain_ambiguity", true),
  ambiguityCase("missing-domain", "幫我查下一場服事表", "required_slot_misrouted", true),
  ambiguityCase("unresolved-domain", "下一場聚會服事", "required_slot_misrouted", false),
  roleFollowUpCase()
];

export const SCHEDULE_KERNEL_CASES: KernelAcceptanceCase[] = [
  ...canonicalCases,
  ...ambiguityCases,
  numericResolutionCase(),
  expiredTaskCase()
];

function canonicalScheduleCase(input: {
  id: string;
  text: string;
  alias: string;
  role: string;
  assignee: string;
  recurrenceFamily: RecurrenceFamily;
}): KernelAcceptanceCase {
  return {
    id: input.id,
    version: 1,
    journey: "schedule",
    recurrenceFamily: input.recurrenceFamily,
    boundary: "response_projection",
    async run(context) {
      const harness = await scheduleHarness(context);
      const [result] = await harness.runTurns([
        { text: input.text, requesterUserId: "U_SYNTHETIC_1", requestId: input.id }
      ]);
      const passed =
        result?.resultStatus === "success" &&
        result.replyText === `${input.role}：${input.assignee}`;
      return observation(input.id, input.recurrenceFamily, {
        passed,
        scheduleAssertions: [{ passed }],
        coreJourneySucceeded: passed,
        elapsedMs: result?.elapsedMs ?? 9_000
      });
    }
  };
}

function ambiguityCase(
  slug: string,
  text: string,
  recurrenceFamily: RecurrenceFamily,
  shouldResolve: boolean
): KernelAcceptanceCase {
  const id = `kernel-v1/schedule/${slug}@1`;
  return {
    id,
    version: 1,
    journey: "schedule",
    recurrenceFamily,
    boundary: "slot_ambiguity_resolution",
    async run(context) {
      const harness = await scheduleHarness(context);
      const results = await harness.runTurns([
        { text, requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-ask` },
        {
          text: shouldResolve ? "影視團隊服事" : "不知道",
          requesterUserId: "U_SYNTHETIC_1",
          requestId: `${id}-answer`
        }
      ]);
      const firstIsAmbiguous = results[0]?.resultStatus === "ambiguous";
      const resolved = shouldResolve && results[1]?.resultStatus === "success";
      const passed = firstIsAmbiguous && (shouldResolve ? resolved : !resolved);
      return observation(id, recurrenceFamily, {
        passed,
        coreJourneySucceeded: passed,
        ambiguityEligible: true,
        ambiguityResolvedWithinTwoTurns: resolved,
        elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0)
      });
    }
  };
}

function roleFollowUpCase(): KernelAcceptanceCase {
  const id = "kernel-v1/schedule/role-follow-up@1";
  return {
    id,
    version: 1,
    journey: "schedule",
    recurrenceFamily: "role_follow_up_lost",
    boundary: "active_task_lifecycle",
    async run(context) {
      const harness = await scheduleHarness(context);
      const results = await harness.runTurns([
        {
          text: "下一場影視團隊服事",
          requesterUserId: "U_SYNTHETIC_1",
          requestId: `${id}-context`
        },
        {
          text: "音控是誰",
          requesterUserId: "U_SYNTHETIC_1",
          requestId: `${id}-follow-up`
        }
      ]);
      const passed =
        results[0]?.resultStatus === "success" &&
        results[1]?.resultStatus === "success" &&
        results[1]?.replyText === "音控：人員甲";
      return observation(id, "role_follow_up_lost", {
        passed,
        boundary: "active_task_lifecycle",
        coreJourneySucceeded: passed,
        elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0)
      });
    }
  };
}

function numericResolutionCase(): KernelAcceptanceCase {
  const id = "kernel-v1/schedule/numeric-resolution@1";
  return {
    id,
    version: 1,
    journey: "schedule",
    recurrenceFamily: "generic_schedule_domain_ambiguity",
    boundary: "slot_ambiguity_resolution",
    async run(context) {
      const harness = await scheduleHarness(context);
      const results = await harness.runTurns([
        { text: "下一場服事", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-ask` },
        { text: "1", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-select` }
      ]);
      const passed =
        results[0]?.resultStatus === "ambiguous" && results[1]?.resultStatus === "success";
      return observation(id, "generic_schedule_domain_ambiguity", {
        passed,
        coreJourneySucceeded: passed,
        elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0)
      });
    }
  };
}

function expiredTaskCase(): KernelAcceptanceCase {
  const id = "kernel-v1/schedule/expired-task-runtime@1";
  return {
    id,
    version: 1,
    journey: "schedule",
    recurrenceFamily: "role_follow_up_lost",
    boundary: "active_task_lifecycle",
    async run(context) {
      const conversationWindowStore = new InMemoryConversationWindowStore({ now: context.now });
      await conversationWindowStore.recordActiveTask({
        scope: {
          profileName: "helper",
          sourceKey: "group:G_SYNTHETIC",
          requesterUserId: "U_SYNTHETIC_1"
        },
        task: {
          version: 2,
          currentCapability: "query_schedule",
          allowedCapabilities: ["query_schedule"],
          anchors: { domainKey: "domain_1" },
          entities: [{ type: "schedule_domain", key: "domain_1", label: "服事類別" }],
          supportedOperations: ["continue", "refine"],
          createdAt: new Date(context.now().getTime() - 120_000).toISOString(),
          expiresAt: new Date(context.now().getTime() - 60_000).toISOString()
        },
        ttlMs: 60_000
      });
      const harness = await scheduleHarness(context, conversationWindowStore);
      const [result] = await harness.runTurns([
        { text: "那一位呢", requesterUserId: "U_SYNTHETIC_1", requestId: id }
      ]);
      const passed = result?.resultStatus !== "success";
      return observation(id, "role_follow_up_lost", {
        passed,
        boundary: "active_task_lifecycle",
        coreJourneySucceeded: passed,
        elapsedMs: result?.elapsedMs ?? 9_000
      });
    }
  };
}

async function scheduleHarness(
  context: KernelCaseContext,
  conversationWindowStore?: InMemoryConversationWindowStore
) {
  const store = new InMemoryScheduleStore();
  const domains = DOMAIN_MATRIX.map((entry, index) => scheduleDomain(entry, index));
  const serviceDate = new Date(context.now().getTime() + 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  for (const [index, entry] of DOMAIN_MATRIX.entries()) {
    await store.upsertItem({
      profileName: "helper",
      sourceKey: `source_${index + 1}`,
      origin: "line",
      externalId: `entry_${index + 1}`,
      serviceDate,
      meeting: fixtureMeeting(entry.alias),
      role: entry.role,
      assignee: entry.assignee
    });
  }
  const sessionStore = new InMemorySessionStore({ now: context.now });
  const handler = createQueryScheduleHandler({
    memoryStore: new InMemoryAgentMemoryStore({ now: context.now }),
    scheduleStore: store,
    sessionStore,
    now: context.now,
    timeZone: "Asia/Taipei"
  });
  const functions: FunctionRegistry = { query_schedule: handler };
  return createKernelRuntimeHarness({
    now: context.now,
    profile: scheduleProfile(domains),
    functionRegistry: functions,
    textMessageHandlers: {
      pending_resolution: createPendingResolutionTextMessageHandler({
        sessionStore,
        functions
      })
    },
    sessionStore,
    planner: schedulePlanner(),
    conversationWindowStore
  });
}

function schedulePlanner(): AgentPlanner {
  return {
    propose: async ({ text }) => {
      const role = [...DOMAIN_MATRIX]
        .sort((left, right) => right.role.length - left.role.length)
        .find((entry) => text.includes(entry.role))?.role;
      return {
        status: "proposed",
        version: 1,
        disposition: "execute",
        capability: "query_schedule",
        arguments: {
          query: text,
          dateIntent: "next_meeting",
          ...(role ? { role } : {})
        },
        confidence: 0.98,
        provider: "deepseek",
        attempts: []
      };
    }
  };
}

function scheduleDomain(
  entry: (typeof DOMAIN_MATRIX)[number],
  index: number
): ScheduleDomainConfig {
  return {
    key: `domain_${index + 1}`,
    displayName: `${entry.alias}服事`,
    aliases: [entry.alias],
    routingHints: [entry.role],
    schemaVersion: 1,
    inputSchema: "assignment_rows_v1",
    occurrencePolicy: "profile_meeting_windows_v1",
    binding: {
      kind: "canonical",
      sourceKeys: [`source_${index + 1}`],
      allowLiveFallback: false
    },
    origins: ["line"],
    writePolicy: { mode: "read_only", allowedOperations: [] },
    priority: 100 - index,
    revision: "1",
    freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
  };
}

function fixtureMeeting(alias: string): string {
  if (alias.includes("晨更")) return "晨更";
  if (alias.includes("主日")) return "主日";
  return alias;
}

function scheduleProfile(domains: ScheduleDomainConfig[]): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    allowedProviders: ["deepseek", "ollama"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains }
  };
}

function observation(
  caseId: string,
  recurrenceFamily: RecurrenceFamily,
  override: Partial<KernelCaseObservation>
): KernelCaseObservation {
  return {
    caseId,
    passed: false,
    boundary: "response_projection",
    recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: false,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs: 0,
    returnedRetrievableJob: false,
    ...override
  };
}

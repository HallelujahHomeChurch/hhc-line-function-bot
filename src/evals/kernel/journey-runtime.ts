import type { AgentPlanner } from "../../agent/planner.js";
import type { AgentResultStatus } from "../../agent/result-envelope.js";
import type {
  AgentPlanRecord,
  BotProfileConfig,
  FunctionName,
  FunctionRegistry
} from "../../types.js";
import type { KernelJourney } from "./contracts.js";
import { createKernelRuntimeHarness, type KernelTurnResult } from "./runtime-harness.js";

const journeyCapability: Record<KernelJourney, FunctionName> = {
  schedule: "query_schedule",
  ppt: "find_ppt_slides",
  sheet_music: "find_sheet_music",
  resource: "find_resource",
  knowledge: "query_knowledge",
  memory: "retrieve_memory",
  write: "save_memory"
};

const journeyText: Record<KernelJourney, string> = {
  schedule: "查下一場服事",
  ppt: "查投影片 synthetic",
  sheet_music: "查歌譜 synthetic",
  resource: "查教會資料 synthetic",
  knowledge: "查知識 synthetic",
  memory: "查我記住的資訊 synthetic",
  write: "幫我記住 synthetic payload"
};

export async function runKernelJourneyCheck(input: {
  journey: KernelJourney;
  now: () => Date;
  check: () => Promise<boolean>;
  requestId: string;
}): Promise<KernelTurnResult | undefined> {
  return runKernelJourneyStatus({
    journey: input.journey,
    now: input.now,
    resolveStatus: async () => ((await input.check()) ? "success" : "not_found"),
    requestId: input.requestId
  });
}

export async function runKernelJourneyStatus(input: {
  journey: KernelJourney;
  now: () => Date;
  resolveStatus: () => Promise<AgentResultStatus>;
  requestId: string;
}): Promise<KernelTurnResult | undefined> {
  const capability = journeyCapability[input.journey];
  const text = journeyText[input.journey];
  const functions: FunctionRegistry = {
    [capability]: async () => {
      const status = await input.resolveStatus();
      const replyText = status === "success" ? "synthetic success" : `synthetic ${status}`;
      return {
        ok: true,
        replyText,
        agentResult: { status, replyText, entities: [], supportedOperations: [] }
      };
    }
  };
  const harness = createKernelRuntimeHarness({
    now: input.now,
    profile: profile(capability),
    functionRegistry: functions,
    planner: planner(capability, text)
  });
  const [result] = await harness.runTurns([
    { text, requesterUserId: "U_SYNTHETIC_1", requestId: input.requestId }
  ]);
  return result;
}

function planner(capability: FunctionName, text: string): AgentPlanner {
  const argumentsRecord: AgentPlanRecord =
    capability === "save_memory" ? { query: text, content: "synthetic payload" } : { query: text };
  return {
    propose: async () => ({
      status: "proposed",
      version: 1,
      disposition: "execute",
      capability,
      arguments: argumentsRecord,
      confidence: 0.99,
      provider: "deepseek",
      attempts: []
    })
  };
}

function profile(capability: FunctionName): BotProfileConfig {
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
    enabledFunctions: [capability],
    allowedProviders: ["deepseek", "ollama"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

import { FakeToolCallingModel, AIMessage, type BaseMessage } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { createHelperRuntime } from "../helper-agent/runtime.js";
import type { HelperRuntimeOptions } from "../helper-agent/runtime.js";
import { createHelperAgentState, type HelperAgentState } from "../helper-agent/state.js";
import type { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionRegistry,
  JsonRecord,
  LineSource,
  ScheduleDomainConfig,
  WebSearchClient
} from "../types.js";
import type { PublicPageReader } from "../clients/public-page.js";
import { extractProviderUsage } from "./provider-usage.js";

export interface EvalMetrics {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export function createEvalProbe() {
  const metrics = emptyEvalMetrics();
  const inputs: BaseMessage[][] = [];
  const outputs: BaseMessage[] = [];
  const toolNames: string[] = [];
  const boundToolSets: string[][] = [];
  const started = (messages: BaseMessage[]) => {
    metrics.modelCalls += 1;
    inputs.push([...messages]);
  };
  const ended = (output: unknown) => {
    for (const message of outputMessages(output)) {
      outputs.push(message);
      if (AIMessage.isInstance(message)) {
        metrics.toolCalls += message.tool_calls?.length ?? 0;
        toolNames.push(...(message.tool_calls ?? []).map(({ name }) => name));
      }
      const usage = extractProviderUsage(message);
      metrics.inputTokens += usage.inputTokens;
      metrics.outputTokens += usage.outputTokens;
      metrics.cacheHitTokens += usage.cacheHitTokens;
      metrics.cacheMissTokens += usage.cacheMissTokens;
    }
  };
  return {
    inputs,
    outputs,
    toolNames,
    boundToolSets,
    started,
    ended,
    callbacks: [
      {
        handleChatModelStart(_model: unknown, batches: BaseMessage[][]) {
          for (const messages of batches) started(messages);
        },
        handleLLMEnd: ended
      }
    ],
    values: () => ({ ...metrics })
  };
}

export function instrumentedFakeModel(
  toolCalls: Array<Array<{ name: string; args: JsonRecord; id: string }>>,
  probe: ReturnType<typeof createEvalProbe>,
  fail = false
) {
  const instrument = (model: FakeToolCallingModel): FakeToolCallingModel => {
    const generate = model._generate.bind(model);
    model._generate = (async (...args: Parameters<typeof generate>) => {
      probe.started(args[0]);
      if (fail) throw new Error("synthetic_provider_failure");
      const result = await generate(...args);
      probe.ended(result);
      return result;
    }) as typeof model._generate;
    const bind = model.bindTools.bind(model);
    model.bindTools = ((tools) => {
      probe.boundToolSets.push(tools.map(({ name }) => name));
      const bound = bind(tools);
      return bound instanceof FakeToolCallingModel ? instrument(bound) : bound;
    }) as typeof model.bindTools;
    return model;
  };
  return instrument(new FakeToolCallingModel({ toolCalls }));
}

interface FixtureOptions {
  model: HelperRuntimeOptions["summaryModel"];
  probe: ReturnType<typeof createEvalProbe>;
  enabledFunctions: BotProfileConfig["enabledFunctions"];
  handlers?: FunctionRegistry;
  profile?: Partial<BotProfileConfig>;
  source?: LineSource;
  sessions?: InMemorySessionStore;
  jobs?: InMemoryAgentJobStore;
  state?: HelperAgentState;
  lastErrorStore?: InMemoryLastErrorStore;
  webSearch?: WebSearchClient;
  pageReader?: PublicPageReader;
  now?: () => Date;
}

export function createSyntheticRuntimeFixture(options: FixtureOptions) {
  const now = options.now ?? (() => new Date("2026-09-04T00:00:00.000Z"));
  const source = options.source ?? { type: "user", userId: "U1" };
  const sessions = options.sessions ?? new InMemorySessionStore({ now });
  const jobs = options.jobs ?? new InMemoryAgentJobStore({ now });
  const calls = new Map<string, Array<{ args: JsonRecord; result: FunctionExecutionResult }>>();
  const handlers = Object.fromEntries(
    Object.entries(options.handlers ?? {}).map(([name, handler]) => [
      name,
      async (args: JsonRecord, context: FunctionHandlerContext) => {
        const result = await handler!(args, context);
        calls.set(name, [...(calls.get(name) ?? []), { args, result }]);
        return result;
      }
    ])
  ) as FunctionRegistry;
  const profile = { ...helperProfile(options.enabledFunctions), ...options.profile };
  const runtime = createHelperRuntime({
    model: options.model,
    summaryModel: options.model,
    state:
      options.state ??
      createHelperAgentState({ checkpointer: new MemorySaver(), hmacKey: "eval-state", now }),
    handlers,
    sessions,
    jobs,
    webSearch: options.webSearch,
    pageReader: options.pageReader,
    lastErrorStore: options.lastErrorStore,
    now
  });
  const turn = (text: string, turnSource = source, requestId = "synthetic-eval") => ({
    profile,
    event: {
      type: "message" as const,
      source: turnSource,
      message: { type: "text" as const, text }
    },
    requestId,
    configuredFunctions: [...profile.enabledFunctions],
    authorizeFunctions: async (names: BotProfileConfig["enabledFunctions"]) => [...names],
    accountAdministrator: () => true
  });
  return { runtime, profile, source, sessions, jobs, calls, probe: options.probe, turn };
}

export function helperProfile(
  enabledFunctions: BotProfileConfig["enabledFunctions"]
): BotProfileConfig {
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
    enabledFunctions,
    permissionRequiredFunctions: [],
    directAccessPolicy: "public",
    groupAccessPolicy: "managed",
    adminDirectOnly: true,
    agent: { personaPrompt: "synthetic", memoryPolicyPrompt: "synthetic" },
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [syntheticScheduleDomain()] }
  };
}

export function syntheticScheduleDomain(
  key = "official_service",
  displayName = "正式服事表",
  sourceKey = "official-service"
): ScheduleDomainConfig {
  return {
    key,
    displayName,
    aliases: [displayName, "服事表"],
    routingHints: [],
    schemaVersion: 1,
    inputSchema: "assignment_rows_v1",
    occurrencePolicy: "profile_meeting_windows_v1",
    binding: { kind: "canonical", sourceKeys: [sourceKey], allowLiveFallback: false },
    origins: ["notion"],
    writePolicy: { mode: "read_only", allowedOperations: [] },
    priority: 100,
    revision: "synthetic-1",
    freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
  };
}

export function emptyEvalMetrics(): EvalMetrics {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0
  };
}

function outputMessages(output: unknown): BaseMessage[] {
  const generations = (
    output as {
      generations?: Array<{ message?: BaseMessage } | Array<{ message?: BaseMessage }>>;
    }
  ).generations;
  return (generations ?? []).flatMap((batch) => {
    const entries = Array.isArray(batch) ? batch : [batch];
    return entries.flatMap(({ message }) => (message ? [message] : []));
  });
}

import { MemorySaver } from "@langchain/langgraph";
import { FakeToolCallingModel, ToolMessage } from "langchain";
import { countTokensApproximately } from "langchain";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createHelperReadTools } from "../helper-agent/read-tools.js";
import {
  createHelperModels,
  createHelperRuntime,
  helperSystemPrompt
} from "../helper-agent/runtime.js";
import { createHelperAgentState, type HelperAgentState } from "../helper-agent/state.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  LineSource
} from "../types.js";

const readFunctions: FunctionName[] = [
  "query_schedule",
  "find_ppt_slides",
  "find_sheet_music",
  "find_resource",
  "query_knowledge",
  "retrieve_memory",
  "query_wikipedia"
];

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: readFunctions,
    permissionRequiredFunctions: [],
    agent: { personaPrompt: "合成人設", memoryPolicyPrompt: "合成記憶政策" },
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function input(text: string, source: LineSource = { type: "user", userId: "LINE_USER_ID" }) {
  return {
    profile: profile(),
    event: { type: "message", source, message: { type: "text", text } },
    requestId: "request-1"
  };
}

function handlers(): FunctionRegistry {
  return Object.fromEntries(
    readFunctions.map((name) => [
      name,
      vi.fn(async () => ({
        ok: true,
        replyText: "domain",
        agentResult: {
          status: "success" as const,
          replyText: "domain",
          replyData: { kind: name, fields: { result: "synthetic" } }
        }
      }))
    ])
  );
}

function state(overrides: Partial<HelperAgentState> = {}): HelperAgentState {
  const checkpointer = new MemorySaver();
  return {
    checkpointer,
    threadId: ({ source }) => (source.userId ? `helper-${source.userId}` : undefined),
    run: async ({ task }) => task(),
    reset: vi.fn(async () => undefined),
    allowExternalSheetMusic: vi.fn(async () => undefined),
    externalSheetMusicAllowed: vi.fn(async () => false),
    ...overrides
  };
}

describe("helper profile runtime", () => {
  it("does not invoke a model for a group without a requester", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const invoke = vi.spyOn(model, "invoke");
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers()
    });

    await expect(
      runtime.handleTextTurn(input("你好", { type: "group", groupId: "G1" }))
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails closed when checkpoint persistence is unavailable", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const generate = vi.spyOn(model, "_generate");
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state({ run: vi.fn(async () => Promise.reject(new Error("checkpoint unavailable"))) }),
      handlers: handlers()
    });

    await expect(runtime.handleTextTurn(input("你好"))).resolves.toMatchObject({
      ok: false,
      replyText: expect.stringContaining("支援碼")
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("clears prior tool evidence before the model runs after authorization is revoked", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "get_official_schedule",
            args: { query: "synthetic" },
            id: "tool-1"
          }
        ],
        [],
        []
      ]
    });
    const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
    const generate = vi.spyOn(model, "_generate");
    const helperProfile = profile();
    helperProfile.permissionRequiredFunctions = ["query_schedule"];
    const scopedState = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "test-hmac"
    });
    let granted = true;
    const authorizeFunctions = vi.fn(async (names: readonly FunctionName[]) =>
      granted ? names : names.filter((name) => name !== "query_schedule")
    );
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: scopedState,
      handlers: handlers()
    });
    const turn = {
      ...input("查服事表"),
      profile: helperProfile,
      configuredFunctions: readFunctions,
      authorizeFunctions
    };

    await runtime.handleTextTurn(turn);
    expect(generate.mock.calls.at(-1)?.[0].some(ToolMessage.isInstance)).toBe(true);
    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).toContain(
      "get_official_schedule"
    );

    granted = false;
    await runtime.handleTextTurn({ ...turn, event: input("繼續").event });

    const secondTurnModelInput = generate.mock.calls.at(-1)?.[0] ?? [];
    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).not.toContain(
      "get_official_schedule"
    );
    expect(secondTurnModelInput.some(ToolMessage.isInstance)).toBe(false);
    expect(secondTurnModelInput.some((message) => message.text.includes("domain"))).toBe(false);
    expect(
      authorizeFunctions.mock.calls.filter(([names]) => names.length === readFunctions.length)
    ).toHaveLength(2);
  });

  it("keeps unrestricted reads when authorization infrastructure is unavailable", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "query_wikipedia",
            args: { query: "synthetic" },
            id: "tool-1"
          }
        ],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const functionHandlers = handlers();
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: functionHandlers
    });

    await runtime.handleTextTurn({
      ...input("查百科"),
      configuredFunctions: readFunctions,
      authorizeFunctions: vi.fn(async () => Promise.reject(new Error("authorization unavailable")))
    });

    expect(functionHandlers.query_wikipedia).toHaveBeenCalledOnce();
  });

  it("returns a bounded support response when DeepSeek fails", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    vi.spyOn(model, "_generate").mockRejectedValue(new Error("provider timeout"));
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers()
    });

    const result = await runtime.handleTextTurn(input("你好"));

    expect(result).toMatchObject({ ok: false, replyText: expect.stringContaining("支援碼") });
    expect(result?.replyText.length).toBeLessThan(200);
  });

  it("still returns the bounded support response when error recording fails", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state({ run: vi.fn(async () => Promise.reject(new Error("checkpoint unavailable"))) }),
      handlers: handlers(),
      lastErrorStore: {
        record: vi.fn(async () => Promise.reject(new Error("store unavailable"))),
        list: vi.fn(async () => []),
        clear: vi.fn(async () => 0)
      }
    });

    const result = await runtime.handleTextTurn(input("你好"));

    expect(result).toEqual({
      ok: false,
      replyText: expect.stringContaining("支援碼")
    });
    expect(result?.replyText.length).toBeLessThan(200);
  });

  it("resets only the scoped short-term thread", async () => {
    const scopedState = state();
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: scopedState,
      handlers: handlers()
    });

    await expect(runtime.handleTextTurn(input("忘記這段對話"))).resolves.toEqual({
      ok: true,
      replyText: "這段短期對話已清除。"
    });
    expect(scopedState.reset).toHaveBeenCalledWith("helper-LINE_USER_ID");
  });

  it("keeps IDs out of the prompt and all seven schemas within two thousand approximate tokens", () => {
    const context: FunctionHandlerContext = {
      profile: profile(),
      event: {
        type: "message",
        source: { type: "group", groupId: "LINE_GROUP_ID", userId: "LINE_USER_ID" },
        message: { type: "text", text: "synthetic" }
      }
    };
    const tools = createHelperReadTools({ context, handlers: handlers() });
    const prompt = helperSystemPrompt(
      profile(),
      context.event.source,
      new Date("2026-09-04T00:00:00Z")
    );

    expect(countTokensApproximately([], tools)).toBeLessThanOrEqual(2_000);
    expect(tools).toHaveLength(7);
    expect(prompt).not.toContain("LINE_USER_ID");
    expect(prompt).not.toContain("LINE_GROUP_ID");
    expect(prompt).toContain("group");
  });

  it("constructs response and summary models with one budgeted transport and 800 output tokens", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const models = createHelperModels({
      apiKey: "test",
      baseUrl: "https://api.deepseek.test",
      model: "deepseek-v4-flash",
      timeoutMs: 8_000,
      fetchImpl
    });

    expect(models.model.maxTokens).toBe(800);
    expect(models.summaryModel.maxTokens).toBe(800);
    expect(models.model.clientConfig.fetch).toBe(models.summaryModel.clientConfig.fetch);
    expect(models.model.clientConfig.fetch).not.toBe(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits only bounded helper counters, tool names, and statuses", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "get_official_schedule",
            args: { query: "synthetic-private-text" },
            id: "tool-private-id"
          }
        ],
        []
      ]
    });
    const traceStore = new InMemoryAgentTraceStore();
    const routeObserver = vi.fn();
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers(),
      traceStore,
      routeObserver
    });

    await runtime.handleTextTurn(input("synthetic-private-text"));

    const traces = await traceStore.list();
    expect(traces[0]?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "route",
          provider: "deepseek",
          modelCallCount: 2,
          toolCallCount: 1,
          selectedToolNames: ["get_official_schedule"],
          finalStatus: "success"
        })
      ])
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product_event",
        eventName: "helper_agent_turn",
        modelCallCount: 2,
        toolCallCount: 1,
        resultClass: "success"
      })
    );
    expect(JSON.stringify({ traces, events: routeObserver.mock.calls })).not.toMatch(
      /synthetic-private-text|LINE_USER_ID|tool-private-id/u
    );
  });
});

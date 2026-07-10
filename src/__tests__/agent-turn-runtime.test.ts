import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../agent/agent-runtime.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { MemoryInFlightStore } from "../in-flight/in-flight-store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandler,
  FunctionRouterPort,
  GraphDriveClient,
  LineEvent,
  TextGenerationProvider
} from "../types.js";

function profile(
  enabledFunctions: BotProfileConfig["enabledFunctions"],
  overrides: Partial<BotProfileConfig> = {}
): BotProfileConfig {
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
    enabledFunctions,
    ...overrides
  };
}

function textEvent(text: string): LineEvent {
  return {
    type: "message",
    replyToken: "reply-token",
    source: { type: "group", groupId: "C1", userId: "U1" },
    message: { type: "text", text }
  };
}

function createRuntime(options: {
  router?: FunctionRouterPort;
  functionRegistry?: Record<string, FunctionHandler>;
  sessionStore?: InMemorySessionStore;
  traceStore?: InMemoryAgentTraceStore;
  graph?: GraphDriveClient;
  memoryStore?: InMemoryAgentMemoryStore;
  textGenerator?: TextGenerationProvider;
  textFallbackGenerator?: TextGenerationProvider;
}) {
  const now = () => new Date("2026-07-08T00:00:00.000Z");
  const memoryStore = options.memoryStore ?? new InMemoryAgentMemoryStore({ now });
  return createAgentTurnRuntime({
    router:
      options.router ??
      ({
        route: vi
          .fn()
          .mockResolvedValue({ type: "deny", reason: "not_matched", provider: "ollama" })
      } satisfies FunctionRouterPort),
    functionRegistry: options.functionRegistry ?? {},
    textMessageHandlers: {},
    adminActionRouter: undefined,
    adminActionRegistry: undefined,
    accessStore: undefined,
    inFlightStore: new MemoryInFlightStore(),
    sessionStore: options.sessionStore,
    agentRuntime: createAgentRuntime({
      memoryStore,
      graph: options.graph,
      now
    }),
    traceStore: options.traceStore,
    lastErrorStore: new InMemoryLastErrorStore(10),
    lastRouteStore: new InMemoryLastRouteStore(10),
    textGenerator: options.textGenerator,
    textFallbackGenerator: options.textFallbackGenerator,
    now
  });
}

describe("AgentTurnRuntime", () => {
  it("clarifies a generic query before invoking the router", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const runtime = createRuntime({ router: { route } });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_ppt_slides", "query_service_schedule", "save_schedule_memory"]),
      event: textEvent("小哈，幫我查東西"),
      requestId: "req-generic-query"
    });

    expect(result?.replyText).toContain("想查什麼");
    expect(result?.quickReplies?.map((item) => item.label)).toEqual(["查投影片", "查服事表"]);
    expect(route).not.toHaveBeenCalled();
  });

  it("answers recent resource follow-ups before calling the router", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now });
    await memoryStore.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "奇異恩典.pptx",
      storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-1" },
      expiresAt: "2026-08-08T00:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/recalled")
    };
    const route = vi.fn<FunctionRouterPort["route"]>();
    const traceStore = new InMemoryAgentTraceStore(10);
    const runtime = createRuntime({
      router: { route },
      graph,
      memoryStore,
      traceStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_ppt_slides"]),
      event: textEvent("小哈 再給我一次"),
      requestId: "req-1"
    });

    expect(result?.replyText).toContain("奇異恩典.pptx");
    expect(result?.replyText).toContain("https://download.invalid/recalled");
    expect(route).not.toHaveBeenCalled();
    await expect(traceStore.list()).resolves.toMatchObject([
      {
        requestId: "req-1",
        steps: expect.arrayContaining([
          expect.objectContaining({ phase: "pre_route_memory", outcome: "handled" })
        ])
      }
    ]);
  });

  it("stores a generic missing-slot clarification before calling the function handler", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { find_ppt_slides: handler },
      sessionStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_ppt_slides"]),
      event: textEvent("小哈 查投影片"),
      requestId: "req-2"
    });

    expect(result?.replyText).toContain("要查哪一份投影片");
    expect(handler).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });
  });

  it("clarifies a generic sheet music request even when the model supplies a title", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_pop_sheet_music",
      arguments: { query: "Yesterday", matchMode: "fuzzy" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { find_pop_sheet_music: handler },
      sessionStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_pop_sheet_music"]),
      event: textEvent("小哈 查流行歌譜"),
      requestId: "req-sheet-generic"
    });

    expect(result?.replyText).toContain("歌名");
    expect(handler).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });
  });

  it("clarifies a generic Wikipedia request even when the model supplies a topic", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_wikipedia",
      arguments: { query: "烏戈·查維茲" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { query_wikipedia: handler },
      sessionStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_wikipedia"]),
      event: textEvent("小哈 查維基百科"),
      requestId: "req-wikipedia-generic"
    });

    expect(result?.replyText).toContain("想查哪個維基百科主題");
    expect(handler).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });
  });

  it("clarifies a generic service schedule request even when the model infers next meeting", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_service_schedule",
      arguments: { query: "服事表", dateIntent: "next_meeting", limit: 1 },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { query_service_schedule: handler },
      sessionStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_service_schedule"]),
      event: textEvent("小哈查服事表"),
      requestId: "req-service-generic"
    });

    expect(result?.replyText).toContain("哪一場");
    expect(handler).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });
  });

  it("overrides an intro route when the user clearly asks for the next service schedule", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "introduce_bot",
      arguments: { variant: "capabilities" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "下一場聚會服事表"
    });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { query_service_schedule: handler }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_service_schedule"]),
      event: textEvent("小哈下一場聚會服事"),
      requestId: "req-service-guard"
    });

    expect(result?.replyText).toBe("下一場聚會服事表");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "小哈下一場聚會服事",
        dateIntent: "next_meeting"
      }),
      expect.any(Object)
    );
  });

  it("overrides an intro route when the user clearly asks for this week's service schedule", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "introduce_bot",
      arguments: { variant: "capabilities" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "聚會服事表"
    });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { query_service_schedule: handler }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_service_schedule"]),
      event: textEvent("小哈給我這週服事表"),
      requestId: "req-service-week-guard"
    });

    expect(result?.replyText).toBe("聚會服事表");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "小哈給我這週服事表",
        dateIntent: "this_week"
      }),
      expect.any(Object)
    );
  });

  it("records sanitized trace for routed function execution", async () => {
    const traceStore = new InMemoryAgentTraceStore(10);
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "secret song title" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "done"
    });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { find_ppt_slides: handler },
      traceStore
    });

    await runtime.handleTextTurn({
      profile: profile(["find_ppt_slides"]),
      event: textEvent("小哈 查投影片 secret song title"),
      requestId: "req-3"
    });

    const serialized = JSON.stringify(await traceStore.list());
    expect(serialized).toContain('"query":"present"');
    expect(serialized).toContain('"action":"find_ppt_slides"');
    expect(serialized).not.toContain("secret song title");
  });

  it("records the provider used for generated small talk", async () => {
    const traceStore = new InMemoryAgentTraceStore(10);
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "small_talk",
      arguments: { category: "light_joke" },
      provider: "ollama",
      lane: "function_routing"
    });
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("今天先輕鬆一下。");
    const runtime = createRuntime({
      router: { route },
      traceStore,
      textGenerator: {
        providerNameForProfile: () => "deepseek",
        completeText
      }
    });

    const result = await runtime.handleTextTurn({
      profile: profile([], { smallTalk: { mode: "llm", maxChars: 80 } }),
      event: textEvent("說個笑話"),
      requestId: "req-4"
    });

    expect(result?.replyText).toBe("今天先輕鬆一下。");
    await expect(traceStore.list()).resolves.toMatchObject([
      {
        requestId: "req-4",
        steps: expect.arrayContaining([
          expect.objectContaining({
            phase: "route",
            outcome: "respond",
            provider: "ollama",
            lane: "function_routing",
            action: "small_talk"
          }),
          expect.objectContaining({
            phase: "small_talk",
            outcome: "generated",
            provider: "deepseek",
            lane: "smart_talk"
          })
        ])
      }
    ]);
  });
});

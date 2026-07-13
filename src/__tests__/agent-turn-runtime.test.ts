import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../agent/agent-runtime.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { MemoryInFlightStore } from "../in-flight/in-flight-store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
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
  conversationWindowStore?: InMemoryConversationWindowStore;
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
    conversationWindowStore: options.conversationWindowStore,
    now
  });
}

describe("AgentTurnRuntime", () => {
  it("executes a real two-turn media schedule follow-up without leaking another source", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const schedules = new InMemoryScheduleStore();
    for (const [sourceKey, assignee] of [
      ["media_team_service_schedule", "資恆"],
      ["other_team_schedule", "錯誤同工"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey,
        origin: "notion",
        externalId: `${sourceKey}-1`,
        serviceDate: "2026-07-14",
        meeting: "晨更",
        role: "音控",
        assignee
      });
    }
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const route = vi
      .fn<FunctionRouterPort["route"]>()
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
        provider: "ollama"
      })
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "音控是誰", role: "音控" },
        provider: "ollama"
      });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: {
        query_schedule: createQueryScheduleHandler({
          memoryStore: new InMemoryAgentMemoryStore({ now }),
          scheduleStore: schedules,
          now,
          timeZone: "Asia/Taipei"
        })
      },
      conversationWindowStore
    });
    const botProfile = profile(["query_schedule"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 }
    });

    const first = await runtime.handleTextTurn({
      profile: botProfile,
      event: textEvent("下一場影視團隊服事表"),
      requestId: "req-real-schedule-1"
    });
    const second = await runtime.handleTextTurn({
      profile: botProfile,
      event: textEvent("音控是誰"),
      requestId: "req-real-schedule-2"
    });

    expect(first?.replyText).toContain("音控：資恆");
    expect(first?.agentResult).toMatchObject({
      status: "success",
      replyText: first.replyText,
      anchors: {
        date: "2026-07-14",
        meeting: "晨更",
        sourceKeys: ["media_team_service_schedule"]
      },
      entities: [expect.objectContaining({ type: "role", label: "音控" })],
      supportedOperations: ["continue", "refine", "advance"]
    });
    expect(second?.replyText).toContain("音控：資恆");
    expect(second?.replyText).not.toContain("錯誤同工");
  });

  it("keeps all canonical roles after a focused answer for the next bare follow-up", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const schedules = new InMemoryScheduleStore();
    for (const [role, assignee] of [
      ["音控", "資恆"],
      ["導播", "莘凌"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: `media-${role}`,
        serviceDate: "2026-07-14",
        meeting: "晨更",
        role,
        assignee
      });
    }
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const route = vi
      .fn<FunctionRouterPort["route"]>()
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "下一場影視團隊服事表", dateIntent: "next_meeting" },
        provider: "ollama"
      })
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "音控是誰", role: "音控" },
        provider: "ollama"
      })
      .mockResolvedValueOnce({
        type: "respond",
        action: "small_talk",
        arguments: { category: "persona" },
        provider: "ollama"
      });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: {
        query_schedule: createQueryScheduleHandler({
          memoryStore: new InMemoryAgentMemoryStore({ now }),
          scheduleStore: schedules,
          now,
          timeZone: "Asia/Taipei"
        })
      },
      conversationWindowStore
    });
    const botProfile = profile(["query_schedule"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 }
    });

    await runtime.handleTextTurn({
      profile: botProfile,
      event: textEvent("下一場影視團隊服事表"),
      requestId: "req-role-chain-1"
    });
    await runtime.handleTextTurn({
      profile: botProfile,
      event: textEvent("音控是誰"),
      requestId: "req-role-chain-2"
    });
    const third = await runtime.handleTextTurn({
      profile: botProfile,
      event: textEvent("導播"),
      requestId: "req-role-chain-3"
    });

    expect(third?.replyText).toContain("導播：莘凌");
  });

  it("carries declared schedule context into a same-function follow-up", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    await conversationWindowStore.recordFunctionContext({
      scope: {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      },
      functionName: "query_schedule",
      arguments: {
        query: "下一場影視團隊服事表",
        dateIntent: "next_meeting",
        meeting: "影視團隊服事"
      },
      resultReferences: {
        kind: "schedule_read_model",
        sourceKeys: ["media_team_service_schedule"]
      },
      ttlMs: 60_000
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
      arguments: { query: "音控是誰？", role: "音控" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "音控：資恆"
    });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { query_schedule: handler },
      conversationWindowStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"]),
      event: textEvent("音控是誰？"),
      requestId: "req-schedule-follow-up"
    });

    expect(result?.replyText).toBe("音控：資恆");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "音控是誰？",
        dateIntent: "next_meeting",
        meeting: "影視團隊服事",
        role: "音控"
      }),
      expect.objectContaining({
        continuation: expect.objectContaining({
          functionName: "query_schedule",
          resultReferences: {
            kind: "schedule_read_model",
            sourceKeys: ["media_team_service_schedule"]
          }
        })
      })
    );
  });

  it.each(["導播", "導播是誰", "音控是誰"])(
    "protects an active schedule follow-up when the model routes %s to small talk",
    async (text) => {
      const now = () => new Date("2026-07-08T00:00:00.000Z");
      const conversationWindowStore = new InMemoryConversationWindowStore({ now });
      await conversationWindowStore.recordFunctionContext({
        scope: {
          profileName: "helper",
          sourceKey: "group:C1",
          requesterUserId: "U1"
        },
        functionName: "query_schedule",
        arguments: {
          date: "2026-07-14",
          meeting: "晨更",
          availableRoles: ["音控", "導播", "前攝影"]
        },
        resultReferences: {
          kind: "schedule_read_model",
          sourceKeys: ["media_team_service_schedule"]
        },
        ttlMs: 60_000
      });
      const handler = vi.fn<FunctionHandler>().mockResolvedValue({
        ok: true,
        replyText: `${text.replace(/是誰$/u, "")}：測試同工`
      });
      const runtime = createRuntime({
        router: {
          route: vi.fn().mockResolvedValue({
            type: "respond",
            action: "small_talk",
            arguments: { category: "wellbeing" },
            provider: "ollama"
          })
        },
        functionRegistry: { query_schedule: handler },
        conversationWindowStore
      });

      await runtime.handleTextTurn({
        profile: profile(["query_schedule"], {
          generalAgent: { enabled: true, conversationWindowSeconds: 60 }
        }),
        event: textEvent(text),
        requestId: `req-protected-${text}`
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: text,
          date: "2026-07-14",
          meeting: "晨更",
          role: text.replace(/是誰$/u, "")
        }),
        expect.objectContaining({
          continuation: expect.objectContaining({ functionName: "query_schedule" })
        })
      );
    }
  );

  it("does not turn a greeting into a schedule follow-up", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    await conversationWindowStore.recordFunctionContext({
      scope: { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" },
      functionName: "query_schedule",
      arguments: { date: "2026-07-14", meeting: "晨更" },
      ttlMs: 60_000
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "respond",
          action: "small_talk",
          arguments: { category: "greeting" },
          provider: "ollama"
        })
      },
      functionRegistry: { query_schedule: handler },
      conversationWindowStore
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      }),
      event: textEvent("你好"),
      requestId: "req-greeting-with-continuation"
    });

    expect(result?.ok).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not turn unrelated short small talk into a schedule role", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    await conversationWindowStore.recordFunctionContext({
      scope: { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" },
      functionName: "query_schedule",
      arguments: {
        date: "2026-07-14",
        meeting: "晨更",
        availableRoles: ["音控", "導播", "前攝影"]
      },
      ttlMs: 60_000
    });
    const handler = vi.fn<FunctionHandler>();
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "respond",
          action: "small_talk",
          arguments: { category: "wellbeing" },
          provider: "ollama"
        })
      },
      functionRegistry: { query_schedule: handler },
      conversationWindowStore
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      }),
      event: textEvent("最近好累"),
      requestId: "req-unrelated-small-talk"
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("protects an explicit date change inside an active schedule continuation", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    await conversationWindowStore.recordFunctionContext({
      scope: { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" },
      functionName: "query_schedule",
      arguments: { date: "2026-07-14", meeting: "晨更" },
      ttlMs: 60_000
    });
    const handler = vi
      .fn<FunctionHandler>()
      .mockResolvedValue({ ok: true, replyText: "明天的服事表" });
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "respond",
          action: "small_talk",
          arguments: { category: "wellbeing" },
          provider: "ollama"
        })
      },
      functionRegistry: { query_schedule: handler },
      conversationWindowStore
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      }),
      event: textEvent("明天呢"),
      requestId: "req-schedule-date-change"
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ query: "明天呢", dateIntent: "tomorrow", meeting: "晨更" }),
      expect.anything()
    );
  });

  it("keeps the canonical anchor when a follow-up has no result", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
    await conversationWindowStore.recordFunctionContext({
      scope,
      functionName: "query_schedule",
      arguments: { date: "2026-07-14", meeting: "晨更" },
      resultReferences: {
        kind: "schedule_read_model",
        sourceKeys: ["media_team_service_schedule"]
      },
      ttlMs: 60_000
    });
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "execute",
          action: "query_schedule",
          arguments: { query: "不存在的角色" },
          provider: "ollama"
        })
      },
      functionRegistry: {
        query_schedule: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "查不到符合的服事表。"
        })
      },
      conversationWindowStore
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      }),
      event: textEvent("不存在的角色"),
      requestId: "req-no-result-follow-up"
    });

    await expect(conversationWindowStore.functionContext(scope)).resolves.toEqual(
      expect.objectContaining({
        arguments: { date: "2026-07-14", meeting: "晨更" },
        resultReferences: {
          kind: "schedule_read_model",
          sourceKeys: ["media_team_service_schedule"]
        }
      })
    );
  });

  it("clears the prior anchor after a successful different function", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
    await conversationWindowStore.recordFunctionContext({
      scope,
      functionName: "query_schedule",
      arguments: { date: "2026-07-14" },
      ttlMs: 60_000
    });
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "execute",
          action: "query_wikipedia",
          arguments: { query: "台灣" },
          provider: "ollama"
        })
      },
      functionRegistry: {
        query_wikipedia: vi.fn().mockResolvedValue({ ok: true, replyText: "台灣資料" })
      },
      conversationWindowStore
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule", "query_wikipedia"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      }),
      event: textEvent("查台灣"),
      requestId: "req-switch-function"
    });

    await expect(conversationWindowStore.functionContext(scope)).resolves.toBeUndefined();
  });

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
    expect(result?.quickReplies).toBeUndefined();
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

  it("answers identity questions through the configured persona generator", async () => {
    const generator: TextGenerationProvider = {
      providerName: "deepseek",
      completeText: vi.fn().mockResolvedValue("我是小哈，是家教會裡溫暖又可靠的小幫手。")
    };
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "introduce_bot",
      arguments: { variant: "identity" },
      provider: "ollama"
    });
    const runtime = createRuntime({ router: { route }, textGenerator: generator });

    const result = await runtime.handleTextTurn({
      profile: profile([], {
        smallTalk: {
          mode: "llm",
          maxChars: 80,
          prompting: {
            personaPrompt: "你是小哈，家教會的小幫手。",
            conversationRulesPrompt: "自然回答。",
            safetyRulesPrompt: "不要編造。",
            formatRulesPrompt: "使用繁體中文。"
          }
        }
      }),
      event: textEvent("小哈你是誰"),
      requestId: "req-identity"
    });

    expect(result?.replyText).toBe("我是小哈，是家教會裡溫暖又可靠的小幫手。");
    expect(generator.completeText).toHaveBeenCalledWith(
      expect.objectContaining({ category: "persona", text: "小哈你是誰" })
    );
  });

  it("executes a schedule mutation without asking for full schedule content", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "save_schedule",
      arguments: {
        operation: "delete_entry",
        targetQuery: "世緯家園",
        content: ""
      },
      provider: "keyword"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "請確認要刪除這筆服事"
    });
    const runtime = createRuntime({
      router: { route },
      functionRegistry: { save_schedule: handler },
      sessionStore: new InMemorySessionStore()
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["save_schedule"]),
      event: textEvent("小哈刪除世緯家園7/17晨更"),
      requestId: "req-delete-schedule-entry"
    });

    expect(result?.replyText).toContain("確認要刪除");
    expect(handler).toHaveBeenCalledOnce();
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

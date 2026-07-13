import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../agent/agent-runtime.js";
import {
  createControlledAgentRouter,
  type ControlledAgentRouter
} from "../agent/controlled-agent-router.js";
import { InMemoryConversationWindowStore, type ContextManager } from "../agent/context-manager.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import {
  createQueryKnowledgeHandler,
  createQueryKnowledgeTextMessageHandler
} from "../functions/query-knowledge.js";
import { createKnowledgeRetrievalEvidenceProvider } from "../knowledge/retrieval-evidence.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";
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
  NotionDatabaseClient,
  TextMessageHandlerRegistry,
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

function notionSchedulePage(
  id: string,
  date: string,
  meeting: string,
  role: string,
  person: string
) {
  return {
    id,
    properties: {
      日期: { type: "date", date: { start: date } },
      聚會: { type: "rich_text", rich_text: [{ plain_text: meeting }] },
      角色: { type: "rich_text", rich_text: [{ plain_text: role }] },
      同工: { type: "rich_text", rich_text: [{ plain_text: person }] }
    }
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
  controlledAgentRouter?: ControlledAgentRouter;
  textMessageHandlers?: TextMessageHandlerRegistry;
  controlledShadowObserver?: (event: {
    disposition: string;
    reasonCode?: string;
  }) => void | Promise<void>;
  contextManager?: ContextManager;
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
    textMessageHandlers: options.textMessageHandlers ?? {},
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
    contextManager: options.contextManager,
    controlledAgentRouter: options.controlledAgentRouter,
    controlledShadowObserver: options.controlledShadowObserver,
    now
  });
}

describe("AgentTurnRuntime", () => {
  it("continues an opaque requester-scoped knowledge source selection from numeric text", async () => {
    const now = () => new Date("2026-07-08T00:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now });
    const knowledgeStore = new InMemoryKnowledgeStore(now);
    const sources = [];
    for (const sourceKey of ["alpha", "beta"]) {
      const source = await knowledgeStore.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} 手冊`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await knowledgeStore.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} 文件`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [
          {
            headingPath: [],
            ordinal: 0,
            content: `${sourceKey} 的集合時間是晚上七點。`,
            contentHash: `${sourceKey}-hash`
          }
        ]
      });
      await knowledgeStore.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-08T00:00:00Z"
      });
      sources.push(source);
    }
    await sessionStore.set({
      id: "knowledge-choice",
      type: "selection",
      action: "query_knowledge",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1", userId: "U1" },
      arguments: { query: "集合時間" },
      items: sources.map(({ id }, index) => ({
        id,
        name: `${index === 0 ? "alpha" : "beta"} 手冊`,
        driveId: id
      })),
      expiresAt: "2026-07-08T00:10:00.000Z"
    });
    const route = vi.fn<FunctionRouterPort["route"]>();
    const knowledgeText = createQueryKnowledgeTextMessageHandler({
      store: knowledgeStore,
      sessionStore,
      now
    });
    const runtime = createRuntime({
      router: { route },
      sessionStore,
      textMessageHandlers: { knowledge_numeric_selection: knowledgeText }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_knowledge"]),
      event: textEvent("2"),
      requestId: "knowledge-select"
    });

    expect(result?.replyText).toContain("beta 的集合時間是晚上七點");
    expect(result?.continuation?.resultReferences).toEqual(
      expect.objectContaining({ sourceId: sources[1]!.id })
    );
    expect(JSON.stringify(result?.agentResult)).not.toMatch(/alpha|beta|手冊/iu);
    expect(route).not.toHaveBeenCalled();
    await expect(sessionStore.get("knowledge-choice")).resolves.toBeUndefined();
  });

  it("keeps the legacy router authoritative while controlled routing is disabled", async () => {
    const controlledResolve = vi.fn<ControlledAgentRouter["resolve"]>();
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
      arguments: { query: "主日服事" },
      provider: "ollama"
    });
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({ ok: true, replyText: "legacy" });
    const runtime = createRuntime({
      router: { route: legacyRoute },
      controlledAgentRouter: { resolve: controlledResolve },
      functionRegistry: { query_schedule: handler }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: false,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-controlled-disabled"
    });

    expect(result?.replyText).toBe("legacy");
    expect(legacyRoute).toHaveBeenCalledOnce();
    expect(controlledResolve).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy routing when enabled controlled wiring is unavailable", async () => {
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
      arguments: { query: "主日服事" },
      provider: "ollama"
    });
    const runtime = createRuntime({ router: { route: legacyRoute } });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: true,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-controlled-wiring-missing"
    });

    expect(result?.replyText).toBe("請再告訴我想查哪個功能，以及要找的名稱、日期或主題。");
    expect(legacyRoute).not.toHaveBeenCalled();
  });

  it("does not read or build legacy runtime context for enabled controlled routing", async () => {
    const store = new InMemoryConversationWindowStore();
    const recentTurns = vi
      .spyOn(store, "recentTurns")
      .mockRejectedValue(new Error("legacy recent turns must not be read"));
    const functionContext = vi
      .spyOn(store, "functionContext")
      .mockRejectedValue(new Error("legacy continuation must not be read"));
    const contextManager: ContextManager = {
      build: vi.fn(() => {
        throw new Error("legacy prompt must not be built");
      })
    };
    const controlledResolve = vi.fn<ControlledAgentRouter["resolve"]>().mockResolvedValue({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "主日服事" },
      reasonCode: "explicit_intent"
    });
    const runtime = createRuntime({
      conversationWindowStore: store,
      contextManager,
      controlledAgentRouter: { resolve: controlledResolve },
      functionRegistry: {
        query_schedule: vi.fn().mockResolvedValue({ ok: true, replyText: "controlled" })
      }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: true,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-controlled-no-legacy-context"
    });

    expect(result?.replyText).toBe("controlled");
    expect(recentTurns).not.toHaveBeenCalled();
    expect(functionContext).not.toHaveBeenCalled();
    expect(contextManager.build).not.toHaveBeenCalled();
    expect(controlledResolve).toHaveBeenCalledWith({
      profileName: "helper",
      text: "查主日服事",
      enabledFunctions: ["query_schedule"],
      sourceType: "group",
      activeTask: undefined,
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });
  });

  it("routes a body-only knowledge match end to end without exposing evidence to the planner", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "internal-manual",
      displayName: "內部手冊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "一般資料",
      url: "https://example.test/doc",
      nodes: [],
      chunks: [
        {
          headingPath: [],
          ordinal: 0,
          content: "急救箱位置在辦公室櫃子。",
          contentHash: "body-only"
        }
      ]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: source.sourceKey,
      syncStatus: "ready",
      lastSyncedAt: "2026-07-13T00:00:00Z"
    });
    const evidenceProvider = createKnowledgeRetrievalEvidenceProvider(store);
    const probe = vi.spyOn(evidenceProvider, "probe");
    const propose = vi.fn().mockResolvedValue({
      status: "proposed",
      version: 1,
      disposition: "execute",
      capability: "query_knowledge",
      arguments: { query: "急救箱位置" },
      confidence: 0.95,
      provider: "deepseek",
      attempts: []
    });
    const runtime = createRuntime({
      controlledAgentRouter: createControlledAgentRouter({
        planner: { propose },
        retrievalEvidenceProviders: { knowledge: evidenceProvider }
      }),
      functionRegistry: { query_knowledge: createQueryKnowledgeHandler({ store }) }
    });
    const controlledProfile = profile(["query_knowledge"], {
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });

    const result = await runtime.handleTextTurn({
      profile: controlledProfile,
      event: textEvent("急救箱位置"),
      requestId: "req-body-only-knowledge"
    });
    await runtime.handleTextTurn({
      profile: controlledProfile,
      event: textEvent("你好"),
      requestId: "req-body-only-small-talk"
    });
    await runtime.handleTextTurn({
      profile: profile([], { ...controlledProfile, enabledFunctions: [] }),
      event: textEvent("急救箱位置"),
      requestId: "req-body-only-disabled"
    });

    expect(result?.replyText).toContain("急救箱位置在辦公室櫃子");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({
      profileName: "helper",
      text: "急救箱位置",
      maxSources: 20
    });
    expect(propose.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            capability: "query_knowledge",
            reason: "retrieval_evidence"
          })
        ]
      })
    );
    expect(JSON.stringify(propose.mock.calls[0])).not.toMatch(
      /急救箱位置在辦公室櫃子|一般資料|內部手冊|example\.test|internal-manual|body-only/u
    );
  });

  it("runs shadow routing without changing legacy execution or controlled state", async () => {
    const controlledShadowObserver = vi.fn();
    const controlledResolve = vi.fn<ControlledAgentRouter["resolve"]>().mockResolvedValue({
      disposition: "execute",
      capability: "query_knowledge",
      arguments: { query: "青年出隊" },
      reasonCode: "explicit_intent"
    });
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
      arguments: { query: "主日服事" },
      provider: "ollama"
    });
    const legacyHandler = vi
      .fn<FunctionHandler>()
      .mockResolvedValue({ ok: true, replyText: "legacy authoritative" });
    const controlledHandler = vi
      .fn<FunctionHandler>()
      .mockResolvedValue({ ok: true, replyText: "must not execute" });
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const runtime = createRuntime({
      router: { route: legacyRoute },
      controlledAgentRouter: { resolve: controlledResolve },
      functionRegistry: { query_schedule: legacyHandler, query_knowledge: controlledHandler },
      conversationWindowStore: store,
      controlledShadowObserver
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule", "query_knowledge"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 },
        controlledAgent: {
          enabled: false,
          shadow: true,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-controlled-shadow"
    });

    expect(result?.replyText).toBe("legacy authoritative");
    expect(legacyHandler).toHaveBeenCalledOnce();
    expect(controlledHandler).not.toHaveBeenCalled();
    await expect(
      store.activeTask({ profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" })
    ).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(controlledShadowObserver).toHaveBeenCalledWith({
        disposition: "execute",
        capability: "query_knowledge",
        reasonCode: "explicit_intent"
      })
    );
  });

  it("does not wait for a never-resolving shadow dependency", async () => {
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const runtime = createRuntime({
      router: { route: legacyRoute },
      controlledAgentRouter: { resolve: vi.fn(() => new Promise(() => undefined)) }
    });

    const result = await Promise.race([
      runtime.handleTextTurn({
        profile: profile(["query_schedule"], {
          controlledAgent: {
            enabled: false,
            shadow: true,
            maxCandidates: 3,
            minPlannerConfidence: 0.65
          }
        }),
        event: textEvent("查主日服事"),
        requestId: "req-shadow-never"
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25))
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({ replyText: "目前不支援這個請求。" });
  });

  it("observes a late shadow rejection without delaying or changing the legacy reply", async () => {
    let rejectShadow!: (reason: Error) => void;
    const shadow = new Promise<never>((_resolve, reject) => {
      rejectShadow = reject;
    });
    const controlledShadowObserver = vi.fn();
    const runtime = createRuntime({
      router: {
        route: vi.fn().mockResolvedValue({
          type: "deny",
          reason: "not_matched",
          provider: "ollama"
        })
      },
      controlledAgentRouter: { resolve: vi.fn(() => shadow) },
      controlledShadowObserver
    });
    const turn = runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: false,
          shadow: true,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-shadow-late-rejection"
    });

    const first = await Promise.race([
      turn,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25))
    ]);
    rejectShadow(new Error("late planner failure"));
    await turn;

    expect(first).not.toBe("timeout");
    expect(first).toMatchObject({ replyText: "目前不支援這個請求。" });
    await vi.waitFor(() =>
      expect(controlledShadowObserver).toHaveBeenCalledWith({
        disposition: "clarify",
        capability: undefined,
        reasonCode: "planner_unavailable"
      })
    );
  });

  it("keeps shadow legacy routing authoritative when controlled state reads fail", async () => {
    const store = new InMemoryConversationWindowStore();
    vi.spyOn(store, "activeTask").mockRejectedValue(new Error("redis unavailable"));
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const runtime = createRuntime({
      router: { route: legacyRoute },
      controlledAgentRouter: { resolve: vi.fn() },
      conversationWindowStore: store
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: false,
          shadow: true,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查主日服事"),
      requestId: "req-shadow-store-failure"
    });

    expect(result?.replyText).toBe("目前不支援這個請求。");
    expect(legacyRoute).toHaveBeenCalledOnce();
  });

  it("does not merge legacy continuation fields into a validated controlled plan", async () => {
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    await store.recordFunctionContext({
      scope: { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" },
      functionName: "query_schedule",
      arguments: { role: "音控", meeting: "晨更" },
      ttlMs: 60_000
    });
    const recordFunctionContext = vi.spyOn(store, "recordFunctionContext");
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "主日服事",
      continuation: { arguments: { meeting: "主日" } },
      agentResult: {
        status: "success",
        replyText: "主日服事",
        anchors: { meeting: "主日" },
        supportedOperations: ["continue"]
      }
    });
    const runtime = createRuntime({
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "query_schedule",
          arguments: { query: "主日服事" },
          reasonCode: "explicit_intent"
        })
      },
      conversationWindowStore: store,
      functionRegistry: { query_schedule: handler }
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 },
        controlledAgent: {
          enabled: true,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("主日服事"),
      requestId: "req-controlled-no-legacy-merge"
    });

    expect(handler.mock.calls[0]?.[0]).toEqual({ query: "主日服事" });
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("role");
    expect(handler.mock.calls[0]?.[1]?.continuation).toBeUndefined();
    expect(recordFunctionContext).not.toHaveBeenCalled();
  });

  it.each(["explicit_intent", "deterministic_explicit_intent"] as const)(
    "does not pass active-task anchors to a fresh %s request for the same capability",
    async (reasonCode) => {
      const now = new Date("2026-07-08T00:00:00.000Z");
      const store = new InMemoryConversationWindowStore({ now: () => now });
      const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
      await store.recordActiveTask({
        scope,
        ttlMs: 60_000,
        task: {
          version: 1,
          capability: "query_schedule",
          anchors: { meeting: "晨更", specificDate: "2026-07-14" },
          entities: [{ type: "meeting", key: "晨更", label: "晨更" }],
          supportedOperations: ["continue", "refine"],
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString()
        }
      });
      const handler = vi.fn<FunctionHandler>().mockResolvedValue({
        ok: true,
        replyText: "主日服事",
        agentResult: {
          status: "success",
          replyText: "主日服事",
          anchors: { meeting: "主日" },
          supportedOperations: ["continue"]
        }
      });
      const runtime = createRuntime({
        conversationWindowStore: store,
        controlledAgentRouter: {
          resolve: vi.fn().mockResolvedValue({
            disposition: "execute",
            capability: "query_schedule",
            arguments: { query: "查主日服事", meeting: "主日" },
            reasonCode
          })
        },
        functionRegistry: { query_schedule: handler }
      });

      await runtime.handleTextTurn({
        profile: profile(["query_schedule"], {
          generalAgent: { enabled: true, conversationWindowSeconds: 60 },
          controlledAgent: {
            enabled: true,
            shadow: false,
            maxCandidates: 3,
            minPlannerConfidence: 0.65
          }
        }),
        event: textEvent("查主日服事"),
        requestId: "req-fresh-explicit-schedule"
      });

      expect(handler).toHaveBeenCalledWith(
        { query: "查主日服事", meeting: "主日" },
        expect.objectContaining({ continuation: undefined })
      );
    }
  );

  it.each([
    ["ppt_slide", "find_ppt_slides"],
    ["sheet_music", "find_sheet_music"]
  ] as const)(
    "applies one-shot active-task transitions to numeric %s selections with requester isolation",
    async (resourceType, functionName) => {
      const now = new Date("2026-07-08T00:00:00.000Z");
      const store = new InMemoryConversationWindowStore({ now: () => now });
      const scopeU1 = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
      const scopeU2 = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U2" };
      for (const scope of [scopeU1, scopeU2]) {
        await store.recordActiveTask({
          scope,
          ttlMs: 60_000,
          task: {
            version: 1,
            capability: "query_schedule",
            anchors: { meeting: "主日" },
            entities: [{ type: "meeting", key: "主日", label: "主日" }],
            supportedOperations: ["continue"],
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 60_000).toISOString()
          }
        });
      }
      const runtime = createRuntime({
        conversationWindowStore: store,
        textMessageHandlers: {
          ppt_numeric_selection: {
            matches: () => true,
            handle: vi.fn().mockResolvedValue({
              ok: true,
              replyText: "已選擇投影片",
              agentResource: {
                resourceType,
                title: "已選擇投影片",
                storage: { provider: "graph", driveId: "drive-1", itemId: "item-1" }
              },
              agentResult: {
                status: "success",
                replyText: "已選擇投影片",
                entities: [{ type: "resource", key: "item-1", label: "已選擇資源" }],
                supportedOperations: []
              }
            })
          }
        }
      });

      await runtime.handleTextTurn({
        profile: profile(["query_schedule", functionName], {
          generalAgent: { enabled: true, conversationWindowSeconds: 60 },
          controlledAgent: {
            enabled: true,
            shadow: false,
            maxCandidates: 3,
            minPlannerConfidence: 0.65
          }
        }),
        event: textEvent("1"),
        requestId: `req-numeric-${resourceType}-clears-task`
      });

      await expect(store.activeTask(scopeU1)).resolves.toBeUndefined();
      await expect(store.activeTask(scopeU2)).resolves.toMatchObject({
        capability: "query_schedule",
        anchors: { meeting: "主日" }
      });
    }
  );

  it("clears a prior active task after a structured retrieve-memory switch", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryConversationWindowStore({ now: () => now });
    const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
    await store.recordActiveTask({
      scope,
      ttlMs: 60_000,
      task: {
        version: 1,
        capability: "query_schedule",
        anchors: { meeting: "主日" },
        entities: [],
        supportedOperations: ["continue"],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString()
      }
    });
    const runtime = createRuntime({
      conversationWindowStore: store,
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "retrieve_memory",
          arguments: { query: "主日" },
          reasonCode: "explicit_capability_switch"
        })
      },
      functionRegistry: {
        retrieve_memory: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "找到記憶",
          agentResult: {
            status: "success",
            replyText: "記憶查詢完成。",
            entities: [{ type: "memory", key: "memory-1", label: "已保存資訊" }],
            supportedOperations: []
          }
        })
      }
    });

    await runtime.handleTextTurn({
      profile: profile(["query_schedule", "retrieve_memory"], {
        generalAgent: { enabled: true, conversationWindowSeconds: 60 },
        controlledAgent: {
          enabled: true,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: textEvent("查我記住的主日資訊"),
      requestId: "req-retrieve-memory-clears-task"
    });

    await expect(store.activeTask(scope)).resolves.toBeUndefined();
  });

  it.each([
    [
      "execute",
      {
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "主日服事" },
        reasonCode: "explicit_intent"
      },
      "controlled execution"
    ],
    [
      "clarify",
      { disposition: "clarify", capability: "query_schedule", reasonCode: "missing_required_slot" },
      "要查哪一天、哪一場聚會，或哪一類服事？"
    ],
    ["deny", { disposition: "deny", reasonCode: "planner_denied" }, "目前不支援這個請求。"],
    [
      "chat",
      { disposition: "chat", reasonCode: "no_capability_evidence" },
      "不會啦，我比較適合安靜地幫忙查資料。有明確歌名或聚會範圍時，我會比較快幫上忙。"
    ]
  ] as const)(
    "uses the controlled %s disposition without consulting the legacy router",
    async (_name, plan, replyText) => {
      const legacyRoute = vi.fn<FunctionRouterPort["route"]>();
      const handler = vi
        .fn<FunctionHandler>()
        .mockResolvedValue({ ok: true, replyText: "controlled execution" });
      const runtime = createRuntime({
        router: { route: legacyRoute },
        controlledAgentRouter: { resolve: vi.fn().mockResolvedValue(plan) },
        functionRegistry: { query_schedule: handler }
      });

      const result = await runtime.handleTextTurn({
        profile: profile(["query_schedule"], {
          controlledAgent: {
            enabled: true,
            shadow: false,
            maxCandidates: 3,
            minPlannerConfidence: 0.65
          }
        }),
        event: textEvent(_name === "chat" ? "最近好累" : "查主日服事"),
        requestId: `req-controlled-${_name}`
      });

      expect(result?.replyText).toBe(replyText);
      expect(legacyRoute).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(_name === "execute" ? 1 : 0);
    }
  );

  it("reads active tasks with requester isolation and ignores expired task state", async () => {
    let current = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryConversationWindowStore({ now: () => current });
    await store.recordActiveTask({
      scope: { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" },
      ttlMs: 60_000,
      task: {
        version: 1,
        capability: "query_schedule",
        anchors: { meeting: "晨更" },
        entities: [{ type: "role", key: "front-camera", label: "前攝影" }],
        supportedOperations: ["continue"],
        createdAt: current.toISOString(),
        expiresAt: new Date(current.getTime() + 60_000).toISOString()
      }
    });
    const resolve = vi.fn<ControlledAgentRouter["resolve"]>().mockResolvedValue({
      disposition: "clarify",
      reasonCode: "planner_unavailable"
    });
    const runtime = createRuntime({
      controlledAgentRouter: { resolve },
      conversationWindowStore: store
    });
    const enabledProfile = profile(["query_schedule"], {
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });

    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: { ...textEvent("前攝影"), source: { type: "group", groupId: "C1", userId: "U2" } },
      requestId: "req-isolated-task"
    });
    current = new Date("2026-07-08T00:01:01.000Z");
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("前攝影"),
      requestId: "req-expired-task"
    });

    expect(resolve).toHaveBeenNthCalledWith(1, expect.objectContaining({ activeTask: undefined }));
    expect(resolve).toHaveBeenNthCalledWith(2, expect.objectContaining({ activeTask: undefined }));
  });

  it("stores successful structured state and preserves it on not-found or a missing result envelope", async () => {
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const resolve = vi
      .fn<ControlledAgentRouter["resolve"]>()
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "主日服事" },
        reasonCode: "explicit_intent"
      })
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "下一筆" },
        reasonCode: "active_task_refinement"
      })
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_wikipedia",
        arguments: { query: "Fastify" },
        reasonCode: "explicit_capability_switch"
      });
    const scheduleHandler = vi
      .fn<FunctionHandler>()
      .mockResolvedValueOnce({
        ok: true,
        replyText: "前攝影：姵穎",
        agentResult: {
          status: "success",
          replyText: "前攝影：姵穎",
          anchors: { meeting: "主日" },
          entities: [{ type: "role", key: "front-camera", label: "前攝影" }],
          supportedOperations: ["continue", "refine"]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "找不到下一筆",
        agentResult: { status: "not_found", replyText: "找不到下一筆" }
      });
    const runtime = createRuntime({
      controlledAgentRouter: { resolve },
      conversationWindowStore: store,
      functionRegistry: {
        query_schedule: scheduleHandler,
        query_wikipedia: vi.fn().mockResolvedValue({ ok: true, replyText: "Fastify" })
      }
    });
    const enabledProfile = profile(["query_schedule", "query_wikipedia"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 },
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });
    const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };

    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("查主日服事"),
      requestId: "req-task-success"
    });
    const successfulTask = await store.activeTask(scope);
    expect(successfulTask).toMatchObject({
      capability: "query_schedule",
      anchors: { meeting: "主日" }
    });

    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("下一筆"),
      requestId: "req-task-not-found"
    });
    await expect(store.activeTask(scope)).resolves.toEqual(successfulTask);

    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("查 Fastify"),
      requestId: "req-task-unstructured"
    });
    await expect(store.activeTask(scope)).resolves.toEqual(successfulTask);
  });

  it("passes knowledge source/document/section anchors to a follow-up and lets schedule intent switch", async () => {
    const sectionKey = "a".repeat(64);
    const store = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const resolve = vi
      .fn<ControlledAgentRouter["resolve"]>()
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_knowledge",
        arguments: { query: "第一天去哪裡" },
        reasonCode: "explicit_intent"
      })
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_knowledge",
        arguments: { query: "那幾點集合" },
        reasonCode: "active_task_refinement"
      })
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "那主日音控呢" },
        reasonCode: "explicit_capability_switch"
      });
    const knowledgeHandler = vi
      .fn<FunctionHandler>()
      .mockResolvedValueOnce({
        ok: true,
        replyText: "第一天去日月潭。",
        agentResult: {
          status: "success",
          replyText: "第一天去日月潭。",
          anchors: {
            sourceId: "source-opaque-1",
            documentId: "doc-1",
            sectionKey,
            ordinal: 0
          },
          entities: [
            { type: "source", key: "source-opaque-1", label: "知識來源" },
            { type: "document", key: "doc-1", label: "知識文件" },
            { type: "section", key: sectionKey, label: "知識段落" },
            { type: "ordinal", key: "0", label: "第 1 項" }
          ],
          evidence: [
            {
              kind: "knowledge_section",
              reference: {
                sourceId: "source-opaque-1",
                documentId: "doc-1",
                sectionKey,
                ordinal: 0
              }
            }
          ],
          supportedOperations: ["continue", "refine", "select"]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "08:00 集合。",
        agentResult: {
          status: "success",
          replyText: "08:00 集合。",
          anchors: { sourceId: "source-opaque-1", documentId: "doc-1", sectionKey },
          entities: [{ type: "section", key: sectionKey, label: "知識段落" }],
          supportedOperations: ["continue", "refine", "select"]
        }
      });
    const scheduleHandler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "主日音控：同工",
      agentResult: {
        status: "success",
        replyText: "主日音控：同工",
        anchors: { meeting: "主日" },
        entities: [{ type: "role", key: "音控", label: "音控" }],
        supportedOperations: ["continue", "refine", "advance"]
      }
    });
    const runtime = createRuntime({
      controlledAgentRouter: { resolve },
      conversationWindowStore: store,
      functionRegistry: {
        query_knowledge: knowledgeHandler,
        query_schedule: scheduleHandler
      }
    });
    const enabledProfile = profile(["query_knowledge", "query_schedule"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 },
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });

    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("第一天去哪裡"),
      requestId: "req-knowledge-first"
    });
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("那幾點集合"),
      requestId: "req-knowledge-follow-up"
    });
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("那主日音控呢"),
      requestId: "req-knowledge-switch"
    });

    expect(knowledgeHandler).toHaveBeenNthCalledWith(
      2,
      { query: "那幾點集合" },
      expect.objectContaining({
        continuation: expect.objectContaining({
          functionName: "query_knowledge",
          arguments: expect.objectContaining({
            sourceId: "source-opaque-1",
            documentId: "doc-1",
            sectionKey,
            ordinal: 0
          }),
          resultReferences: expect.objectContaining({
            sourceId: "source-opaque-1",
            documentId: "doc-1",
            sectionKey,
            ordinal: 0
          })
        })
      })
    );
    expect(scheduleHandler).toHaveBeenCalledOnce();
    await expect(
      store.activeTask({ profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" })
    ).resolves.toMatchObject({ capability: "query_schedule", anchors: { meeting: "主日" } });
  });

  it.each(["找不到符合的投影片", "找到多份投影片，請選一份"])(
    "preserves an active task after an unstructured PPT result: %s",
    async (replyText) => {
      const now = new Date("2026-07-08T00:00:00.000Z");
      const store = new InMemoryConversationWindowStore({ now: () => now });
      const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
      await store.recordActiveTask({
        scope,
        task: {
          version: 1,
          capability: "query_schedule",
          anchors: { meeting: "主日" },
          entities: [{ type: "role", key: "front-camera", label: "前攝影" }],
          supportedOperations: ["continue"],
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString()
        },
        ttlMs: 60_000
      });
      const previous = await store.activeTask(scope);
      const runtime = createRuntime({
        conversationWindowStore: store,
        controlledAgentRouter: {
          resolve: vi.fn().mockResolvedValue({
            disposition: "execute",
            capability: "find_ppt_slides",
            arguments: { query: "奇異恩典" },
            reasonCode: "explicit_capability_switch"
          })
        },
        functionRegistry: {
          find_ppt_slides: vi.fn().mockResolvedValue({ ok: true, replyText })
        }
      });

      await runtime.handleTextTurn({
        profile: profile(["query_schedule", "find_ppt_slides"], {
          generalAgent: { enabled: true, conversationWindowSeconds: 60 },
          controlledAgent: {
            enabled: true,
            shadow: false,
            maxCandidates: 3,
            minPlannerConfidence: 0.65
          }
        }),
        event: textEvent("查奇異恩典投影片"),
        requestId: `req-unstructured-${replyText.length}`
      });

      await expect(store.activeTask(scope)).resolves.toEqual(previous);
    }
  );

  it("applies active-task lifecycle to pending-function completions", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now });
    const conversationWindowStore = new InMemoryConversationWindowStore({ now: () => now });
    const scheduleHandler = vi
      .fn<FunctionHandler>()
      .mockResolvedValueOnce({
        ok: true,
        replyText: "前攝影：姵穎",
        agentResult: {
          status: "success",
          replyText: "前攝影：姵穎",
          anchors: { meeting: "主日" },
          entities: [{ type: "role", key: "front-camera", label: "前攝影" }],
          supportedOperations: ["continue"]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "請選一筆",
        agentResult: { status: "ambiguous", replyText: "請選一筆" }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "目前無法查詢",
        agentResult: { status: "unavailable", replyText: "目前無法查詢" }
      });
    const wikipediaHandler = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "Fastify",
      agentResult: { status: "success", replyText: "Fastify", supportedOperations: [] }
    });
    const pendingHandler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { query_schedule: scheduleHandler, query_wikipedia: wikipediaHandler }
    });
    const runtime = createRuntime({
      sessionStore,
      conversationWindowStore,
      textMessageHandlers: { pending_function_answer: pendingHandler }
    });
    const enabledProfile = profile(["query_schedule", "query_wikipedia"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 },
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });
    const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
    const storePending = async (id: string, action: "query_schedule" | "query_wikipedia") =>
      sessionStore.set({
        id,
        type: "pending_function",
        action,
        profileName: "helper",
        requesterUserId: "U1",
        source: { type: "group", groupId: "C1", userId: "U1" },
        arguments: { query: "" },
        expiresAt: new Date(now.getTime() + 60_000).toISOString()
      });

    await storePending("pending-success", "query_schedule");
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("主日服事"),
      requestId: "req-pending-success"
    });
    const successfulTask = await conversationWindowStore.activeTask(scope);
    expect(successfulTask).toMatchObject({
      capability: "query_schedule",
      anchors: { meeting: "主日" }
    });

    await storePending("pending-ambiguous", "query_schedule");
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("下一筆"),
      requestId: "req-pending-ambiguous"
    });
    await expect(conversationWindowStore.activeTask(scope)).resolves.toEqual(successfulTask);

    await storePending("pending-unavailable", "query_schedule");
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("再試一次"),
      requestId: "req-pending-unavailable"
    });
    await expect(conversationWindowStore.activeTask(scope)).resolves.toEqual(successfulTask);

    await storePending("pending-noncontinuable", "query_wikipedia");
    await runtime.handleTextTurn({
      profile: enabledProfile,
      event: textEvent("Fastify"),
      requestId: "req-pending-clear"
    });
    await expect(conversationWindowStore.activeTask(scope)).resolves.toBeUndefined();
  });

  it("rechecks enabled-function and source policy before executing a controlled plan", async () => {
    const handler = vi.fn<FunctionHandler>().mockResolvedValue({ ok: true, replyText: "unsafe" });
    const runtime = createRuntime({
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "query_schedule",
          arguments: { query: "主日服事" },
          reasonCode: "explicit_intent"
        })
      },
      functionRegistry: { query_schedule: handler }
    });
    const controlledProfile = profile([], {
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    });

    const disabled = await runtime.handleTextTurn({
      profile: controlledProfile,
      event: textEvent("查主日服事"),
      requestId: "req-controlled-disabled-capability"
    });
    const unsupportedSource = await runtime.handleTextTurn({
      profile: profile(["query_schedule"], {
        controlledAgent: {
          enabled: true,
          shadow: false,
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        }
      }),
      event: { ...textEvent("查主日服事"), source: { type: "room", roomId: "R1", userId: "U1" } },
      requestId: "req-controlled-source-policy"
    });

    expect(disabled?.replyText).toBe("目前不支援這個請求。");
    expect(unsupportedSource?.replyText).toBe("目前不支援這個請求。");
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps production live Notion roster follow-ups on their originating source", async () => {
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const schedules = new InMemoryScheduleStore();
    for (const [role, assignee] of [
      ["導播", "錯誤導播"],
      ["音控", "錯誤音控"],
      ["前攝影", "錯誤攝影"]
    ]) {
      await schedules.upsertItem({
        profileName: "helper",
        sourceKey: "other_team_schedule",
        origin: "notion",
        externalId: `conflict-${role}`,
        serviceDate: "2026-07-14",
        meeting: "7月14日(二) 晨更",
        role,
        assignee
      });
    }
    const notion: NotionDatabaseClient = {
      queryDatabase: vi
        .fn()
        .mockResolvedValue([
          notionSchedulePage(
            "page-live-roster",
            "2026-07-14",
            "7月14日(二) 晨更",
            "",
            ["音控: 資恆", "導播: 莘凌", "前攝影: 姵穎"].join("\n")
          )
        ])
    };
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
        arguments: { query: "導播是誰", role: "導播" },
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
          notion,
          databaseId: "database-1",
          properties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
          now,
          timeZone: "Asia/Taipei"
        })
      },
      conversationWindowStore
    });
    const botProfile = profile(["query_schedule"], {
      generalAgent: { enabled: true, conversationWindowSeconds: 60 }
    });

    const replies = [];
    for (const [index, text] of [
      "下一場影視團隊服事表",
      "導播是誰",
      "音控是誰",
      "前攝影"
    ].entries()) {
      replies.push(
        await runtime.handleTextTurn({
          profile: botProfile,
          event: textEvent(text),
          requestId: `req-live-origin-${index}`
        })
      );
    }

    expect(replies[0]?.continuation).toMatchObject({
      arguments: {
        scheduleRoute: "live_notion",
        sourceKeys: ["media_team_service_schedule"]
      },
      resultReferences: {
        kind: "notion_schedule",
        sourceKeys: ["media_team_service_schedule"]
      }
    });
    expect(replies[1]?.replyText).toContain("導播：莘凌");
    expect(replies[2]?.replyText).toContain("音控：資恆");
    expect(replies[3]?.replyText).toContain("前攝影：姵穎");
    for (const reply of replies.slice(1)) {
      expect(reply?.replyText).not.toContain("錯誤");
    }
  });

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

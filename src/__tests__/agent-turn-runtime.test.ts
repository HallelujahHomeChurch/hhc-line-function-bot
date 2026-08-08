import { describe, expect, it, vi } from "vitest";

import { createControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import type { ControlledCompletionObserver } from "../application/turn/completion-observer.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import type { AgentPlanner } from "../agent/planner.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { createFindResourceHandler } from "../functions/find-resource.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { MemoryInFlightStore } from "../in-flight/in-flight-store.js";
import type { FirstSuccessStore } from "../observability/first-success-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandler,
  LineEvent,
  RouteObserver,
  RouteObserverEvent
} from "../types.js";

const now = () => new Date("2026-07-14T08:40:00.000Z");

function profile(
  enabledFunctions: BotProfileConfig["enabledFunctions"] = ["query_schedule"]
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
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: {
      meetingWindows: [
        { key: "morning", aliases: ["晨更"], start: "06:30", end: "07:30" },
        { key: "sunday", aliases: ["主日"], start: "10:00", end: "12:30" }
      ]
    },
    generalAgent: { enabled: true, conversationWindowSeconds: 60 }
  };
}

function event(text: string, userId = "U1"): LineEvent {
  return {
    type: "message",
    replyToken: "reply-token",
    source: { type: "group", groupId: "C1", userId },
    message: { type: "text", text }
  };
}

function planner(): AgentPlanner {
  return {
    propose: vi.fn(async ({ text }) => ({
      status: "proposed" as const,
      version: 1 as const,
      disposition: "execute" as const,
      capability: "query_schedule" as const,
      arguments: /音控/u.test(text)
        ? { query: text, role: "音控" }
        : { query: text, dateIntent: "next_meeting" },
      confidence: 0.98,
      provider: "deepseek" as const,
      attempts: []
    }))
  };
}

async function fixture(
  options: {
    firstSuccessStore?: FirstSuccessStore;
    routeObserver?: RouteObserver;
  } = {}
) {
  const schedules = new InMemoryScheduleStore();
  for (const [sourceKey, date, role, assignee] of [
    ["media_team_service_schedule", "2026-07-14", "音控", "已結束同工"],
    ["media_team_service_schedule", "2026-07-17", "音控", "下一場音控"],
    ["media_team_service_schedule", "2026-07-17", "導播", "下一場導播"],
    ["other_team_schedule", "2026-07-17", "音控", "錯誤來源同工"]
  ]) {
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey,
      origin: "notion",
      externalId: `${sourceKey}-${date}-${role}`,
      serviceDate: date,
      meeting: "晨更",
      role,
      assignee
    });
  }
  const conversationWindowStore = new InMemoryConversationWindowStore({ now });
  const lastErrorStore = new InMemoryLastErrorStore(10);
  const querySchedule = createQueryScheduleHandler({
    memoryStore: new InMemoryAgentMemoryStore({ now }),
    scheduleStore: schedules,
    now,
    timeZone: "Asia/Taipei"
  });
  const runtime = createAgentTurnRuntime({
    functionRegistry: {
      query_schedule: querySchedule
    },
    textMessageHandlers: {},
    inFlightStore: new MemoryInFlightStore(),
    lastErrorStore,
    lastRouteStore: new InMemoryLastRouteStore(10),
    conversationWindowStore,
    controlledAgentRouter: createControlledAgentRouter({ planner: planner(), now }),
    firstSuccessStore: options.firstSuccessStore,
    routeObserver: options.routeObserver,
    now,
    timeZone: "Asia/Taipei"
  });
  return { runtime, conversationWindowStore, lastErrorStore, querySchedule };
}

describe("AgentTurnRuntime controlled path", () => {
  it("replays the exact prior resource through the controlled active task instead of a pre-route shortcut", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "xiaoha_database",
      adapterType: "onedrive",
      domain: "general",
      defaultItemKind: "church_document",
      rootLocation: { driveId: "drive-1", folderItemId: "root" },
      enabled: true,
      syncPolicy: { mode: "scheduled" },
      capabilities: { read: ["helper"], write: [] }
    });
    const target = await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "church_document",
      domain: "general",
      title: "牧師師母 50 週年感恩餐會",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "item-1" }
    });
    const createSharingLink = vi
      .fn()
      .mockResolvedValueOnce("https://example.test/first")
      .mockResolvedValueOnce("https://example.test/replayed");
    const planner: AgentPlanner = {
      propose: vi.fn(async ({ text }) => ({
        status: "proposed" as const,
        version: 1 as const,
        disposition: "execute" as const,
        capability: "find_resource" as const,
        arguments: {
          query: text.includes("牧師師母") ? "牧師師母 50 週年" : text
        },
        confidence: 0.98,
        provider: "deepseek" as const,
        attempts: []
      }))
    };
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const runtime = createAgentTurnRuntime({
      functionRegistry: {
        find_resource: createFindResourceHandler({
          catalog,
          graph: {
            listFolderChildren: vi.fn(),
            getItemById: vi.fn(async (_driveId, itemId) => ({ id: itemId, name: "current-item" })),
            createSharingLink
          },
          now
        })
      },
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      conversationWindowStore,
      controlledAgentRouter: createControlledAgentRouter({ planner, now }),
      now
    });

    const first = await runtime.handleTextTurn({
      profile: profile(["find_resource"]),
      event: event("查教會資料 牧師師母 50 週年"),
      requestId: "resource-1"
    });
    const second = await runtime.handleTextTurn({
      profile: profile(["find_resource"]),
      event: event("再給我一次"),
      requestId: "resource-2"
    });

    expect(first?.replyText).toContain("https://example.test/first");
    expect(second?.replyText).toContain("https://example.test/replayed");
    expect(second?.replyText).toContain("牧師師母 50 週年感恩餐會");
    expect(createSharingLink).toHaveBeenLastCalledWith("drive-1", "item-1", expect.any(String));
    expect(
      await conversationWindowStore.activeTask({
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).toMatchObject({
      currentCapability: "find_resource",
      references: { resourceId: target.id, driveId: "drive-1", itemId: "item-1" }
    });
  });

  it("presents a stale catalog snapshot's actual timestamp without leaking it into telemetry or task state", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "xiaoha_database",
      adapterType: "onedrive",
      domain: "general",
      defaultItemKind: "church_document",
      rootLocation: { driveId: "drive-1", folderItemId: "root" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 10 },
      capabilities: { read: ["helper"], write: [] }
    });
    await catalog.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: "0",
      publishedAt: "2026-07-14T08:00:00.000Z",
      items: [
        {
          sourceId: source.id,
          itemKind: "church_document",
          domain: "general",
          title: "較早的教會資料",
          storageRef: { provider: "external_link", url: "https://example.test/stale" }
        }
      ]
    });
    const routeEvents: RouteObserverEvent[] = [];
    const traceStore = new InMemoryAgentTraceStore();
    const conversationWindowStore = new InMemoryConversationWindowStore({ now });
    const runtime = createAgentTurnRuntime({
      functionRegistry: {
        find_resource: createFindResourceHandler({
          catalog,
          graph: { listFolderChildren: vi.fn(), createSharingLink: vi.fn() },
          now
        })
      },
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      conversationWindowStore,
      agentTraceStore: traceStore,
      routeObserver: (observed) => {
        routeEvents.push(observed);
      },
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "find_resource",
          arguments: { query: "較早的教會資料" },
          reasonCode: "explicit_intent"
        })
      },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_resource"]),
      event: event("查教會資料 較早的教會資料"),
      requestId: "stale-resource"
    });
    const activeTask = await conversationWindowStore.activeTask({
      profileName: "helper",
      sourceKey: "group:C1",
      requesterUserId: "U1"
    });
    const traces = await traceStore.list();

    expect(result?.replyText).toContain("資料時間：2026-07-14T08:00:00.000Z");
    expect(result?.diagnostics?.dataAsOf).toBe("2026-07-14T08:00:00.000Z");
    expect(JSON.stringify(result?.agentResult)).not.toContain("2026-07-14T08:00:00.000Z");
    expect(JSON.stringify(routeEvents)).not.toContain("2026-07-14T08:00:00.000Z");
    expect(JSON.stringify(traces)).not.toContain("2026-07-14T08:00:00.000Z");
    expect(JSON.stringify(activeTask)).not.toContain("2026-07-14T08:00:00.000Z");
  });

  it("answers a bare role follow-up from the exact next schedule selected in the prior turn", async () => {
    const { runtime, lastErrorStore } = await fixture();

    const first = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事表"),
      requestId: "turn-1"
    });
    const second = await runtime.handleTextTurn({
      profile: profile(),
      event: event("音控是誰"),
      requestId: "turn-2"
    });

    expect(first?.replyText, JSON.stringify(await lastErrorStore.list())).toContain("7月17日");
    expect(first?.replyText).not.toContain("已結束同工");
    expect(second?.replyText).toBe("音控：下一場音控");
    expect(second?.replyText).not.toContain("錯誤來源同工");
  });

  it("emits first success once after a successful controlled function", async () => {
    const firstSuccessStore = {
      tryMark: vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("existing")
    };
    const events: RouteObserverEvent[] = [];
    const { runtime } = await fixture({
      firstSuccessStore,
      routeObserver: (observed) => {
        events.push(observed);
      }
    });

    const first = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事表"),
      requestId: "first-success-1"
    });
    const second = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事表"),
      requestId: "first-success-2"
    });

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(firstSuccessStore.tryMark).toHaveBeenCalledTimes(2);
    expect(firstSuccessStore.tryMark).toHaveBeenCalledWith(
      {
        profileName: "helper",
        sourceType: "group",
        sourceId: "C1",
        requesterUserId: "U1"
      },
      31_536_000_000
    );
    expect(
      events.filter(
        (observed) => observed.kind === "product_event" && observed.eventName === "first_success"
      )
    ).toEqual([
      expect.objectContaining({
        action: "query_schedule",
        resultClass: "success"
      })
    ]);
    expect(
      events.findIndex((observed) => observed.eventName === "function_completed")
    ).toBeLessThan(events.findIndex((observed) => observed.eventName === "first_success"));
    expect(JSON.stringify(events)).not.toMatch(/C1|U1|下一場影視團隊服事表/u);
  });

  it("keeps the successful reply when first-success marking fails", async () => {
    const events: RouteObserverEvent[] = [];
    const tryMark = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const { runtime } = await fixture({
      firstSuccessStore: {
        tryMark
      },
      routeObserver: (observed) => {
        events.push(observed);
      }
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事表"),
      requestId: "first-success-failed"
    });

    expect(result?.ok).toBe(true);
    expect(result?.replyText).toContain("7月17日");
    expect(tryMark).toHaveBeenCalledTimes(1);
    expect(events.some((observed) => observed.eventName === "first_success")).toBe(false);
  });

  it("answers a complete next-schedule role request in one turn", async () => {
    const { runtime } = await fixture();
    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事音控是誰"),
      requestId: "one-turn"
    });

    expect(result?.replyText).toBe("音控：下一場音控");
    expect(result?.replyText).not.toContain("已結束同工");
    expect(result?.replyText).not.toContain("錯誤來源同工");
  });

  it("does not expose one group requester's active task to another requester", async () => {
    const { runtime } = await fixture();
    await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場影視團隊服事表"),
      requestId: "u1"
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("音控是誰", "U2"),
      requestId: "u2"
    });

    expect(result?.replyText).toBe("目前不支援這個請求。");
    expect(result?.quickReplies).toBeUndefined();
  });

  it("fails closed with a clarification when the controlled planner is unavailable", async () => {
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: { resolve: vi.fn().mockRejectedValue(new Error("offline")) },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場服事"),
      requestId: "planner-down"
    });

    expect(result?.replyText).toContain("請再告訴我");
  });

  it("distinguishes a temporarily unavailable retrieval source from an unclear request", async () => {
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "clarify",
          reasonCode: "retrieval_unavailable"
        })
      },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(["find_resource"]),
      event: event("查教會資料 牧師師母 50 週年"),
      requestId: "retrieval-down"
    });

    expect(result?.replyText).toBe("這項功能目前暫時無法使用，請稍後再試。");
  });

  it("guides a controlled deny to help after the authority decision", async () => {
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "deny",
          reasonCode: "source_not_allowed"
        })
      },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場服事"),
      requestId: "permission-denied"
    });

    expect(result?.replyText).toContain("權限");
    expect(result?.replyText).toContain("/help");
    expect(result?.quickReplies).toEqual([
      {
        label: "查看可用功能",
        action: {
          type: "message",
          label: "查看可用功能",
          text: "/help"
        }
      }
    ]);
  });

  it.each([
    ["function_disabled", "權限", true],
    ["source_not_allowed", "權限", true],
    ["write_evidence_missing", "明確", false],
    ["candidate_not_allowed", "不支援", false],
    ["planner_denied", "不支援", false],
    ["capability_not_agent_enabled", "暫時無法使用", false],
    ["invalid_policy", "處理請求時發生錯誤", false]
  ] as const)(
    "renders validator deny %s through its truthful class",
    async (reasonCode, phrase, hasHelp) => {
      const runtime = createAgentTurnRuntime({
        functionRegistry: {},
        textMessageHandlers: {},
        inFlightStore: new MemoryInFlightStore(),
        lastErrorStore: new InMemoryLastErrorStore(10),
        lastRouteStore: new InMemoryLastRouteStore(10),
        controlledAgentRouter: {
          resolve: vi.fn().mockResolvedValue({
            disposition: "deny",
            reasonCode
          })
        },
        now
      });

      const result = await runtime.handleTextTurn({
        profile: profile(),
        event: event("下一場服事"),
        requestId: `deny-${reasonCode}`
      });

      expect(result?.replyText).toContain(phrase);
      expect(result?.replyText.includes("/help")).toBe(hasHelp);
      expect(Boolean(result?.quickReplies?.some((item) => item.action.type === "message"))).toBe(
        hasHelp
      );
    }
  );

  it("keeps the definition-owned missing-slot prompt with one bounded next action", async () => {
    const sessionStore = new InMemorySessionStore({ now });
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {},
      sessionStore,
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "collect",
          capability: "query_schedule",
          arguments: {},
          reasonCode: "missing_required_slot"
        })
      },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("查服事表"),
      requestId: "missing-input"
    });

    expect(result?.replyText).toContain("要查哪一天、哪一場聚會，或哪一類服事？");
    expect(result?.replyText).toContain("請");
    expect(result?.quickReplies?.map(({ label }) => label)).toEqual(["下一場"]);
  });

  it.each([
    ["not_found", "換一個關鍵字"],
    ["unavailable", "稍後再試"],
    ["stale_allowed", "資料時間"]
  ] as const)(
    "maps the controlled %s result without changing its envelope",
    async (state, phrase) => {
      const agentResult = {
        status: state === "stale_allowed" ? ("success" as const) : state,
        replyText: "受控結果",
        anchors: { scheduleId: "opaque-schedule" },
        supportedOperations: ["continue"]
      };
      const responseData = {
        kind: "schedule",
        fields: { role: "音控", people: "小明" }
      };
      const handler = vi.fn<FunctionHandler>().mockResolvedValue({
        ok: true,
        replyText: "聚焦結果",
        agentResult,
        responseData,
        ...(state === "stale_allowed"
          ? {
              diagnostics: {
                executionMode: "catalog_snapshot_read" as const,
                freshnessStatus: "stale_allowed" as const,
                dataAsOf: "2026-07-14T08:00:00.000Z"
              }
            }
          : {})
      });
      const firstSuccessStore = { tryMark: vi.fn().mockResolvedValue("first") };
      const runtime = createAgentTurnRuntime({
        functionRegistry: { query_schedule: handler },
        textMessageHandlers: {},
        inFlightStore: new MemoryInFlightStore(),
        lastErrorStore: new InMemoryLastErrorStore(10),
        lastRouteStore: new InMemoryLastRouteStore(10),
        controlledAgentRouter: {
          resolve: vi.fn().mockResolvedValue({
            disposition: "execute",
            capability: "query_schedule",
            arguments: { query: "下一場服事" },
            reasonCode: "explicit_intent"
          })
        },
        firstSuccessStore,
        now
      });

      const result = await runtime.handleTextTurn({
        profile: profile(),
        event: event("下一場服事"),
        requestId: `result-${state}`
      });

      expect(result?.replyText).toContain(phrase);
      if (state === "stale_allowed") {
        expect(result?.replyText).toContain("資料時間：2026-07-14T08:00:00.000Z");
      }
      expect(result?.agentResult).toBe(agentResult);
      expect(result?.responseData).toBe(responseData);
      expect(result?.quickReplies).toBeUndefined();
      expect(firstSuccessStore.tryMark).toHaveBeenCalledTimes(state === "stale_allowed" ? 1 : 0);
    }
  );

  it("keeps safe execution-error copy without suggesting a retry action", async () => {
    const runtime = createAgentTurnRuntime({
      functionRegistry: {
        query_schedule: vi.fn<FunctionHandler>().mockRejectedValue(new Error("private details"))
      },
      textMessageHandlers: {},
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "query_schedule",
          arguments: { query: "下一場服事" },
          reasonCode: "explicit_intent"
        })
      },
      now
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場服事"),
      requestId: "execution-error"
    });

    expect(result?.replyText).toContain("支援碼");
    expect(result?.replyText).not.toContain("private details");
    expect(result?.quickReplies).toBeUndefined();
  });

  it("collects missing write content and uses the next requester reply", async () => {
    const sessionStore = new InMemorySessionStore({ now });
    const traceStore = new InMemoryAgentTraceStore(10);
    const saveSchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "服事表預覽"
    });
    const writePlanner: AgentPlanner = {
      propose: vi.fn().mockResolvedValue({
        status: "proposed",
        version: 1,
        disposition: "clarify",
        capability: "save_schedule",
        arguments: {},
        confidence: 0.98,
        provider: "deepseek",
        attempts: []
      })
    };
    const runtime = createAgentTurnRuntime({
      functionRegistry: { save_schedule: saveSchedule },
      textMessageHandlers: {
        pending_function_answer: createPendingFunctionTextMessageHandler({
          sessionStore,
          functions: { save_schedule: saveSchedule }
        })
      },
      sessionStore,
      traceStore,
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: createControlledAgentRouter({ planner: writePlanner, now }),
      now
    });

    const first = await runtime.handleTextTurn({
      profile: profile(["save_schedule"]),
      event: event("幫我記服事表"),
      requestId: "collect-write"
    });

    expect(first?.replyText).toBe("請貼上要記住的服事表文字內容。");
    expect(saveSchedule).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });
    await expect(traceStore.list()).resolves.toEqual([
      expect.objectContaining({
        supportId: expect.stringMatching(/^[a-f0-9]{16}$/u),
        steps: expect.arrayContaining([
          expect.objectContaining({
            phase: "controlled_route",
            outcome: "collect",
            action: "save_schedule"
          }),
          expect.objectContaining({ phase: "slot_clarification", action: "save_schedule" })
        ])
      })
    ]);

    const second = await runtime.handleTextTurn({
      profile: profile(["save_schedule"]),
      event: event("七/17五世緯家園"),
      requestId: "answer-write"
    });

    expect(second?.replyText).toBe("服事表預覽");
    expect(saveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ content: "七/17五世緯家園" }),
      expect.any(Object)
    );
  });

  it("stores and resumes a cross-capability choice through the controlled router", async () => {
    const sessionStore = new InMemorySessionStore({ now });
    const querySchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "晨更家族：中平家族"
    });
    const retrieveMemory = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "記憶內容"
    });
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        disposition: "clarify",
        reasonCode: "capability_evidence_unresolved",
        candidateCapabilities: ["query_schedule", "retrieve_memory"]
      })
      .mockResolvedValueOnce({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "7/21 晨更家族是誰", meeting: "晨更" },
        reasonCode: "deterministic_explicit_intent"
      });
    const runtime = createAgentTurnRuntime({
      functionRegistry: {
        query_schedule: querySchedule,
        retrieve_memory: retrieveMemory
      },
      textMessageHandlers: {},
      sessionStore,
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: { resolve },
      now
    });

    const first = await runtime.handleTextTurn({
      profile: profile(["query_schedule", "retrieve_memory"]),
      event: event("7/21 晨更家族是誰"),
      requestId: "ambiguous-1"
    });
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_capability_resolution: 1 }
    });
    const second = await runtime.handleTextTurn({
      profile: profile(["query_schedule", "retrieve_memory"]),
      event: event("查服事表"),
      requestId: "ambiguous-2"
    });

    expect(first?.quickReplies?.map(({ label }) => label)).toEqual(["查服事表", "查記住的資訊"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "7/21 晨更家族是誰",
        enabledFunctions: ["query_schedule"]
      })
    );
    expect(querySchedule).toHaveBeenCalledOnce();
    expect(retrieveMemory).not.toHaveBeenCalled();
    expect(second?.replyText).toBe("晨更家族：中平家族");
  });

  it("invokes the shared completion boundary exactly once for direct execution", async () => {
    const complete = vi.fn<ControlledCompletionObserver["complete"]>(async ({ result }) => result);
    const runtime = createAgentTurnRuntime({
      functionRegistry: {
        query_schedule: vi.fn<FunctionHandler>().mockResolvedValue({
          ok: true,
          replyText: "服事表結果",
          agentResult: { status: "success", replyText: "服事表結果" }
        })
      },
      textMessageHandlers: {},
      completionObserver: { complete },
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      controlledAgentRouter: {
        resolve: vi.fn().mockResolvedValue({
          disposition: "execute",
          capability: "query_schedule",
          arguments: { query: "下一場" },
          reasonCode: "explicit_intent"
        })
      },
      now
    });

    await runtime.handleTextTurn({
      profile: profile(),
      event: event("下一場服事"),
      requestId: "direct-completion"
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ action: "query_schedule", durationMs: expect.any(Number) })
    );
  });

  it("invokes the shared completion boundary exactly once for an executed text continuation", async () => {
    const complete = vi.fn<ControlledCompletionObserver["complete"]>(async ({ result }) => result);
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {
        confirm_memory: {
          turnStage: "pending_function",
          matches: async () => true,
          handle: async () => ({
            ok: true,
            replyText: "已保存",
            executedAction: "save_memory",
            writePhase: "commit",
            agentResult: { status: "success", replyText: "已保存" }
          })
        }
      },
      completionObserver: { complete },
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      now
    });

    await runtime.handleTextTurn({
      profile: profile(["save_memory"]),
      event: event("保存"),
      requestId: "continuation-completion"
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ action: "save_memory", durationMs: expect.any(Number) })
    );
  });

  it("reauthorizes a restricted pending function before its continuation handler", async () => {
    const sessionStore = new InMemorySessionStore({ now });
    const saveMemory = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "已保存"
    });
    await sessionStore.set({
      id: "pending-restricted",
      type: "pending_function",
      action: "save_memory",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1", userId: "U1" },
      arguments: { content: "測試" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const authorizeFunctions = vi.fn().mockResolvedValue([]);
    const runtime = createAgentTurnRuntime({
      functionRegistry: { save_memory: saveMemory },
      textMessageHandlers: {
        pending_function: createPendingFunctionTextMessageHandler({
          sessionStore,
          functions: { save_memory: saveMemory }
        })
      },
      sessionStore,
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      now
    });
    const restrictedProfile = profile(["save_memory"]);
    restrictedProfile.permissionRequiredFunctions = ["save_memory"];

    const result = await runtime.handleTextTurn({
      profile: restrictedProfile,
      event: event("保存"),
      requestId: "restricted-continuation",
      authorizeFunctions
    });

    expect(authorizeFunctions).toHaveBeenCalledOnce();
    expect(authorizeFunctions).toHaveBeenCalledWith(["save_memory"]);
    expect(saveMemory).not.toHaveBeenCalled();
    expect(result?.replyText).not.toBe("已保存");
  });

  it("restores an allowed restricted pending function into the continuation profile", async () => {
    const sessionStore = new InMemorySessionStore({ now });
    const saveMemory = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "已保存"
    });
    await sessionStore.set({
      id: "pending-restricted-allowed",
      type: "pending_function",
      action: "save_memory",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1", userId: "U1" },
      arguments: { content: "測試" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const authorizeFunctions = vi.fn().mockResolvedValue(["save_memory"]);
    const runtime = createAgentTurnRuntime({
      functionRegistry: { save_memory: saveMemory },
      textMessageHandlers: {
        pending_function: createPendingFunctionTextMessageHandler({
          sessionStore,
          functions: { save_memory: saveMemory }
        })
      },
      sessionStore,
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      now
    });
    const restrictedEffectiveProfile = profile([]);
    restrictedEffectiveProfile.permissionRequiredFunctions = ["save_memory"];

    const result = await runtime.handleTextTurn({
      profile: restrictedEffectiveProfile,
      event: event("保存"),
      requestId: "restricted-continuation-allowed",
      authorizeFunctions
    });

    expect(authorizeFunctions).toHaveBeenCalledWith(["save_memory"]);
    expect(saveMemory).toHaveBeenCalledOnce();
    expect(result?.replyText).toBe("已保存");
  });

  it("authorizes a capability-owned text entrance before matching its handler", async () => {
    const activation = vi.fn().mockResolvedValue({ ok: true, replyText: "請上傳檔案" });
    const authorizeFunctions = vi.fn().mockResolvedValue(["save_resource"]);
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {
        upload_activation: {
          turnStage: "attachment",
          capability: "save_resource",
          matches: (_request, context) =>
            context.profile.enabledFunctions.includes("save_resource"),
          handle: activation
        }
      },
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      now
    });
    const restrictedEffectiveProfile = profile([]);
    restrictedEffectiveProfile.permissionRequiredFunctions = ["save_resource"];

    const result = await runtime.handleTextTurn({
      profile: restrictedEffectiveProfile,
      event: event("小哈我要上傳檔案"),
      requestId: "restricted-text-entrance",
      authorizeFunctions
    });

    expect(authorizeFunctions).toHaveBeenCalledWith(["save_resource"]);
    expect(activation).toHaveBeenCalledOnce();
    expect(result?.replyText).toBe("請上傳檔案");
  });

  it("fails a denied capability-owned text entrance closed", async () => {
    const activation = vi.fn().mockResolvedValue({ ok: true, replyText: "請上傳檔案" });
    const authorizeFunctions = vi.fn().mockResolvedValue([]);
    const runtime = createAgentTurnRuntime({
      functionRegistry: {},
      textMessageHandlers: {
        upload_activation: {
          turnStage: "attachment",
          capability: "save_resource",
          matches: (_request, context) =>
            context.profile.enabledFunctions.includes("save_resource"),
          handle: activation
        }
      },
      inFlightStore: new MemoryInFlightStore(),
      lastErrorStore: new InMemoryLastErrorStore(10),
      lastRouteStore: new InMemoryLastRouteStore(10),
      now
    });
    const restrictedEffectiveProfile = profile([]);
    restrictedEffectiveProfile.permissionRequiredFunctions = ["save_resource"];

    await runtime.handleTextTurn({
      profile: restrictedEffectiveProfile,
      event: event("小哈我要上傳檔案"),
      requestId: "restricted-text-entrance-denied",
      authorizeFunctions
    });

    expect(authorizeFunctions).toHaveBeenCalledWith(["save_resource"]);
    expect(activation).not.toHaveBeenCalled();
  });
});

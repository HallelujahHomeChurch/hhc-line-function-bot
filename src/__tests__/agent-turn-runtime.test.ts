import { describe, expect, it, vi } from "vitest";

import { createControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import type { AgentPlanner } from "../agent/planner.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { createFindResourceHandler } from "../functions/find-resource.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { MemoryInFlightStore } from "../in-flight/in-flight-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { BotProfileConfig, FunctionHandler, LineEvent } from "../types.js";

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
    allowedProviders: ["ollama", "deepseek"],
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

async function fixture() {
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
          graph: { listFolderChildren: vi.fn(), createSharingLink },
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

    expect(result?.replyText).toBe("資料來源暫時無法查詢，請稍後再試。");
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
        requestId: "present",
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
});

import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { createFunctionCompletionObserver } from "../observability/function-completion.js";
import type { FunctionHandlerContext, RouteObserverEvent } from "../types.js";

function context(): FunctionHandlerContext {
  return {
    profile: {
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
      enabledFunctions: ["save_memory", "find_resource"]
    },
    event: {
      type: "message",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", text: "保存" }
    },
    requestId: "completion-1"
  };
}

describe("controlled completion observer", () => {
  it("records group summary, completion, first success, and write events once per completion", async () => {
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "C1",
      createdBy: "Uadmin"
    });
    const events: RouteObserverEvent[] = [];
    const firstSuccessStore = {
      tryMark: vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("existing")
    };
    const observer = createFunctionCompletionObserver({
      accessStore,
      firstSuccessStore,
      routeObserver: (event) => {
        events.push(event);
      },
      now: () => new Date("2026-07-27T01:00:00.000Z")
    });
    const result = {
      ok: true,
      replyText: "已保存",
      executedAction: "save_memory" as const,
      writePhase: "commit" as const,
      agentResult: {
        status: "success" as const,
        replyText: "已保存",
        anchors: { memoryId: "opaque-memory" }
      }
    };

    await observer.complete({ context: context(), action: "save_memory", result, durationMs: 20 });
    await observer.complete({ context: context(), action: "save_memory", result, durationMs: 30 });

    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      {
        type: "group",
        principalId: "C1",
        lastSuccessCapabilityName: "save_memory",
        lastSuccessAt: "2026-07-27T01:00:00.000Z"
      }
    ]);
    expect(firstSuccessStore.tryMark).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.eventName === "function_completed")).toHaveLength(2);
    expect(events.filter((event) => event.eventName === "first_success")).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "write_committed")).toHaveLength(2);
  });

  it("uses presentation-only stale data without emitting its timestamp", async () => {
    const events: RouteObserverEvent[] = [];
    const observer = createFunctionCompletionObserver({
      routeObserver: (event) => {
        events.push(event);
      }
    });

    const result = await observer.complete({
      context: context(),
      action: "find_resource",
      result: {
        ok: true,
        replyText: "較早的結果",
        agentResult: { status: "success", replyText: "較早的結果" },
        diagnostics: {
          executionMode: "catalog_snapshot_read",
          freshnessStatus: "stale_allowed",
          dataAsOf: "2026-07-20T00:00:00.000Z"
        }
      }
    });

    expect(result.replyText).toContain("資料時間：2026-07-20T00:00:00.000Z");
    expect(JSON.stringify(events)).not.toContain("2026-07-20T00:00:00.000Z");
  });

  it("keeps the guided reply when observational stores fail", async () => {
    const accessStore = new InMemoryAccessStore();
    vi.spyOn(accessStore, "recordPrincipalSuccess").mockRejectedValue(new Error("offline"));
    const observer = createFunctionCompletionObserver({
      accessStore,
      firstSuccessStore: { tryMark: vi.fn().mockRejectedValue(new Error("offline")) },
      routeObserver: vi.fn().mockRejectedValue(new Error("offline"))
    });

    await expect(
      observer.complete({
        context: context(),
        action: "find_resource",
        result: {
          ok: true,
          replyText: "結果",
          agentResult: { status: "success", replyText: "結果" }
        }
      })
    ).resolves.toMatchObject({ ok: true, replyText: "結果" });
  });
});

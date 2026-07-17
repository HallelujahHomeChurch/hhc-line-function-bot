import { describe, expect, it, vi } from "vitest";

import { applyActiveTaskTransition } from "../agent/active-task-transition.js";
import type { ConversationWindowStore } from "../agent/context-manager.js";

const now = new Date("2026-07-16T12:00:00.000Z");
const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };

function store() {
  return {
    recordActiveTask: vi.fn(),
    clearActiveTask: vi.fn()
  } as unknown as ConversationWindowStore;
}

describe("declarative task handoffs", () => {
  it("turns a confirmed schedule write into a query-schedule task", async () => {
    const target = store();
    await expect(
      applyActiveTaskTransition({
        store: target,
        scope,
        capability: "save_schedule",
        enabledFunctions: ["save_schedule", "query_schedule"],
        result: {
          ok: true,
          replyText: "已保存",
          writePhase: "commit",
          agentResult: {
            status: "success",
            replyText: "已保存",
            anchors: { scheduleType: "morning_prayer_family" },
            entities: [{ type: "scheduleType", key: "morning_prayer_family", label: "晨更服事" }]
          }
        },
        now,
        ttlMs: 600_000
      })
    ).resolves.toBe("write");

    expect(target.recordActiveTask).toHaveBeenCalledWith({
      scope,
      ttlMs: 600_000,
      task: expect.objectContaining({
        currentCapability: "query_schedule",
        allowedCapabilities: ["query_schedule"],
        anchors: { scheduleType: "morning_prayer_family" }
      })
    });
  });

  it("does not hand off to a read function that is no longer enabled", async () => {
    const target = store();
    await applyActiveTaskTransition({
      store: target,
      scope,
      capability: "save_memory",
      enabledFunctions: ["save_memory"],
      result: {
        ok: true,
        replyText: "已記住",
        writePhase: "commit",
        agentResult: {
          status: "success",
          replyText: "已記住",
          anchors: { memoryId: "memory-1" },
          entities: [{ type: "memory", key: "memory-1", label: "已保存資訊" }]
        }
      },
      now,
      ttlMs: 600_000
    });

    expect(target.recordActiveTask).not.toHaveBeenCalled();
  });

  it("hands a saved general resource to exact catalog lookup", async () => {
    const target = store();
    await expect(
      applyActiveTaskTransition({
        store: target,
        scope,
        capability: "save_resource",
        enabledFunctions: ["save_resource", "find_resource"],
        result: {
          ok: true,
          replyText: "已保存",
          writePhase: "commit",
          agentResult: {
            status: "success",
            replyText: "已保存",
            anchors: {
              resourceId: "11111111-1111-4111-8111-111111111111",
              resourceKind: "resource",
              title: "牧師師母 50 週年"
            },
            entities: [
              {
                type: "resource",
                key: "11111111-1111-4111-8111-111111111111",
                label: "已保存資源"
              }
            ]
          }
        },
        now,
        ttlMs: 600_000
      })
    ).resolves.toBe("write");

    expect(target.recordActiveTask).toHaveBeenCalledWith({
      scope,
      ttlMs: 600_000,
      task: expect.objectContaining({
        currentCapability: "find_resource",
        anchors: {
          query: "牧師師母 50 週年",
          resourceId: "11111111-1111-4111-8111-111111111111"
        }
      })
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { helperProfile } from "../evals/synthetic-runtime-fixture.js";
import { signLineBody } from "../line-signature.js";
import { createTestApp } from "../testing/create-test-app.js";
import type { AppConfig, FunctionExecutionResult } from "../types.js";

const clarification: FunctionExecutionResult = {
  ok: true,
  replyText: "請選擇服事類型",
  agentResult: { status: "ambiguous", replyText: "請選擇服事類型" }
};

describe("helper group clarification wake window", () => {
  it.each([
    { name: "domain ambiguity", result: clarification, elapsed: 90_000, accepted: true },
    {
      name: "missing draft data",
      result: {
        ok: true,
        replyText: "請補充日期",
        writePreparation: "needs_input"
      } as FunctionExecutionResult,
      elapsed: 90_000,
      accepted: true
    },
    {
      name: "ordinary group reply",
      result: { ok: true, replyText: "普通回答，是否還有其他問題？" },
      elapsed: 90_000,
      accepted: false
    },
    { name: "expired clarification", result: clarification, elapsed: 120_001, accepted: false }
  ])("keeps $name bounded and requester scoped", async ({ result, elapsed, accepted }) => {
    let current = new Date("2026-09-04T00:00:00.000Z");
    const profile = {
      ...helperProfile(["query_schedule"]),
      groupRequireWakeWord: true,
      wakeKeywords: ["小哈"],
      generalAgent: { enabled: true, conversationWindowSeconds: 60 }
    };
    const config: AppConfig = {
      serviceName: "synthetic",
      host: "127.0.0.1",
      port: 3000,
      timeZone: "Asia/Taipei",
      healthPath: "/healthz",
      maxBodyBytes: 32_768,
      profiles: [profile]
    };
    const handleTextTurn = vi.fn(async () => result);
    const replies = vi.fn(async () => undefined);
    const window = new InMemoryConversationWindowStore({ now: () => current });
    const app = createTestApp(config, {
      profileRuntime: { handleTextTurn },
      conversationWindowStore: window,
      accessStore: new InMemoryAccessStore({
        principals: [
          {
            id: "synthetic-group",
            profileName: "helper",
            type: "group",
            principalId: "synthetic-group",
            createdAt: current.toISOString(),
            createdBy: "synthetic"
          }
        ]
      }),
      createLineIdentityClient: () => ({
        getUserDisplayName: async () => "合成使用者",
        getGroupDisplayName: async () => undefined
      }),
      createLineReplyClient: () => ({ replyText: replies })
    });
    const send = async (userId: string, text: string) => {
      const body = JSON.stringify({
        destination: "synthetic",
        events: [
          {
            type: "message",
            replyToken: `${userId}-${text}`,
            source: { type: "group", groupId: "synthetic-group", userId },
            message: { type: "text", text }
          }
        ]
      });
      const response = await app.inject({
        method: "POST",
        url: profile.webhookPath,
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineBody(Buffer.from(body), profile.channelSecret)
        },
        payload: body
      });
      expect(response.statusCode).toBe(200);
    };
    try {
      await send("requester-a", "小哈 幫我處理服事資料");
      expect(handleTextTurn).toHaveBeenCalledTimes(1);
      current = new Date(current.getTime() + elapsed);
      await send("requester-b", "晨更");
      expect(handleTextTurn).toHaveBeenCalledTimes(1);
      expect(
        await window.recentTurns(
          {
            profileName: "helper",
            sourceKey: "group:synthetic-group",
            requesterUserId: "requester-b"
          },
          10
        )
      ).toEqual([]);
      await send("requester-a", "晨更");
      expect(handleTextTurn).toHaveBeenCalledTimes(accepted ? 2 : 1);
      expect(replies).toHaveBeenCalledTimes(accepted ? 2 : 1);
    } finally {
      await app.close();
    }
  });
});

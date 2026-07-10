import { describe, expect, it, vi } from "vitest";

import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { FunctionHandler, TextMessageContext } from "../types.js";

const scheduleText = "七/10五黃弘家族2\n七/17五世緯家園";

function context(): TextMessageContext {
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
      enabledFunctions: ["save_schedule"]
    },
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: scheduleText }
    },
    requestId: "answer-request"
  };
}

describe("pending function answers", () => {
  it("fills missing schedule content before interpreting save confirmation", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await sessionStore.set({
      id: "pending-save",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { content: "" },
      expiresAt: "2026-07-10T00:10:00.000Z"
    });
    const saveSchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "preview"
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_schedule: saveSchedule }
    });

    const result = await handler.handle({ text: scheduleText }, context());

    expect(result?.replyText).toBe("preview");
    expect(saveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ content: scheduleText }),
      expect.any(Object)
    );
  });
});

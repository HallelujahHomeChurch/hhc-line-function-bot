import { describe, expect, it, vi } from "vitest";

import { createProfileRuntimeDispatcher } from "../runtime/profile-runtime.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

function turnInput(name: string) {
  const profile: BotProfileConfig = {
    name,
    webhookPath: `/api/line/webhook/${name}`,
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: false,
    enabledFunctions: [],
    permissionRequiredFunctions: [],
    allowedProviders: [],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
  const event: LineEvent = {
    type: "message",
    source: { type: "user", userId: "U1" },
    message: { type: "text", text: "hello" }
  };

  return { profile, event, requestId: "request-1" };
}

describe("profile runtime dispatch", () => {
  it("dispatches each profile to exactly one runtime", async () => {
    const main = { handleTextTurn: vi.fn(async () => ({ ok: true, replyText: "main" })) };
    const helper = { handleTextTurn: vi.fn(async () => ({ ok: true, replyText: "helper" })) };
    const dispatch = createProfileRuntimeDispatcher({ main, helper });

    const result = await dispatch.handleTextTurn(turnInput("helper"));

    expect(result?.replyText).toBe("helper");
    expect(helper.handleTextTurn).toHaveBeenCalledOnce();
    expect(main.handleTextTurn).not.toHaveBeenCalled();
  });
});

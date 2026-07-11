import { describe, expect, it } from "vitest";

import { createQueryClarificationReply } from "../query-clarification.js";
import type { BotProfileConfig } from "../types.js";

function profile(enabledFunctions: BotProfileConfig["enabledFunctions"]): BotProfileConfig {
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
    allowedProviders: ["ollama"],
    allowSubscriptionProviders: false
  };
}

describe("generic query clarification", () => {
  it("asks for a query target and exposes only effective read capabilities", () => {
    const result = createQueryClarificationReply(
      profile(["find_ppt_slides", "query_schedule", "find_sheet_music", "save_schedule"]),
      "小哈，幫我查東西"
    );

    expect(result).toMatchObject({
      ok: true,
      replyText: expect.stringContaining("想查什麼")
    });
    expect(result?.replyText).toContain("名稱、日期或主題");
    expect(result?.replyText).toContain("查投影片");
    expect(result?.replyText).toContain("查服事表");
    expect(result?.replyText).toContain("查歌譜");
    expect(result?.replyText).not.toContain("儲存服事表");
    expect(result?.quickReplies).toBeUndefined();
  });

  it("does not intercept a request that already has a query target", () => {
    expect(
      createQueryClarificationReply(profile(["find_ppt_slides"]), "小哈，幫我查投影片 奇異恩典")
    ).toBeUndefined();
  });
});

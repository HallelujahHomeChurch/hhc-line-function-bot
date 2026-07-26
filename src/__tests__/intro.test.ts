import { describe, expect, it } from "vitest";

import { projectEffectiveCapabilities } from "../application/capabilities/effective-capability-projection.js";
import { createIntroReply } from "../intro.js";
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
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed"
  };
}

function projection(enabledFunctions: BotProfileConfig["enabledFunctions"]) {
  return projectEffectiveCapabilities({
    context: {
      profile: profile(enabledFunctions),
      authorized: true,
      requesterIsAdmin: false,
      sourceType: "user"
    }
  });
}

describe("intro replies", () => {
  it("keeps the identity-only introduction exact", () => {
    const result = createIntroReply(projection([]), "小哈");

    expect(result?.replyText).toBe("我是小哈，家教會的小幫手。");
    expect(result?.quickReplies).toBeUndefined();
  });

  it("renders every projected capability and preferred Quick Replies", () => {
    const result = createIntroReply(
      projection(["find_ppt_slides", "query_schedule", "save_schedule"]),
      "小哈你能做什麼"
    );

    expect(result?.replyText).toContain("可以查詢\n- 查投影片：");
    expect(result?.replyText).toContain("- 查服事表：");
    expect(result?.replyText).toContain("可以保存或更新\n- 記服事表：");
    expect(result?.quickReplies?.map(({ label }) => label)).toEqual(["查服事表", "查投影片"]);
  });

  it("understands capabilities questions with address punctuation", () => {
    const result = createIntroReply(projection(["query_schedule"]), "小哈，你能做什麼？");

    expect(result?.replyText).toContain("我目前可以協助：");
    expect(result?.replyText).toContain("- 查服事表：");
  });

  it("can render the capabilities variant from router metadata", () => {
    const result = createIntroReply(projection(["query_schedule"]), "你好", {
      force: true,
      variant: "capabilities"
    });

    expect(result?.replyText).toContain("我目前可以協助：");
    expect(result?.replyText).toContain("- 查服事表：");
  });

  it("keeps capability presentation deterministic without a random source", () => {
    const effectiveProjection = projection([
      "find_ppt_slides",
      "query_schedule",
      "find_sheet_music"
    ]);
    const first = createIntroReply(effectiveProjection, "小哈你能做什麼");
    const second = createIntroReply(effectiveProjection, "小哈你能做什麼");

    expect(second).toEqual(first);
    expect(first?.quickReplies?.map(({ label }) => label)).toEqual([
      "查服事表",
      "查歌譜",
      "查投影片"
    ]);
  });
});

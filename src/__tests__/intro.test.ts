import { describe, expect, it } from "vitest";

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

describe("intro replies", () => {
  it("introduces Xiaoha and lists all examples when three or fewer functions are enabled", () => {
    const result = createIntroReply(
      profile(["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"]),
      "小哈"
    );

    expect(result?.replyText).toContain(
      "我是小哈，家教會小幫手。需要幫助時可以叫我一聲，我可以：查投影片、查服事表、查流行歌譜。"
    );
    expect(result?.replyText).toContain("你可以試試：");
    expect(result?.replyText).toContain("小哈 查投影片 奇異恩典");
    expect(result?.replyText).toContain("小哈 下一場聚會服事表");
    expect(result?.replyText).toContain("小哈 查流行歌譜 Yesterday");
    expect(result?.quickReplies?.map((item) => item.label)).toEqual([
      "查投影片",
      "查服事表",
      "查流行歌譜"
    ]);
  });

  it("answers capabilities questions without repeating the identity sentence", () => {
    const result = createIntroReply(
      profile(["find_ppt_slides", "query_service_schedule"]),
      "小哈你能做什麼"
    );

    expect(result?.replyText).toContain("我能：查投影片、查服事表。");
    expect(result?.replyText).not.toContain("我是小哈");
    expect(result?.replyText).toContain("你可以試試：");
  });

  it("understands capabilities questions with address punctuation", () => {
    const result = createIntroReply(profile(["query_service_schedule"]), "小哈，你能做什麼？");

    expect(result?.replyText).toContain("我能：查服事表。");
    expect(result?.replyText).not.toContain("我是小哈");
  });

  it("can render the capabilities variant from router metadata", () => {
    const result = createIntroReply(profile(["query_service_schedule"]), "你好", {
      force: true,
      variant: "capabilities"
    });

    expect(result?.replyText).toContain("我能：查服事表。");
    expect(result?.replyText).not.toContain("我是小哈");
  });

  it("keeps examples deterministic for available functions", () => {
    const result = createIntroReply(
      profile(["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"]),
      "小哈"
    );

    expect(result?.replyText).toContain("小哈 查投影片 奇異恩典");
    expect(result?.replyText).toContain("小哈 下一場聚會服事表");
    expect(result?.replyText).toContain("小哈 查流行歌譜 Yesterday");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createControlledSmallTalkReply,
  createSmallTalkReply,
  smallTalkCategoryFromArguments
} from "../small-talk.js";
import type { BotProfileConfig, TextGenerationProvider } from "../types.js";

function profile(overrides: Partial<BotProfileConfig> = {}): BotProfileConfig {
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
    enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed",
    smallTalk: { mode: "template", maxChars: 80 },
    ...overrides
  };
}

describe("small talk replies", () => {
  it("recognizes greeting as a first-class category", () => {
    expect(smallTalkCategoryFromArguments({ category: "greeting" })).toBe("greeting");
    expect(createSmallTalkReply("greeting").replyText).toContain("你好");
  });

  it("recognizes wellbeing as a first-class category", () => {
    expect(smallTalkCategoryFromArguments({ category: "wellbeing" })).toBe("wellbeing");
    expect(createSmallTalkReply("wellbeing").replyText).toContain("我在");
  });

  it("uses controlled LLM generation when the profile enables it", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我在，謝謝你關心，需要查資料再叫我就好。");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { completeText }
    });

    expect(result.replyText).toBe("我在，謝謝你關心，需要查資料再叫我就好。");
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "helper",
        text: "小哈你好嗎",
        category: "wellbeing",
        maxChars: 80
      })
    );
  });

  it("falls back to a template when controlled generation is invalid", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我會使用 Ollama 和 Notion 幫你處理，更多細節請看 https://example.com");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { completeText }
    });

    expect(result.replyText).toBe(createSmallTalkReply("wellbeing").replyText);
  });

  it("allows longer controlled replies from the Codex app-server provider", async () => {
    const reply = "你好，我在這裡。你可以直接說想查哪一份資料，我會先判斷能不能安全地幫你處理。";
    const completeText = vi.fn<TextGenerationProvider["completeText"]>().mockResolvedValue(reply);

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 10 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "codex_app_server", completeText }
    });

    expect(result.replyText).toBe(reply);
  });

  it("keeps template mode when LLM small talk is not enabled", async () => {
    const completeText = vi.fn<TextGenerationProvider["completeText"]>();

    const result = await createControlledSmallTalkReply({
      profile: profile(),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { completeText }
    });

    expect(result.replyText).toBe(createSmallTalkReply("wellbeing").replyText);
    expect(completeText).not.toHaveBeenCalled();
  });
});

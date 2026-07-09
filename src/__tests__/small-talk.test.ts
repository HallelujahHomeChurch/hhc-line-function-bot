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
    allowedProviders: ["ollama"],
    allowSubscriptionProviders: false,
    smallTalk: { mode: "template", maxChars: 80 },
    ...overrides
  };
}

describe("small talk replies", () => {
  it("recognizes greeting as a first-class category", () => {
    expect(smallTalkCategoryFromArguments({ category: "greeting" })).toBe("greeting");
    expect(createSmallTalkReply("greeting").replyText).toBeTruthy();
  });

  it("recognizes wellbeing as a first-class category", () => {
    expect(smallTalkCategoryFromArguments({ category: "wellbeing" })).toBe("wellbeing");
    expect(createSmallTalkReply("wellbeing").replyText).toBeTruthy();
  });

  it("uses controlled LLM generation when the profile enables it", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我在，今天也一起慢慢處理。");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "ollama", completeText }
    });

    expect(result.replyText).toBe("我在，今天也一起慢慢處理。");
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "helper",
        text: "小哈你好嗎",
        category: "wellbeing",
        maxChars: 80
      })
    );
  });

  it("builds small talk prompts from layered profile configuration", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("好啊。");

    await createControlledSmallTalkReply({
      profile: profile({
        smallTalk: {
          mode: "llm",
          maxChars: 80,
          prompting: {
            personaPrompt: "PERSONA_PROMPT",
            conversationRulesPrompt: "CONVERSATION_RULES_PROMPT",
            safetyRulesPrompt: "SAFETY_RULES_PROMPT",
            formatRulesPrompt: "FORMAT_RULES_PROMPT"
          }
        }
      }),
      text: "說個笑話",
      category: "light_joke",
      generator: { providerName: "deepseek", completeText }
    });

    const prompt = completeText.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("PERSONA_PROMPT");
    expect(prompt).toContain("CONVERSATION_RULES_PROMPT");
    expect(prompt).toContain("SAFETY_RULES_PROMPT");
    expect(prompt).toContain("FORMAT_RULES_PROMPT");
  });

  it("allows the small talk persona to come from profile config", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我在。");

    await createControlledSmallTalkReply({
      profile: profile({
        smallTalk: {
          mode: "llm",
          maxChars: 80,
          prompting: {
            personaPrompt: "你像一位可靠、懂生活、也理解信仰背景的朋友。"
          }
        }
      }),
      text: "小哈你好",
      category: "greeting",
      generator: { providerName: "deepseek", completeText }
    });

    const prompt = completeText.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("你像一位可靠、懂生活、也理解信仰背景的朋友。");
    expect(prompt).not.toContain("你是小哈，來自哈利路亞家教會的內部小幫手");
  });

  it("does not echo the bot name back at the start of generated replies", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("小哈你好，願你平安。");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好",
      category: "greeting",
      generator: { providerName: "deepseek", completeText }
    });

    expect(result.replyText).toBe("你好，願你平安。");
  });

  it("falls back to a template when controlled generation is invalid", async () => {
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我會去查 Ollama、Notion 和 token，請看 https://example.com");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "ollama", completeText }
    });

    expect(result.replyText).toBe(createSmallTalkReply("wellbeing").replyText);
  });

  it("allows longer controlled replies from a remote API provider", async () => {
    const reply =
      "我在，謝謝你問我。若只是聊一下，我會簡短陪你回應；若需要查資料或找檔案，我也會照著可以使用的功能來幫忙。";
    const completeText = vi.fn<TextGenerationProvider["completeText"]>().mockResolvedValue(reply);

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "deepseek", completeText }
    });

    expect(result.replyText).toBe(reply);
    expect(completeText).toHaveBeenCalledWith(expect.objectContaining({ maxChars: 320 }));
  });

  it("falls back to local short controlled replies when the remote API provider fails", async () => {
    const primaryCompleteText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockRejectedValue(new Error("remote failed"));
    const fallbackCompleteText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我在，慢慢來。");

    const result = await createControlledSmallTalkReply({
      profile: profile({ smallTalk: { mode: "llm", maxChars: 80 } }),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "deepseek", completeText: primaryCompleteText },
      fallbackGenerator: { providerName: "ollama", completeText: fallbackCompleteText }
    });

    expect(result.replyText).toBe("我在，慢慢來。");
    expect(result.smallTalkTrace).toMatchObject({
      provider: "ollama",
      lane: "smart_talk",
      outcome: "fallback",
      reason: "primary_failed"
    });
    expect(primaryCompleteText).toHaveBeenCalledWith(expect.objectContaining({ maxChars: 320 }));
    expect(fallbackCompleteText).toHaveBeenCalledWith(expect.objectContaining({ maxChars: 80 }));
  });

  it("keeps template mode when LLM small talk is not enabled", async () => {
    const completeText = vi.fn<TextGenerationProvider["completeText"]>();

    const result = await createControlledSmallTalkReply({
      profile: profile(),
      text: "小哈你好嗎",
      category: "wellbeing",
      generator: { providerName: "ollama", completeText }
    });

    expect(result.replyText).toBe(createSmallTalkReply("wellbeing").replyText);
    expect(completeText).not.toHaveBeenCalled();
  });
});

import { getFunctionDefinitions } from "./functions/definitions.js";
import { buildFunctionQuickReplies } from "./line-reply.js";
import type { BotProfileConfig, FunctionExecutionResult } from "./types.js";

interface IntroReplyOptions {
  force?: boolean;
  greeting?: string;
}

const introTriggers = [
  "小哈",
  "小哈?",
  "小哈？",
  "help",
  "功能",
  "使用說明",
  "小哈可以幹嘛",
  "小哈你會什麼",
  "小哈會什麼"
];

export function createIntroReply(
  profile: BotProfileConfig,
  rawText: string,
  options: IntroReplyOptions = {}
): FunctionExecutionResult | undefined {
  const normalized = normalizeIntroText(rawText);
  if (!options.force && !isIntroRequest(normalized)) {
    return undefined;
  }

  const definitions = getFunctionDefinitions(profile.enabledFunctions);
  void options.greeting;
  if (definitions.length === 0) {
    return {
      ok: true,
      replyText: "我是小哈，教會同工小幫手。目前還沒有開放可查詢的項目。"
    };
  }

  return {
    ok: true,
    replyText: [
      "我是小哈，教會同工小幫手。",
      "需要資料時可以叫我一聲，我可以幫忙：",
      "",
      ...definitions.map(
        (definition) => `- ${definition.displayName}：${definition.shortDescription}`
      ),
      "",
      "可以直接點下方按鈕，或用一句話告訴我想查什麼。"
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    quickReplies: buildFunctionQuickReplies(profile)
  };
}

function isIntroRequest(normalized: string): boolean {
  return introTriggers.includes(normalized);
}

function normalizeIntroText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[!！。.\s]+$/g, "")
    .toLowerCase();
}

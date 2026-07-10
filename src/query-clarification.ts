import { getFunctionDefinitions } from "./functions/definitions.js";
import type { BotProfileConfig, FunctionExecutionResult } from "./types.js";

export function createQueryClarificationReply(
  profile: BotProfileConfig,
  rawText: string
): FunctionExecutionResult | undefined {
  if (!isGenericQueryRequest(rawText, profile.wakeKeywords)) {
    return undefined;
  }

  const definitions = getFunctionDefinitions(profile.enabledFunctions).filter(
    (definition) => definition.sideEffectLevel === "read"
  );
  if (definitions.length === 0) {
    return { ok: true, replyText: "目前沒有開放可查詢的內容。" };
  }

  return {
    ok: true,
    replyText: [
      "你想查什麼？",
      "我可以幫你查：",
      ...definitions.map((definition) => `- ${definition.displayName}`)
    ].join("\n"),
    quickReplies: definitions.map((definition) => ({
      label: definition.quickReply.label,
      action: {
        type: "message" as const,
        label: definition.quickReply.label,
        text: definition.quickReply.command
      }
    }))
  };
}

function isGenericQueryRequest(text: string, wakeKeywords: string[]): boolean {
  let normalized = text.normalize("NFKC").trim();
  for (const keyword of wakeKeywords) {
    if (keyword && normalized.startsWith(keyword)) {
      normalized = normalized.slice(keyword.length).trim();
      break;
    }
  }
  normalized = normalized.replace(/^[，,、\s]+|[？?！!。\s]+$/gu, "");
  return /^(?:幫我|請|可以)?(?:查|找)(?:東西|資料|一下)?$/u.test(normalized);
}

import { getFunctionDefinitions } from "./functions/definitions.js";
import type { BotProfileConfig, FunctionExecutionResult } from "./types.js";

export function createQueryClarificationReply(
  profile: BotProfileConfig,
  rawText: string
): FunctionExecutionResult | undefined {
  if (!isGenericQueryRequest(rawText, profile.wakeKeywords)) {
    return undefined;
  }

  if (profile.enabledFunctions.length === 0) {
    return { ok: true, replyText: "目前沒有開放可查詢的內容。" };
  }

  const capabilities = queryCapabilities(profile);
  if (capabilities.length === 0) {
    return { ok: true, replyText: "目前沒有開放可查詢的內容。" };
  }

  return {
    ok: true,
    replyText: [
      "你想查什麼？請直接告訴我名稱、日期或主題。",
      "",
      "目前可以查：",
      ...capabilities.map((capability) => `- ${capability}`)
    ].join("\n")
  };
}

function queryCapabilities(profile: BotProfileConfig): string[] {
  const definitions = getFunctionDefinitions(profile.enabledFunctions).filter(
    (definition) => definition.sideEffectLevel === "read" && !definition.deprecated
  );
  return definitions.map((definition) => definition.displayName);
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

import { FUNCTION_DEFINITIONS, type FunctionDefinition } from "./functions/definitions.js";
import { normalizeFunctionArguments } from "./functions/argument-normalization.js";
import { extractPptSlideQuery } from "./ppt-query.js";
import type { JsonRecord, RouteInput, RouteResult, SmallTalkCategory } from "./types.js";

type KeywordRule = FunctionDefinition & {
  keywordFallback: NonNullable<FunctionDefinition["keywordFallback"]>;
};

export interface KeywordFallbackRouter {
  route(input: RouteInput): RouteResult;
}

const rules: KeywordRule[] = FUNCTION_DEFINITIONS.filter((definition): definition is KeywordRule =>
  Boolean(definition.keywordFallback)
);

export function createKeywordFallbackRouter(): KeywordFallbackRouter {
  return {
    route(input: RouteInput): RouteResult {
      const text = input.text.trim();
      const matches = rules.filter((rule) =>
        rule.keywordFallback.keywords.some((keyword) => includesKeyword(text, keyword))
      );

      if (matches.length === 0) {
        const smallTalk = extractSmallTalkFallback(text);
        if (smallTalk) {
          return {
            type: "respond",
            action: "small_talk",
            arguments: { category: smallTalk },
            provider: "keyword"
          };
        }
        const intro = extractIntroFallback(text);
        if (intro) {
          return {
            type: "respond",
            action: "introduce_bot",
            arguments: intro.greeting ? { greeting: intro.greeting } : {},
            provider: "keyword"
          };
        }
        return { type: "deny", reason: "keyword_no_match", provider: "keyword" };
      }

      const enabledMatches = matches.filter((match) => input.enabledFunctions.includes(match.name));
      if (enabledMatches.length === 0) {
        return { type: "deny", reason: "function_disabled", provider: "keyword" };
      }

      if (enabledMatches.length > 1) {
        return { type: "deny", reason: "keyword_ambiguous", provider: "keyword" };
      }

      const match = enabledMatches[0];
      return {
        type: "execute",
        action: match.name,
        arguments: extractArguments(match, text),
        provider: "keyword"
      };
    }
  };
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function extractArguments(rule: KeywordRule, text: string): JsonRecord {
  const cleanedQuery =
    rule.name === "find_ppt_slides"
      ? extractPptSlideQuery(text)
      : cleanupQuery(text, rule.keywordFallback.stripWords);
  const query =
    cleanedQuery ||
    (rule.name === "find_ppt_slides" || rule.name === "find_pop_sheet_music" ? "" : text.trim());
  const argumentsRecord: JsonRecord = {
    ...(rule.keywordFallback.defaultArguments ?? {}),
    query
  };
  if (rule.name === "find_ppt_slides") {
    if (includesKeyword(text, "pdf")) {
      argumentsRecord.fileType = "pdf";
    }
  }
  if (rule.name === "find_pop_sheet_music") {
    argumentsRecord.fileType =
      includesKeyword(text, "jpg") || includesKeyword(text, "圖片") ? "image" : "pdf";
  }
  return normalizeFunctionArguments(rule.name, argumentsRecord, { text });
}

function cleanupQuery(text: string, stripWords: string[]): string {
  let result = text;
  for (const word of stripWords) {
    result = result.replaceAll(word, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

function extractIntroFallback(text: string): { greeting?: string } | undefined {
  const normalized = normalizeIntroFallbackText(text);
  const withoutWake = normalized.replace(/^小哈[，,\s]*/i, "");
  const greeting = matchGreeting(withoutWake) ?? matchGreeting(normalized);
  if (greeting) {
    return { greeting };
  }
  if (isIntroHelpText(normalized)) {
    return {};
  }
  return undefined;
}

function normalizeIntroFallbackText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[!！。.\s]+$/g, "");
}

function matchGreeting(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const greetings: Record<string, string> = {
    你好: "你好",
    嗨: "嗨",
    hi: "Hi",
    hello: "Hello",
    hey: "Hey",
    哈囉: "哈囉",
    哈啰: "哈囉",
    平安: "平安",
    早安: "早安",
    午安: "午安",
    晚安: "晚安"
  };
  return greetings[normalized];
}

function isIntroHelpText(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "小哈",
    "help",
    "功能",
    "使用說明",
    "小哈可以幹嘛",
    "小哈可以做什麼",
    "小哈你會什麼",
    "小哈會什麼",
    "你可以做什麼",
    "你會什麼"
  ].includes(normalized);
}

function extractSmallTalkFallback(text: string): SmallTalkCategory | undefined {
  const normalized = normalizeIntroFallbackText(text);
  const withoutWake = normalized.replace(/^小哈[，,\s]*/i, "");
  const value = withoutWake || normalized;
  const lower = value.toLowerCase();
  if (/謝謝|謝啦|感謝|thanks|thank you/u.test(lower)) {
    return "thanks";
  }
  if (/難為|為難|還好嗎|累嗎|累不累|辛苦嗎/u.test(lower)) {
    return "reassurance";
  }
  if (/人設|i人|e人|內向|外向|安靜/u.test(lower)) {
    return "persona";
  }
  if (/辛苦|加油|很棒|厲害|強/u.test(lower)) {
    return "encouragement";
  }
  if (/哈哈|好笑|開玩笑|笑死/u.test(lower)) {
    return "light_joke";
  }
  return undefined;
}

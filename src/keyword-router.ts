import { FUNCTION_DEFINITIONS, type FunctionDefinition } from "./functions/definitions.js";
import { normalizeFunctionArguments } from "./functions/argument-normalization.js";
import { extractPptSlideQuery } from "./ppt-query.js";
import { queryDomainIntentToRoute, resolveQueryDomainIntent } from "./query-domain-resolver.js";
import type {
  FunctionName,
  JsonRecord,
  RouteInput,
  RouteResult,
  SmallTalkCategory
} from "./types.js";

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
      const memoryIntent = extractMemoryIntent(text);
      if (memoryIntent) {
        const action = compatibleMemoryAction(memoryIntent.action, input.enabledFunctions);
        if (!action) {
          return { type: "deny", reason: "function_disabled", provider: "keyword" };
        }
        return {
          type: "execute",
          action,
          arguments: normalizeFunctionArguments(action, memoryIntent.arguments, {
            text
          }),
          provider: "keyword"
        };
      }

      const domainIntent = resolveQueryDomainIntent(input);
      if (domainIntent) {
        return queryDomainIntentToRoute(domainIntent);
      }

      const wikipediaIntent = extractWikipediaIntent(text);
      if (wikipediaIntent) {
        if (!input.enabledFunctions.includes("query_wikipedia")) {
          return { type: "deny", reason: "function_disabled", provider: "keyword" };
        }
        return {
          type: "execute",
          action: "query_wikipedia",
          arguments: { query: wikipediaIntent },
          provider: "keyword"
        };
      }

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
            arguments: { variant: intro.variant },
            provider: "keyword"
          };
        }
        return { type: "deny", reason: "keyword_no_match", provider: "keyword" };
      }

      let enabledMatches = matches.filter((match) => input.enabledFunctions.includes(match.name));
      if (input.enabledFunctions.includes("query_schedule")) {
        enabledMatches = enabledMatches.filter((match) => match.name !== "query_service_schedule");
      }
      if (input.enabledFunctions.includes("find_sheet_music")) {
        enabledMatches = enabledMatches.filter((match) => match.name !== "find_pop_sheet_music");
      }
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

function extractWikipediaIntent(text: string): string | undefined {
  const value = stripWakeAddress(text.trim())
    .replace(/[？?。!！]+$/u, "")
    .trim();
  const person = value.match(/^(?:請|麻煩)?(?:幫我)?(?:查|找|看)?(.+?)是誰$/u)?.[1]?.trim();
  const topic = value.match(/^(?:請|麻煩)?(?:幫我)?(?:查|找|看)?什麼是(.+)$/u)?.[1]?.trim();
  const query = person || topic;
  if (!query || /^(?:你|我|小哈)$/u.test(query) || /怎麼寫|如何寫|code|程式/iu.test(value)) {
    return undefined;
  }
  return query;
}

function extractMemoryIntent(
  text: string
): { action: FunctionName; arguments: JsonRecord } | undefined {
  const value = stripWakeAddress(text.trim());
  const resourceSaveIntent = extractResourceSaveIntent(value);
  if (resourceSaveIntent) {
    return resourceSaveIntent;
  }
  const scheduleMemoryIntent = extractScheduleMemoryIntent(value);
  if (scheduleMemoryIntent) {
    return scheduleMemoryIntent;
  }

  const save = value.match(/^(?:幫我)?(?:記住|保存|儲存)(?:一下)?[：:\s]*(.*)$/u);
  if (save) {
    return {
      action: "save_memory",
      arguments: { content: save[1]?.trim() ?? "" }
    };
  }

  const retrieve = value.match(
    /^(?:幫我)?(?:查|找|看)(?:一下)?(?:我)?(?:記住|保存|儲存)(?:的)?[：:\s]*(.*)$/u
  );
  if (retrieve) {
    return {
      action: "retrieve_memory",
      arguments: { query: retrieve[1]?.trim() ?? "" }
    };
  }

  const remembered = value.match(/^我記住的[：:\s]*(.*)$/u);
  if (remembered) {
    return {
      action: "retrieve_memory",
      arguments: { query: remembered[1]?.trim() ?? "" }
    };
  }
  return undefined;
}

function extractResourceSaveIntent(
  value: string
): { action: FunctionName; arguments: JsonRecord } | undefined {
  if (!/^(?:幫我|請|麻煩)?(?:記住|保存|儲存)/u.test(value)) {
    return undefined;
  }
  const url = value.match(/https:\/\/[^\s，,。)）]+/u)?.[0];
  if (!url) {
    if (/(?:投影片|簡報|ppt|powerpoint|slide|歌譜|樂譜|sheet\s*music)/iu.test(value)) {
      return { action: "save_resource", arguments: { url: "" } };
    }
    return undefined;
  }
  const resourceType = /(?:投影片|簡報|ppt|powerpoint|slide)/iu.test(value)
    ? "ppt_slide"
    : /(?:歌譜|樂譜|sheet\s*music)/iu.test(value)
      ? "sheet_music"
      : undefined;
  const title = value.match(/(?:名稱|標題|名字)(?:是|叫)?[：:\s]*(.+)$/u)?.[1]?.trim();
  return {
    action: "save_resource",
    arguments: {
      url,
      ...(resourceType ? { resourceType } : {}),
      ...(title ? { title: cleanupResourceTitle(title) } : {})
    }
  };
}

function cleanupResourceTitle(value: string): string {
  return value.replace(/[。.!！?？]+$/u, "").trim();
}

function extractScheduleMemoryIntent(
  value: string
): { action: FunctionName; arguments: JsonRecord } | undefined {
  const mutation = extractScheduleMutationIntent(value);
  if (mutation) {
    return { action: "save_schedule", arguments: mutation };
  }
  const content = extractScheduleMemoryContent(value);
  if (content !== undefined) {
    return {
      action: "save_schedule",
      arguments: { content }
    };
  }

  if (/^(?:查|找|看|給我|幫我查).*(?:舉牌|晨更家族|家族晨更|仙履奇緣)/u.test(value)) {
    return {
      action: "query_schedule",
      arguments: {
        query: cleanScheduleMemoryRouteQuery(value),
        ...(value.includes("舉牌") || value.includes("為耶穌")
          ? { scheduleType: "street_sign_service" }
          : {}),
        ...(value.includes("晨更家族") || value.includes("家族晨更") || value.includes("仙履奇緣")
          ? { scheduleType: "morning_prayer_family" }
          : {})
      }
    };
  }

  return undefined;
}

function extractScheduleMutationIntent(value: string): JsonRecord | undefined {
  if (/^(?:請|麻煩|幫我)?(?:刪除|移除)/u.test(value)) {
    const targetQuery = value
      .replace(/^(?:請|麻煩|幫我)?(?:刪除|移除)/u, "")
      .replace(/(?:\d{1,2}|[一二三四五六七八九十兩]{1,3})\s*[/／月]\s*\d{1,2}/gu, " ")
      .replace(/晨更|仙履奇緣|為耶穌|舉牌|服事表|服事/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { operation: "delete_entry", targetQuery };
  }
  if (/^(?:請|麻煩|幫我)?(?:新增|增加)/u.test(value)) {
    return { operation: "add_entry", query: value };
  }
  if (/(?:修改|改成|改到)/u.test(value)) {
    return { operation: "update_entry", query: value };
  }
  return undefined;
}

function compatibleMemoryAction(
  action: FunctionName,
  enabledFunctions: FunctionName[]
): FunctionName | undefined {
  if (enabledFunctions.includes(action)) {
    return action;
  }
  const legacy =
    action === "save_schedule"
      ? "save_schedule_memory"
      : action === "query_schedule"
        ? "query_schedule_memory"
        : undefined;
  return legacy && enabledFunctions.includes(legacy) ? legacy : undefined;
}

function extractScheduleMemoryContent(value: string): string | undefined {
  if (!/^(?:幫我|請|麻煩)?(?:記住|保存|儲存)/u.test(value)) {
    return undefined;
  }
  const afterSeparator = value.match(/[：:]\s*([\s\S]+)$/u)?.[1]?.trim();
  const isStructuredSchedule =
    /(?:晨更|舉牌|仙履奇緣)/u.test(value) ||
    Boolean(afterSeparator?.match(/(?:\d{1,2}|[一二三四五六七八九十兩]{1,3})\s*[/／]\s*\d{1,2}/u));
  if (!isStructuredSchedule) {
    return undefined;
  }
  if (afterSeparator) {
    return afterSeparator;
  }
  return value
    .replace(/^(?:幫我|請|麻煩)?(?:記住|保存|儲存)(?:這份|一下|這個月|這張|這個)?/u, "")
    .replace(/^(?:晨更|舉牌|為耶穌舉牌)?服事表/u, "")
    .trim();
}

function cleanScheduleMemoryRouteQuery(value: string): string {
  return value.replace(/^(?:幫我)?(?:查|找|看|給我|幫我查)\s*/u, "").trim();
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
    (rule.name === "find_ppt_slides" ||
    rule.name === "find_sheet_music" ||
    rule.name === "find_pop_sheet_music" ||
    rule.name === "query_wikipedia"
      ? ""
      : text.trim());
  const argumentsRecord: JsonRecord = {
    ...(rule.keywordFallback.defaultArguments ?? {}),
    query
  };
  if (rule.name === "find_ppt_slides") {
    if (includesKeyword(text, "pdf")) {
      argumentsRecord.fileType = "pdf";
    }
  }
  if (rule.name === "find_sheet_music" || rule.name === "find_pop_sheet_music") {
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

function extractIntroFallback(text: string): { variant: "identity" | "capabilities" } | undefined {
  const normalized = normalizeIntroFallbackText(text);
  const withoutWake = stripWakeAddress(normalized);
  if (isIdentityIntroText(normalized) || withoutWake === "") {
    return { variant: "identity" };
  }
  if (isCapabilitiesIntroText(normalized) || isCapabilitiesIntroText(withoutWake)) {
    return { variant: "capabilities" };
  }
  return undefined;
}

function normalizeIntroFallbackText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[!！。.?？\s]+$/g, "");
}

function isIdentityIntroText(value: string): boolean {
  const normalized = value.toLowerCase();
  return ["小哈", "小哈是誰", "小哈你是誰"].includes(normalized);
}

function isCapabilitiesIntroText(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "help",
    "功能",
    "使用說明",
    "小哈可以幹嘛",
    "小哈可以做什麼",
    "小哈你能做什麼",
    "小哈你會什麼",
    "小哈會什麼",
    "你可以做什麼",
    "你能做什麼",
    "你會什麼",
    "能做什麼"
  ].includes(normalized);
}

function extractSmallTalkFallback(text: string): SmallTalkCategory | undefined {
  const normalized = normalizeIntroFallbackText(text);
  const withoutWake = stripWakeAddress(normalized);
  const value = withoutWake || normalized;
  const lower = value.toLowerCase();
  if (/你好嗎|還在嗎|在嗎|最近好嗎|好嗎|安好/u.test(lower)) {
    return "wellbeing";
  }
  if (/^(你好|哈囉|哈啰|嗨|hi|hello|hey|平安|早安|午安|晚安)$/iu.test(lower)) {
    return "greeting";
  }
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

function stripWakeAddress(value: string): string {
  if (!value.startsWith("小哈")) {
    return value;
  }
  return value.slice("小哈".length).replace(/^[，,、:：?？\s]+/u, "");
}

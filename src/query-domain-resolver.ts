import type { FunctionName, JsonRecord, RouteInput, RouteResult } from "./types.js";

export type QueryDomain =
  "schedule" | "presentation" | "sheet_music" | "audio" | "church_resource" | "wikipedia";

export interface QueryDomainIntent {
  domain: QueryDomain;
  action: FunctionName;
  arguments: JsonRecord;
  missingRequiredSlot?: boolean;
}

export function resolveQueryDomainIntent(input: RouteInput): QueryDomainIntent | undefined {
  const text = stripBotAddress(input.text);
  if (isSaveOrSavedLookupIntent(text)) {
    return undefined;
  }
  const explicit = resolveExplicitInternalIntent(text, input.enabledFunctions);
  if (explicit) {
    return explicit;
  }
  const wikipedia = resolveWikipediaIntent(text, input.enabledFunctions);
  if (wikipedia) {
    return wikipedia;
  }
  return undefined;
}

export function queryDomainIntentToRoute(intent: QueryDomainIntent): RouteResult {
  return {
    type: "execute",
    action: intent.action,
    arguments: intent.arguments,
    provider: "keyword"
  };
}

function resolveWikipediaIntent(
  text: string,
  enabledFunctions: FunctionName[]
): QueryDomainIntent | undefined {
  if (!enabledFunctions.includes("query_wikipedia")) {
    return undefined;
  }
  const normalized = normalizeIntentText(text);
  const hasWikipediaWord = normalized.includes("維基百科") || normalized.includes("wikipedia");
  if (!hasWikipediaWord) {
    return undefined;
  }

  const topic = extractWikipediaTopic(text);
  return {
    domain: "wikipedia",
    action: "query_wikipedia",
    arguments: { query: topic },
    missingRequiredSlot: topic.length === 0
  };
}

function resolveExplicitInternalIntent(
  text: string,
  enabledFunctions: FunctionName[]
): QueryDomainIntent | undefined {
  const normalized = normalizeIntentText(text);
  const scheduleAction = compatibleAction(
    "query_schedule",
    "query_service_schedule",
    enabledFunctions
  );
  if (scheduleAction && includesAny(normalized, ["服事表", "服事"])) {
    const query = extractDomainQuery(text, ["服事表", "服事"]);
    if (query) {
      return undefined;
    }
    return {
      domain: "schedule",
      action: scheduleAction,
      arguments: { query },
      missingRequiredSlot: query.length === 0
    };
  }

  if (
    enabledFunctions.includes("find_ppt_slides") &&
    includesAny(normalized, ["投影片", "簡報", "ppt", "powerpoint", "slides", "keynote", "odp"])
  ) {
    const query = extractDomainQuery(text, [
      "投影片",
      "簡報",
      "pdf",
      "ppt",
      "powerpoint",
      "slides",
      "keynote",
      "odp"
    ]);
    return {
      domain: "presentation",
      action: "find_ppt_slides",
      arguments: {
        query,
        matchMode: "fuzzy",
        ...(includesAny(normalized, ["pdf"]) ? { fileType: "pdf" } : {})
      },
      missingRequiredSlot: query.length === 0
    };
  }

  const sheetAction = compatibleAction(
    "find_sheet_music",
    "find_pop_sheet_music",
    enabledFunctions
  );
  if (sheetAction && includesAny(normalized, ["歌譜", "樂譜", "sheetmusic", "score"])) {
    const query = extractDomainQuery(text, [
      "流行歌曲樂譜",
      "流行歌譜",
      "詩歌歌譜",
      "歌譜",
      "樂譜",
      "sheet music",
      "score"
    ]);
    return {
      domain: "sheet_music",
      action: sheetAction,
      arguments: { query, fileType: "pdf", matchMode: "fuzzy" },
      missingRequiredSlot: query.length === 0
    };
  }

  if (
    enabledFunctions.includes("find_resource") &&
    includesAny(normalized, ["週報音檔", "週報錄音", "這週週報", "下載週報"])
  ) {
    const query = extractDomainQuery(text, [
      "教會資料",
      "小哈資料庫",
      "週報音檔",
      "週報錄音",
      "這週週報",
      "下載週報"
    ]);
    return {
      domain: "audio",
      action: "find_resource",
      arguments: { query, itemKind: "weekly_report_audio", domain: "audio" },
      missingRequiredSlot: query.length === 0
    };
  }

  if (
    enabledFunctions.includes("find_resource") &&
    includesAny(normalized, ["教會資料", "小哈資料庫"])
  ) {
    const query = extractDomainQuery(text, ["教會資料", "小哈資料庫"]);
    return {
      domain: "church_resource",
      action: "find_resource",
      arguments: { query },
      missingRequiredSlot: query.length === 0
    };
  }

  return undefined;
}

function extractWikipediaTopic(text: string): string {
  let value = text.normalize("NFKC").trim();
  value = value.replace(/^(?:幫我|請|麻煩)?(?:查詢|查|搜尋|找)?\s*(?:維基百科|wikipedia)/iu, "");
  value = value.replace(
    /^(?:幫我|請|麻煩)?(?:去|到)?\s*(?:維基百科|wikipedia)\s*(?:查詢|查|搜尋|找)?/iu,
    ""
  );
  value = value.replace(/^(?:查詢|查|搜尋|找)\s*(?:一下)?$/u, "");
  return value.replace(/[。！？!?，,：:\s]+$/u, "").trim();
}

function stripBotAddress(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/^(?:小哈|撠\?)[：:，,\s]*/u, "");
}

function normalizeIntentText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function isSaveOrSavedLookupIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /(?:保存|儲存|記住|存)/u.test(text) ||
    normalized.includes("查我記住") ||
    normalized.includes("找我記住") ||
    normalized.includes("查我保存") ||
    normalized.includes("找我保存") ||
    normalized.includes("查我儲存") ||
    normalized.includes("找我儲存") ||
    normalized.includes("我記住的") ||
    normalized.includes("我保存的") ||
    normalized.includes("我儲存的")
  );
}

function compatibleAction(
  canonical: FunctionName,
  legacy: FunctionName,
  enabledFunctions: FunctionName[]
): FunctionName | undefined {
  if (enabledFunctions.includes(canonical)) {
    return canonical;
  }
  return enabledFunctions.includes(legacy) ? legacy : undefined;
}

function includesAny(normalizedText: string, needles: string[]): boolean {
  return needles.some((needle) => normalizedText.includes(normalizeIntentText(needle)));
}

function extractDomainQuery(text: string, terms: string[]): string {
  let value = text.normalize("NFKC").trim();
  value = value.replace(/^(?:幫我|請|麻煩|可以)?\s*(?:查詢|查|搜尋|找|下載)?\s*/iu, "");
  for (const term of terms.sort((left, right) => right.length - left.length)) {
    value = value.replace(new RegExp(escapeRegExp(term), "giu"), " ");
  }
  value = value
    .replace(/^[：:，,\s]+|[。！？!?，,：:\s]+$/gu, "")
    .replace(/(?:的|一下)$/u, "")
    .replace(/^[：:，,\s]+|[。！？!?，,：:\s]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return value === "一下" ? "" : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

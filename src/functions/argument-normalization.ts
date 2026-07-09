import { extractPptSlideQuery } from "../ppt-query.js";
import type { FunctionName, JsonRecord } from "../types.js";

export interface FunctionArgumentNormalizationInput {
  text: string;
}

const wakeWordPattern = /^小哈[\s,，、:：。!！?？]*/i;
const leadingRequestWords = [
  "請",
  "麻煩",
  "可以",
  "可不可以",
  "能不能",
  "幫我",
  "幫忙",
  "幫",
  "我要",
  "我想要",
  "想要",
  "查詢",
  "查",
  "找",
  "搜尋",
  "拿",
  "下載",
  "給我"
];

export function normalizeFunctionArguments(
  action: FunctionName,
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  switch (action) {
    case "find_ppt_slides":
      return normalizePptSlideArguments(args, input);
    case "find_pop_sheet_music":
      return normalizeSheetMusicArguments(args, input);
    case "query_service_schedule":
      return normalizeServiceScheduleArguments(args, input);
    default:
      return args;
  }
}

function normalizePptSlideArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  const query = stringArg(args, "query");
  const normalizedQuery = query ? extractPptSlideQuery(query) : extractPptSlideQuery(input.text);

  if (normalizedQuery && normalizedQuery !== query) {
    return withOriginalQuery({ ...args, query: normalizedQuery }, args, input.text);
  }

  if (query && !normalizedQuery) {
    return withOriginalQuery({ ...args, query: "" }, args, input.text);
  }

  if (query || !normalizedQuery) {
    return args;
  }

  return withOriginalQuery({ ...args, query: normalizedQuery }, args, input.text);
}

function normalizeSheetMusicArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  const query = stringArg(args, "query");
  const inputQuery = extractSheetMusicQuery(input.text);
  const modelQuery = extractSheetMusicQuery(query);
  const normalizedQuery = isGenericSheetMusicQuery(inputQuery)
    ? ""
    : inputQuery && modelQuery && queryContains(inputQuery, modelQuery)
      ? modelQuery
      : inputQuery || (isGenericSheetMusicRequest(input.text) ? "" : modelQuery);
  const next: JsonRecord = { ...args };

  if (normalizedQuery !== query) {
    next.query = normalizedQuery;
  }

  if (!stringArg(next, "fileType")) {
    const inferredFileType = inferSheetMusicFileType([query, input.text].join(" "));
    if (inferredFileType) {
      next.fileType = inferredFileType;
    }
  }

  return next;
}

function normalizeServiceScheduleArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  if (isGenericServiceScheduleRequest(input.text)) {
    const next = { ...args };
    delete next.date;
    delete next.dateIntent;
    delete next.specificDate;
    delete next.meeting;
    delete next.role;
    return { ...next, query: input.text.trim() };
  }

  const query = stringArg(args, "query");
  if (query === "主日") {
    return { ...args, query: "主日服事" };
  }
  if (query) {
    return args;
  }
  return { ...args, query: input.text.trim() };
}

export function extractSheetMusicQuery(text: string): string {
  let query = text
    .normalize("NFKC")
    .trim()
    .replace(wakeWordPattern, "")
    .replace(/^小哈[\s,，、:：]*/u, "");

  for (let index = 0; index < 4; index += 1) {
    const before = query;
    query = stripLeadingRequestWords(query);
    if (query === before) {
      break;
    }
  }

  query = query
    .replace(/(?:流行歌曲樂譜|流行歌譜|流行歌曲|流行歌|歌譜|樂譜)/gi, " ")
    .replace(/(?:流行歌曲樂譜|流行歌譜|流行歌曲|流行歌|歌譜|樂譜|查譜|找譜|的譜|譜)/gi, " ")
    .replace(/\b(?:sheet\s*music|music\s*score|score|pdf|jpe?g|png|gif|image|picture)\b/gi, " ")
    .replace(/[()[\]{}"'“”‘’.,，。!！?？:：、/\\|_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^的+|的+$/g, "")
    .trim();

  return query;
}

function isGenericSheetMusicRequest(text: string): boolean {
  return isGenericSheetMusicQuery(extractSheetMusicQuery(text));
}

function isGenericSheetMusicQuery(query: string): boolean {
  const normalized = query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,，、:：。.!！?？_-]+/g, "");
  return [
    "",
    "譜",
    "查譜",
    "找譜",
    "樂譜",
    "歌譜",
    "流行歌譜",
    "流行歌曲樂譜",
    "sheetmusic",
    "score"
  ].includes(normalized);
}

function queryContains(value: string, expected: string): boolean {
  return normalizeComparableQuery(value).includes(normalizeComparableQuery(expected));
}

function normalizeComparableQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,，、:：。.!！?？'"“”‘’()[\]{}_-]+/g, "");
}

function isGenericServiceScheduleRequest(text: string): boolean {
  const normalized = normalizeGenericChineseRequest(text);
  return ["服事表", "服事", "服事人員", "聚會服事表", "聚會服事", "聚會服事人員"].includes(
    normalized
  );
}

function normalizeGenericChineseRequest(text: string): string {
  let normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/^小哈[\s,，、:：]*/u, "")
    .replace(/[，,。.!！?？、:：\s]/g, "");
  const leadingWords = [
    "請問",
    "請",
    "麻煩",
    "幫我",
    "幫忙",
    "查詢",
    "查",
    "看",
    "找",
    "給我",
    "告訴我",
    "想知道"
  ];

  for (let index = 0; index < 4; index += 1) {
    const before = normalized;
    for (const word of leadingWords) {
      if (normalized.startsWith(word)) {
        normalized = normalized.slice(word.length);
        break;
      }
    }
    if (normalized === before) {
      break;
    }
  }

  return normalized;
}

function stripLeadingRequestWords(value: string): string {
  let result = value.trimStart();
  for (const word of leadingRequestWords) {
    if (result.startsWith(word)) {
      result = result.slice(word.length).trimStart();
      result = result.replace(/^[,，、:：。!！?？\s]+/, "");
      break;
    }
  }
  return result;
}

function inferSheetMusicFileType(text: string): "pdf" | "image" | undefined {
  if (/\b(?:jpe?g|png|gif|image|picture)\b/i.test(text) || /圖片/.test(text)) {
    return "image";
  }
  if (/\bpdf\b/i.test(text)) {
    return "pdf";
  }
  return undefined;
}

function stringArg(args: JsonRecord, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function withOriginalQuery(
  next: JsonRecord,
  previous: JsonRecord,
  fallbackText: string
): JsonRecord {
  return {
    ...next,
    originalQuery:
      typeof previous.originalQuery === "string" ? previous.originalQuery : fallbackText
  };
}

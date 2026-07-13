import { extractPptSlideQuery } from "../ppt-query.js";
import { getFunctionDefinition } from "./definitions.js";
import { clearGenericSlotArguments, findGenericRequestSlot } from "./generic-slot.js";
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
  const genericRequestSlot = findGenericRequestSlot(
    getFunctionDefinition(action)?.requiredSlots ?? [],
    input.text
  );
  if (genericRequestSlot) {
    return clearGenericSlotArguments(genericRequestSlot, args);
  }

  switch (action) {
    case "find_ppt_slides":
      return normalizePptSlideArguments(args, input);
    case "find_sheet_music":
    case "find_pop_sheet_music":
      return normalizeSheetMusicArguments(args, input);
    case "query_schedule":
    case "query_service_schedule":
      return normalizeServiceScheduleArguments(args, input);
    case "query_knowledge":
      return normalizeKnowledgeArguments(args, input);
    default:
      return args;
  }
}

export function hasExplicitWriteEvidence(text: string, args: JsonRecord): boolean {
  const normalized = text.normalize("NFKC");
  if (!/(?:記住|保存|儲存|新增|修改|改|刪除|移除)/u.test(normalized)) {
    return false;
  }
  return writeEvidenceStrings(args).every((value) => stringHasEvidence(normalized, value));
}

const nonEvidenceArgumentKeys = new Set([
  "operation",
  "scheduleType",
  "resourceType",
  "visibility",
  "matchMode",
  "fileType",
  "entryId",
  "memoryId",
  "confirm",
  "cancel",
  "query"
]);

function writeEvidenceStrings(value: unknown, key?: string): string[] {
  if (key && nonEvidenceArgumentKeys.has(key)) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([childKey, child]) =>
    writeEvidenceStrings(child, childKey)
  );
}

function stringHasEvidence(text: string, value: string): boolean {
  const normalizedValue = value.normalize("NFKC");
  if (text.includes(normalizedValue)) {
    return true;
  }
  const date = normalizedValue.match(/^\d{4}-(\d{2})-(\d{2})$/u);
  return date ? text.includes(`${Number(date[1])}/${Number(date[2])}`) : false;
}

function normalizeKnowledgeArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  if (typeof args.ordinal === "number") return args;
  const text = `${stringArg(args, "query") ?? ""} ${input.text}`.normalize("NFKC");
  const digit = text.match(/第\s*(\d+)\s*(?:個|項|站|天|步|地點)/u)?.[1];
  if (digit && Number(digit) > 0) return { ...args, ordinal: Number(digit) - 1 };
  const chinese: Array<[RegExp, number]> = [
    [/第?一(?:個|項|站|天|步|地點)/u, 0],
    [/第?二(?:個|項|站|天|步|地點)/u, 1],
    [/第?三(?:個|項|站|天|步|地點)/u, 2]
  ];
  const match = chinese.find(([pattern]) => pattern.test(text));
  return match ? { ...args, ordinal: match[1] } : args;
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
  const normalizedQuery =
    inputQuery && modelQuery && queryContains(inputQuery, modelQuery)
      ? modelQuery
      : inputQuery || modelQuery;
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
  const next = { ...args };
  if (!stringArg(next, "dateIntent") && /下一場|下場|最近一場|下一次|下次/u.test(input.text)) {
    next.dateIntent = "next_meeting";
  }
  const query = stringArg(args, "query");
  if (query === "主日") {
    return { ...next, query: "主日服事" };
  }
  if (query) {
    return next;
  }
  return { ...next, query: input.text.trim() };
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

function queryContains(value: string, expected: string): boolean {
  return normalizeComparableQuery(value).includes(normalizeComparableQuery(expected));
}

function normalizeComparableQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,，、:：。.!！?？'"“”‘’()[\]{}_-]+/g, "");
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

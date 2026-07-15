import { extractPptSlideQuery } from "../ppt-query.js";
import { extractScheduleRoleFocus, refineScheduleQuery } from "./schedule-query-refinement.js";
import { getFunctionDefinition } from "./definitions.js";
import { clearGenericSlotArguments, findGenericRequestSlot } from "./generic-slot.js";
import type { FunctionName, JsonRecord } from "../types.js";

export interface FunctionArgumentNormalizationInput {
  text: string;
  now?: Date;
  timeZone?: string;
  inferStructuredEvidence?: boolean;
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
      return normalizeSheetMusicArguments(args, input);
    case "query_schedule":
      return normalizeServiceScheduleArguments(args, input);
    case "query_knowledge":
      return normalizeKnowledgeArguments(args, input);
    case "save_memory":
      return normalizeSaveMemoryArguments(args, input);
    case "save_resource":
      return normalizeSaveResourceArguments(args);
    default:
      return args;
  }
}

function normalizeSaveResourceArguments(args: JsonRecord): JsonRecord {
  const rawType = stringArg(args, "resourceType")?.normalize("NFKC").toLowerCase();
  if (!rawType) return args;
  if (/^(?:投影片|簡報|ppt|pptx|powerpoint|slides?)$/u.test(rawType)) {
    return { ...args, resourceType: "ppt_slide" };
  }
  if (/^(?:歌譜|樂譜|sheet[ _-]?music|score)$/u.test(rawType)) {
    return { ...args, resourceType: "sheet_music" };
  }
  return args;
}

function normalizeSaveMemoryArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  if (/(?:群組共用|群組共享|大家都可以查|大家可查)/u.test(input.text)) {
    return { ...args, visibility: "group" };
  }
  if (/(?:私人|只有我|僅我|自己可查)/u.test(input.text)) {
    return { ...args, visibility: "private" };
  }
  return args;
}

export function hasExplicitWriteEvidence(text: string, args: JsonRecord): boolean {
  const normalized = text.normalize("NFKC");
  const evidence = writeEvidenceStrings(args);
  if (evidence.length === 0) return false;
  if (
    normalized
      .split(writeClauseSeparatorPattern)
      .some(
        (clause) =>
          hasUnnegatedWriteAction(clause) &&
          evidence.every((value) => stringHasEvidence(clause, value))
      )
  ) {
    return true;
  }
  return evidence.every(
    (value) =>
      writeClauseSeparatorPattern.test(value) &&
      stringHasEvidence(normalized, value) &&
      hasUnnegatedWriteAction(normalized.slice(0, normalized.indexOf(value.normalize("NFKC"))))
  );
}

export function hasWritePayloadArguments(args: JsonRecord): boolean {
  return writeEvidenceStrings(args).length > 0;
}

const writeActionPattern = /記住|保存|儲存|新增|修改|改|刪除|移除/gu;
const writeClauseSeparatorPattern = /[,，。.!！?？;；:：\r\n]+/u;
const writeNegationPattern = /不要|不用|不必|先別|別|不/u;

function hasUnnegatedWriteAction(text: string): boolean {
  const normalizedClause = text.replace(/[\p{P}\p{S}\s]+/gu, "");
  for (const match of normalizedClause.matchAll(writeActionPattern)) {
    const prefix = normalizedClause.slice(0, match.index);
    if (!writeNegationPattern.test(prefix)) return true;
  }
  return false;
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

  const explicitFileType = inferSheetMusicFileType(input.text);
  next.fileType = explicitFileType ?? "any";

  return next;
}

function normalizeServiceScheduleArguments(
  args: JsonRecord,
  input: FunctionArgumentNormalizationInput
): JsonRecord {
  const query = stringArg(args, "query");
  const currentQuery = input.text.trim() || query;
  if (!input.inferStructuredEvidence) {
    const next: JsonRecord = { ...args };
    if (!stringArg(next, "dateIntent")) {
      const dateIntent = relativeScheduleDateIntent(input.text);
      if (dateIntent) next.dateIntent = dateIntent;
    }
    if (query === "主日") return { ...next, query: "主日服事" };
    return query ? next : { ...next, query: currentQuery };
  }
  const refinement = refineScheduleQuery(
    { query: currentQuery },
    input.now ?? new Date(),
    input.timeZone ?? "Asia/Taipei"
  );
  const role = extractScheduleRoleFocus({
    query: currentQuery,
    hasContinuation: false,
    now: input.now,
    timeZone: input.timeZone
  });
  const structured = Object.fromEntries(
    Object.entries(refinement.structuredArguments).filter(([, value]) => value !== undefined)
  );
  const groundedModelQuery =
    query && input.text.normalize("NFKC").includes(query.normalize("NFKC")) ? query : undefined;
  return {
    ...structured,
    ...(role ? { role } : {}),
    ...args,
    query:
      groundedModelQuery ??
      (currentQuery === "主日" ? "主日服事" : refinement.residualQuery || currentQuery)
  };
}

function relativeScheduleDateIntent(
  text: string
): "next_meeting" | "this_week" | "today" | "tomorrow" | "day_after_tomorrow" | undefined {
  if (/下一場|下場|最近一場|下一次|下次/u.test(text)) return "next_meeting";
  if (/這週|這周|本週|本周|这周|这週/u.test(text)) return "this_week";
  if (/後天|后天/u.test(text)) return "day_after_tomorrow";
  if (/明天/u.test(text)) return "tomorrow";
  return /今天/u.test(text) ? "today" : undefined;
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

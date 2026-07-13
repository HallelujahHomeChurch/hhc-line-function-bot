import type { QueryScheduleArguments } from "../function-arguments.js";
import type { JsonRecord } from "../types.js";
import { buildResidualQuery, type QueryRefinement } from "./query-refinement.js";
import { extractKnownScheduleRole } from "./query-service-schedule.js";

export type ScheduleCategory = "media_team" | "saved_schedule";

export const MEDIA_TEAM_SCHEDULE_SOURCE_KEYS = ["media_team_service_schedule"] as const;

export type QueryScheduleStructuredArguments = JsonRecord & {
  date?: string;
  dateIntent?: QueryScheduleArguments["dateIntent"];
  specificDate?: string;
  meeting?: string;
  role?: string;
  scheduleType?: QueryScheduleArguments["scheduleType"];
  scheduleCategory?: ScheduleCategory;
  limit?: number;
};

const GENERIC_SCHEDULE_TERMS = [
  "小哈",
  "麻煩",
  "可以",
  "請問",
  "請",
  "幫我",
  "幫忙",
  "給我",
  "查詢",
  "查",
  "找",
  "看",
  "那",
  "呢",
  "服事人員",
  "服事安排",
  "聚會服事表",
  "服事表",
  "聚會服事",
  "服事",
  "什麼時候",
  "哪時候",
  "是什麼",
  "是誰",
  "哪一位",
  "誰",
  "一下",
  "的",
  "是"
];

const DATE_INTENT_TERMS: Array<{
  intent: NonNullable<QueryScheduleArguments["dateIntent"]>;
  terms: string[];
}> = [
  { intent: "day_after_tomorrow", terms: ["後天", "后天"] },
  { intent: "tomorrow", terms: ["明天"] },
  { intent: "today", terms: ["今天"] },
  { intent: "this_week", terms: ["本週", "本周", "這週", "這周", "这週", "这周"] },
  {
    intent: "next_meeting",
    terms: ["最近一場", "下一次", "下一場", "下次", "下場"]
  }
];

const MEDIA_TERMS = ["影視團隊", "影音團隊", "媒體團隊", "影視"];

export function refineScheduleQuery(
  args: QueryScheduleArguments,
  now: Date,
  timeZone: string
): QueryRefinement<QueryScheduleStructuredArguments> {
  const originalQuery = args.query.normalize("NFKC").trim();
  const consumedTerms: string[] = [];
  const structuredArguments: QueryScheduleStructuredArguments = copyStructuredArguments(args);

  if (!structuredArguments.date && !structuredArguments.specificDate) {
    const specificDate = inferSpecificDate(originalQuery, now, timeZone);
    if (specificDate) {
      structuredArguments.dateIntent = "specific_date";
      structuredArguments.specificDate = specificDate.date;
      consumedTerms.push(specificDate.term);
    }
  }

  if (!structuredArguments.dateIntent) {
    const dateIntent = DATE_INTENT_TERMS.find(({ terms }) =>
      terms.some((term) => originalQuery.includes(term))
    );
    if (dateIntent) {
      structuredArguments.dateIntent = dateIntent.intent;
    }
  }
  consumeMatchingDateTerms(originalQuery, structuredArguments.dateIntent, consumedTerms);

  if (!structuredArguments.meeting && originalQuery.includes("主日")) {
    structuredArguments.meeting = "主日";
  }
  consumeIfPresent(originalQuery, structuredArguments.meeting, consumedTerms);

  if (!structuredArguments.role) {
    structuredArguments.role = extractKnownScheduleRole(originalQuery);
  }
  consumeIfPresent(originalQuery, structuredArguments.role, consumedTerms);

  const mediaTerm = MEDIA_TERMS.find((term) => originalQuery.includes(term));
  if (mediaTerm) {
    structuredArguments.scheduleCategory = "media_team";
    consumedTerms.push(mediaTerm);
  }

  const scheduleTypeMatch = inferScheduleType(originalQuery);
  if (!structuredArguments.scheduleType && scheduleTypeMatch) {
    structuredArguments.scheduleType = scheduleTypeMatch.scheduleType;
  }
  if (scheduleTypeMatch) {
    consumedTerms.push(scheduleTypeMatch.term);
  }

  consumeIfPresent(originalQuery, structuredArguments.specificDate, consumedTerms);
  consumeIfPresent(originalQuery, structuredArguments.date, consumedTerms);

  return {
    originalQuery,
    structuredArguments,
    consumedTerms: Array.from(new Set(consumedTerms)),
    residualQuery: buildResidualQuery({
      query: originalQuery,
      consumedTerms,
      genericTerms: GENERIC_SCHEDULE_TERMS
    })
  };
}

function inferSpecificDate(
  query: string,
  now: Date,
  timeZone: string
): { date: string; term: string } | undefined {
  const dateKey = query.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
  if (dateKey) {
    return { date: dateKey, term: dateKey };
  }

  const match = query.match(/(?<month>\d{1,2})\s*[/／月]\s*(?<day>\d{1,2})\s*日?/u);
  if (!match?.groups) {
    return undefined;
  }
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "numeric"
  })
    .formatToParts(now)
    .reduce<Record<string, number>>((result, part) => {
      if (part.type === "year" || part.type === "month") {
        result[part.type] = Number(part.value);
      }
      return result;
    }, {});
  const currentYear = parts.year ?? now.getUTCFullYear();
  const currentMonth = parts.month ?? now.getUTCMonth() + 1;
  const year = month < currentMonth - 6 ? currentYear + 1 : currentYear;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    return undefined;
  }
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    term: match[0]
  };
}

function copyStructuredArguments(args: QueryScheduleArguments): QueryScheduleStructuredArguments {
  return Object.fromEntries(
    Object.entries({
      date: args.date,
      dateIntent: args.dateIntent,
      specificDate: args.specificDate,
      meeting: args.meeting,
      role: args.role,
      scheduleType: args.scheduleType,
      limit: args.limit
    }).filter(([, value]) => value !== undefined)
  ) as QueryScheduleStructuredArguments;
}

function consumeMatchingDateTerms(
  query: string,
  intent: QueryScheduleArguments["dateIntent"],
  consumedTerms: string[]
): void {
  const candidate = DATE_INTENT_TERMS.find((item) => item.intent === intent);
  const term = candidate?.terms.find((value) => query.includes(value));
  if (term) {
    consumedTerms.push(term);
  }
}

function consumeIfPresent(query: string, value: string | undefined, consumedTerms: string[]): void {
  if (value && query.includes(value)) {
    consumedTerms.push(value);
  }
}

function inferScheduleType(query: string):
  | {
      scheduleType: NonNullable<QueryScheduleArguments["scheduleType"]>;
      term: string;
    }
  | undefined {
  for (const term of ["為耶穌", "舉牌"]) {
    if (query.includes(term)) {
      return { scheduleType: "street_sign_service", term };
    }
  }
  for (const term of ["仙履奇緣", "晨更"]) {
    if (query.includes(term)) {
      return { scheduleType: "morning_prayer_family", term };
    }
  }
  return undefined;
}

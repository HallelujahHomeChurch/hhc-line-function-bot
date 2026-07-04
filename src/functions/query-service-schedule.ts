import { z } from "zod";

import type { FunctionHandler, JsonRecord, NotionDatabaseClient } from "../types.js";

const argsSchema = z.object({
  query: z.string().optional().default(""),
  date: z.string().optional(),
  meeting: z.string().optional(),
  role: z.string().optional()
});

export interface QueryServiceScheduleOptions {
  notion: NotionDatabaseClient;
  databaseId: string;
  properties: {
    date: string;
    meeting: string;
    role: string;
    person: string;
  };
  now?: () => Date;
}

interface ServiceRow {
  date: string;
  meeting: string;
  role: string;
  person: string;
}

interface DerivedFilters {
  date?: string;
  meeting?: string;
  role?: string;
  range?: {
    start: string;
    endExclusive: string;
  };
}

export function createQueryServiceScheduleHandler(
  options: QueryServiceScheduleOptions
): FunctionHandler {
  const now = options.now ?? (() => new Date());

  return async (rawArgs) => {
    const args = argsSchema.parse(rawArgs);
    const derivedFilters = deriveFilters(args, now());
    const pages = await options.notion.queryDatabase(
      options.databaseId,
      buildNotionQuery(derivedFilters, options.properties.date)
    );

    const rows = pages.map((page) => ({
      date: propertyToText(page.properties[options.properties.date]),
      meeting: propertyToText(page.properties[options.properties.meeting]),
      role: propertyToText(page.properties[options.properties.role]),
      person: propertyToText(page.properties[options.properties.person])
    }));

    const filtered = rows
      .filter((row) => matchesOptional(row.date, derivedFilters.date))
      .filter((row) => matchesOptional(row.meeting, derivedFilters.meeting))
      .filter((row) => matchesOptional(row.role, derivedFilters.role))
      .filter((row) => matchesDateRange(row.date, derivedFilters.range))
      .slice(0, 10);

    if (filtered.length === 0) {
      return {
        ok: true,
        replyText: "查不到符合的服事表。",
        quickReplies: [
          {
            label: "查本週服事",
            action: { type: "message", label: "查本週服事", text: "小哈 查本週服事" }
          },
          {
            label: "查主日服事",
            action: { type: "message", label: "查主日服事", text: "小哈 查主日服事" }
          }
        ]
      };
    }

    return {
      ok: true,
      replyText: filtered.map(formatRow).join("\n")
    };
  };
}

function buildNotionQuery(filters: DerivedFilters, dateProperty: string): JsonRecord {
  if (!filters.range) {
    return {};
  }

  return {
    filter: {
      and: [
        {
          property: dateProperty,
          date: {
            on_or_after: filters.range.start
          }
        },
        {
          property: dateProperty,
          date: {
            before: filters.range.endExclusive
          }
        }
      ]
    }
  };
}

function deriveFilters(args: z.infer<typeof argsSchema>, now: Date): DerivedFilters {
  const query = args.query.trim();
  const filters: DerivedFilters = {
    date: args.date,
    meeting: args.meeting,
    role: args.role
  };

  if (query.includes("今天")) {
    filters.range = dayRange(now, 0);
  } else if (query.includes("明天")) {
    filters.range = dayRange(now, 1);
  } else if (query.includes("後天") || query.includes("后天")) {
    filters.range = dayRange(now, 2);
  }

  if (/(本週|本周|這週|这周)/.test(query)) {
    filters.range = upcomingRange(now);
  }

  if (!filters.meeting && query.includes("主日")) {
    filters.meeting = "主日";
  }

  if (!filters.role) {
    filters.role = extractRole(query);
  }

  if (!filters.range && !filters.date && /服事/.test(query)) {
    filters.range = upcomingRange(now);
  }

  return filters;
}

function upcomingRange(now: Date): NonNullable<DerivedFilters["range"]> {
  return {
    start: toDateKey(now),
    endExclusive: toDateKey(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
  };
}

function dayRange(now: Date, offsetDays: number): NonNullable<DerivedFilters["range"]> {
  const start = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: toDateKey(start),
    endExclusive: toDateKey(end)
  };
}

function extractRole(query: string): string | undefined {
  const knownRoles = [
    "司會",
    "主席",
    "領詩",
    "敬拜",
    "司琴",
    "招待",
    "音控",
    "投影",
    "兒童",
    "講員"
  ];
  return knownRoles.find((role) => query.includes(role));
}

function matchesOptional(value: string, expected?: string): boolean {
  if (!expected?.trim()) {
    return true;
  }
  return value.toLowerCase().includes(expected.trim().toLowerCase());
}

function matchesDateRange(value: string, range: DerivedFilters["range"]): boolean {
  if (!range) {
    return true;
  }
  const date = extractDateKey(value);
  if (!date) {
    return false;
  }
  return date >= range.start && date < range.endExclusive;
}

function extractDateKey(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function toDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatRow(row: ServiceRow): string {
  const heading = `${row.date || "未填日期"} ${row.meeting || "未填聚會"}`;
  if (!row.role) {
    return `${heading}\n${row.person || "未填人員"}`;
  }
  return `${heading} - ${row.role}：${row.person || "未填人員"}`;
}

function propertyToText(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const value = property as JsonRecord;
  const type = typeof value.type === "string" ? value.type : "";

  switch (type) {
    case "title":
      return richTextArrayToText(value.title);
    case "rich_text":
      return richTextArrayToText(value.rich_text);
    case "date": {
      const date = value.date as { start?: string; end?: string } | null | undefined;
      return [date?.start, date?.end].filter(Boolean).join(" ~ ");
    }
    case "select": {
      const select = value.select as { name?: string } | null | undefined;
      return select?.name ?? "";
    }
    case "multi_select": {
      const items = value.multi_select as Array<{ name?: string }> | undefined;
      return (items ?? [])
        .map((item) => item.name)
        .filter(Boolean)
        .join(", ");
    }
    case "people": {
      const people = value.people as
        Array<{ name?: string; person?: { email?: string } }> | undefined;
      return (people ?? [])
        .map((person) => person.name ?? person.person?.email)
        .filter(Boolean)
        .join(", ");
    }
    case "formula": {
      const formula = value.formula as JsonRecord | undefined;
      if (!formula || typeof formula.type !== "string") {
        return "";
      }
      const formulaValue = formula[formula.type];
      return typeof formulaValue === "string" || typeof formulaValue === "number"
        ? String(formulaValue)
        : "";
    }
    case "number":
      return typeof value.number === "number" ? String(value.number) : "";
    case "url":
    case "email":
    case "phone_number":
      return typeof value[type] === "string" ? value[type] : "";
    case "checkbox":
      return typeof value.checkbox === "boolean" ? String(value.checkbox) : "";
    default:
      return "";
  }
}

function richTextArrayToText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (item && typeof item === "object" && "plain_text" in item) {
        return String((item as { plain_text?: string }).plain_text ?? "");
      }
      return "";
    })
    .join("");
}

import { z } from "zod";

import type { FunctionHandler, NotionDatabaseClient } from "../types.js";

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
}

export function createQueryServiceScheduleHandler(
  options: QueryServiceScheduleOptions
): FunctionHandler {
  return async (rawArgs) => {
    const args = argsSchema.parse(rawArgs);
    const pages = await options.notion.queryDatabase(options.databaseId);

    const rows = pages.map((page) => ({
      date: propertyToText(page.properties[options.properties.date]),
      meeting: propertyToText(page.properties[options.properties.meeting]),
      role: propertyToText(page.properties[options.properties.role]),
      person: propertyToText(page.properties[options.properties.person])
    }));

    const filtered = rows
      .filter((row) => matchesOptional(row.date, args.date))
      .filter((row) => matchesOptional(row.meeting, args.meeting))
      .filter((row) => matchesOptional(row.role, args.role))
      .slice(0, 10);

    if (filtered.length === 0) {
      return { ok: true, replyText: "查不到符合的服事表。" };
    }

    return {
      ok: true,
      replyText: filtered
        .map(
          (row) =>
            `${row.date || "未填日期"} ${row.meeting || "未填聚會"} - ${row.role || "未填服事"}：${row.person || "未填人員"}`
        )
        .join("\n")
    };
  };
}

function matchesOptional(value: string, expected?: string): boolean {
  if (!expected?.trim()) {
    return true;
  }
  return value.toLowerCase().includes(expected.trim().toLowerCase());
}

function propertyToText(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const value = property as Record<string, unknown>;
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
      const formula = value.formula as Record<string, unknown> | undefined;
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

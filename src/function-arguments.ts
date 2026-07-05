import { z } from "zod";

import type { FunctionName, JsonRecord } from "./types.js";

const numericLimitSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return value;
}, z.number().int().min(1).max(10));

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const findPptSlidesArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    originalQuery: z.string().optional(),
    includePdf: z.boolean().optional(),
    fileType: z.enum(["ppt", "pdf", "any"]).optional(),
    matchMode: z.enum(["fuzzy", "exact"]).optional()
  })
  .strip();

export const queryServiceScheduleArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    date: dateKeySchema.optional(),
    dateIntent: z
      .enum([
        "today",
        "tomorrow",
        "day_after_tomorrow",
        "this_week",
        "next_meeting",
        "specific_date",
        "upcoming"
      ])
      .optional(),
    specificDate: dateKeySchema.optional(),
    meeting: z.string().optional(),
    role: z.string().optional(),
    limit: numericLimitSchema.optional()
  })
  .strip()
  .superRefine((value, context) => {
    if (value.dateIntent === "specific_date" && !value.specificDate && !value.date) {
      context.addIssue({
        code: "custom",
        path: ["specificDate"],
        message: "specificDate or date is required when dateIntent is specific_date"
      });
    }
  });

export const findPopSheetMusicArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    artist: z.string().optional(),
    fileType: z.enum(["pdf", "image", "any"]).optional(),
    matchMode: z.enum(["fuzzy", "exact"]).optional()
  })
  .strip();

export type FindPptSlidesArguments = z.infer<typeof findPptSlidesArgumentsSchema>;
export type QueryServiceScheduleArguments = z.infer<typeof queryServiceScheduleArgumentsSchema>;
export type FindPopSheetMusicArguments = z.infer<typeof findPopSheetMusicArgumentsSchema>;

export function parseFunctionArguments(
  action: FunctionName,
  rawArguments: unknown
): JsonRecord | undefined {
  const schema = {
    find_ppt_slides: findPptSlidesArgumentsSchema,
    query_service_schedule: queryServiceScheduleArgumentsSchema,
    find_pop_sheet_music: findPopSheetMusicArgumentsSchema
  }[action];
  const parsed = schema.safeParse(rawArguments ?? {});
  return parsed.success ? (parsed.data as JsonRecord) : undefined;
}

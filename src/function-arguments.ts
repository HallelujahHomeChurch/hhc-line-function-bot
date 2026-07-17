import { z } from "zod";

import type { FunctionName, JsonRecord } from "./types.js";

const numericLimitSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return value;
}, z.number().int().min(1).max(10));

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/);
export const scheduleTypeSchema = z.enum([
  "morning_prayer_family",
  "street_sign_service",
  "custom_service_schedule"
]);

export const findPptSlidesArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    resourceId: z.string().optional(),
    driveId: z.string().optional(),
    itemId: z.string().optional(),
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

export const queryScheduleArgumentsSchema = z
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
    month: monthKeySchema.optional(),
    participant: z.string().optional(),
    domainKey: z.string().optional(),
    scheduleType: scheduleTypeSchema.optional(),
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
    resourceId: z.string().optional(),
    driveId: z.string().optional(),
    itemId: z.string().optional(),
    artist: z.string().optional(),
    fileType: z.enum(["pdf", "image", "any"]).optional(),
    matchMode: z.enum(["fuzzy", "exact"]).optional()
  })
  .strip();

export const findResourceArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    resourceId: z.string().optional(),
    itemKind: z.string().optional(),
    domain: z.string().optional(),
    limit: numericLimitSchema.optional()
  })
  .strip();

export const queryKnowledgeArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    sourceKey: z.string().trim().min(1).optional(),
    sourceId: z.string().trim().min(1).optional(),
    documentId: z.string().trim().min(1).optional(),
    sectionKey: z.string().trim().min(1).optional(),
    ordinal: z
      .preprocess(
        (value) => (typeof value === "string" ? Number(value) : value),
        z.number().int().min(0)
      )
      .optional(),
    limit: numericLimitSchema.optional()
  })
  .strip();

export const saveMemoryArgumentsSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional().default(""),
    query: z.string().optional(),
    visibility: z.enum(["private", "group"]).optional(),
    confirm: z.boolean().optional(),
    cancel: z.boolean().optional()
  })
  .strip();

export const saveResourceArgumentsSchema = z
  .object({
    url: z.string().optional().default(""),
    resourceType: z.enum(["ppt_slide", "sheet_music"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    visibility: z.enum(["private", "group"]).optional(),
    confirm: z.boolean().optional(),
    cancel: z.boolean().optional()
  })
  .strip();

export const retrieveMemoryArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    memoryId: z.string().optional()
  })
  .strip();

export const queryWikipediaArgumentsSchema = z
  .object({
    query: z.string().optional().default("")
  })
  .strip();

export const saveScheduleMemoryArgumentsSchema = z
  .object({
    operation: z
      .enum(["replace", "add_entry", "update_entry", "delete_entry", "delete_schedule"])
      .optional(),
    scheduleType: scheduleTypeSchema.optional(),
    title: z.string().optional(),
    content: z.string().optional().default(""),
    query: z.string().optional(),
    targetQuery: z.string().optional(),
    entry: z
      .object({
        serviceDate: dateKeySchema,
        weekday: z.string().optional(),
        meetingName: z.string(),
        role: z.string().optional(),
        assignee: z.string(),
        familyName: z.string().optional(),
        notes: z.string().optional()
      })
      .optional(),
    changes: z
      .object({
        serviceDate: dateKeySchema.optional(),
        weekday: z.string().optional(),
        meetingName: z.string().optional(),
        role: z.string().optional(),
        assignee: z.string().optional(),
        familyName: z.string().optional(),
        notes: z.string().optional()
      })
      .optional(),
    visibility: z.enum(["private", "group"]).optional(),
    confirm: z.boolean().optional(),
    cancel: z.boolean().optional()
  })
  .strip();

export const saveScheduleArgumentsSchema = saveScheduleMemoryArgumentsSchema;

export const queryScheduleMemoryArgumentsSchema = z
  .object({
    scheduleType: scheduleTypeSchema.optional(),
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
    month: monthKeySchema.optional(),
    participant: z.string().optional(),
    domainKey: z.string().optional(),
    limit: numericLimitSchema.optional()
  })
  .strip();

export type FindPptSlidesArguments = z.infer<typeof findPptSlidesArgumentsSchema>;
export type QueryServiceScheduleArguments = z.infer<typeof queryServiceScheduleArgumentsSchema>;
export type QueryScheduleArguments = z.infer<typeof queryScheduleArgumentsSchema>;
export type FindPopSheetMusicArguments = z.infer<typeof findPopSheetMusicArgumentsSchema>;
export type FindResourceArguments = z.infer<typeof findResourceArgumentsSchema>;
export type QueryKnowledgeArguments = z.infer<typeof queryKnowledgeArgumentsSchema>;
export type SaveMemoryArguments = z.infer<typeof saveMemoryArgumentsSchema>;
export type SaveResourceArguments = z.infer<typeof saveResourceArgumentsSchema>;
export type RetrieveMemoryArguments = z.infer<typeof retrieveMemoryArgumentsSchema>;
export type QueryWikipediaArguments = z.infer<typeof queryWikipediaArgumentsSchema>;
export type SaveScheduleMemoryArguments = z.infer<typeof saveScheduleMemoryArgumentsSchema>;
export type SaveScheduleArguments = z.infer<typeof saveScheduleArgumentsSchema>;
export type QueryScheduleMemoryArguments = z.infer<typeof queryScheduleMemoryArgumentsSchema>;

export function parseFunctionArguments(
  action: FunctionName,
  rawArguments: unknown
): JsonRecord | undefined {
  const schema = {
    find_ppt_slides: findPptSlidesArgumentsSchema,
    query_schedule: queryScheduleArgumentsSchema,
    query_knowledge: queryKnowledgeArgumentsSchema,
    save_schedule: saveScheduleArgumentsSchema,
    find_sheet_music: findPopSheetMusicArgumentsSchema,
    find_resource: findResourceArgumentsSchema,
    query_wikipedia: queryWikipediaArgumentsSchema,
    save_memory: saveMemoryArgumentsSchema,
    save_resource: saveResourceArgumentsSchema,
    retrieve_memory: retrieveMemoryArgumentsSchema
  }[action];
  const parsed = schema.safeParse(rawArguments ?? {});
  return parsed.success ? (parsed.data as JsonRecord) : undefined;
}

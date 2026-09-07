import type { CapabilityName } from "./capabilities/names.js";
import { z } from "zod";

import type { ScheduleDomainConfig } from "./types.js";
import type { JsonRecord } from "./types.js";

const numericLimitSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return value;
}, z.number().int().min(1).max(10));

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/);
export const downloadWeeklyPaperArgumentsSchema = z
  .object({
    issueNumber: z.number().int().min(1).max(2_147_483_647).optional()
  })
  .strip();

const profileNameSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (Array.from(value).length > 255 || /\p{Cc}|[\uD800-\uDFFF]/u.test(value)) {
      context.addIssue({ code: "custom", message: "invalid profile name" });
    }
  });

export type UpdateOwnProfileArgs = {
  firstName?: string;
  lastName?: string;
};

export const updateOwnProfileArgumentsSchema = z
  .object({
    firstName: profileNameSchema.optional(),
    lastName: profileNameSchema.optional(),
    confirm: z.boolean().optional(),
    cancel: z.boolean().optional()
  })
  .strip();
export const updateOwnProfileReviewArgumentsSchema = updateOwnProfileArgumentsSchema
  .omit({ confirm: true, cancel: true })
  .strict();
export const scheduleTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/u)
  .max(80);

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
export const findPptSlidesAgentArgumentsSchema = findPptSlidesArgumentsSchema.strict();

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
export const queryScheduleAgentArgumentsSchema = queryScheduleArgumentsSchema
  .safeExtend({ limit: z.number().int().min(1).max(10).optional() })
  .strict();

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
export const findPopSheetMusicAgentArgumentsSchema = findPopSheetMusicArgumentsSchema.strict();

export const findResourceArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    resourceId: z.string().optional(),
    itemKind: z.string().optional(),
    domain: z.string().optional(),
    limit: numericLimitSchema.optional()
  })
  .strip();
export const findResourceAgentArgumentsSchema = findResourceArgumentsSchema
  .safeExtend({ limit: z.number().int().min(1).max(10).optional() })
  .strict();

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
export const queryKnowledgeAgentArgumentsSchema = queryKnowledgeArgumentsSchema
  .safeExtend({
    ordinal: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(10).optional()
  })
  .strict();

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
export const saveMemoryAgentArgumentsSchema = saveMemoryArgumentsSchema
  .omit({ confirm: true, cancel: true })
  .safeExtend({
    title: z.string().trim().optional(),
    content: z.string().trim().optional().default(""),
    query: z.string().trim().optional()
  })
  .strict();

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
export const saveResourceAgentArgumentsSchema = saveResourceArgumentsSchema
  .omit({ confirm: true, cancel: true })
  .safeExtend({
    url: z.string().trim().optional().default(""),
    title: z.string().trim().optional(),
    description: z.string().trim().optional()
  })
  .strict();

export const retrieveMemoryArgumentsSchema = z
  .object({
    query: z.string().optional().default(""),
    memoryId: z.string().optional()
  })
  .strip();
export const retrieveMemoryAgentArgumentsSchema = retrieveMemoryArgumentsSchema.strict();

export const queryWikipediaArgumentsSchema = z
  .object({
    query: z.string().optional().default("")
  })
  .strip();
export const queryWikipediaAgentArgumentsSchema = queryWikipediaArgumentsSchema.strict();

export const scheduleEntryArgumentsSchema = z
  .object({
    serviceDate: dateKeySchema,
    weekday: z.enum(["日", "一", "二", "三", "四", "五", "六"]).optional(),
    meetingName: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(200).optional(),
    assignee: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("服事人員或家族名稱；括號中的角色、提醒等補充說明放 notes，勿併入姓名。"),
    familyName: z.string().trim().min(1).max(500).optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("保留這筆安排相關的括號補充與全表服事提醒；與服事無關的公告不列入。")
  })
  .strict();

export const saveScheduleMemoryArgumentsSchema = z
  .object({
    operation: z
      .enum(["replace", "add_entry", "update_entry", "delete_entry", "delete_schedule"])
      .optional()
      .describe(
        "貼上服事表使用 replace（預設），以 content + entries 預覽包含月份的完整替換；只有明確新增到既有月份才用 add_entry 並提供 entry。修改用 update_entry + targetQuery + changes；刪除須明確要求。"
      ),
    scheduleType: scheduleTypeSchema.optional(),
    domainKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/u)
      .max(80)
      .optional(),
    domainRevision: z.string().trim().min(1).max(80).optional(),
    title: z.string().optional(),
    content: z.string().optional().default(""),
    query: z.string().optional(),
    targetQuery: z.string().optional(),
    entries: z.array(scheduleEntryArgumentsSchema).min(1).max(100).optional(),
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
export const saveScheduleAgentArgumentsSchema = saveScheduleMemoryArgumentsSchema
  .omit({ confirm: true, cancel: true, visibility: true })
  .safeExtend({
    title: z.string().trim().optional(),
    content: z
      .string()
      .trim()
      .optional()
      .default("")
      .describe(
        "保留使用者提供的原文作核對，並將安排整理到 entries；略過表情符號和無關公告，保留相關備註，不捏造人員或日期。若年份未提供，依現在時間判定並在預覽顯示；真正有衝突才詢問。可一次包含多個月份；固定共用，不詢問可見範圍。"
      ),
    query: z.string().trim().optional(),
    targetQuery: z.string().trim().optional(),
    domainRevision: z.string().trim().min(1).max(80).optional()
  })
  .strict();

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
export type DownloadWeeklyPaperArguments = z.infer<typeof downloadWeeklyPaperArgumentsSchema>;
export type UpdateOwnProfileFunctionArguments = z.infer<typeof updateOwnProfileArgumentsSchema>;
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
  action: CapabilityName,
  rawArguments: unknown
): JsonRecord | undefined {
  const schema = {
    download_weekly_paper: downloadWeeklyPaperArgumentsSchema,
    update_own_profile: updateOwnProfileArgumentsSchema,
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

export const attachmentDraftArgumentsSchema = z
  .object({
    purpose: z.enum(["投影片", "流行歌譜", "詩歌歌譜", "小哈資料庫"]).optional(),
    title: z.string().trim().min(1).max(120).optional()
  })
  .strict();

/** Registry data is the sole source of model-facing schedule identifiers. */
export function scheduleDomainToolFields(domains: ScheduleDomainConfig[]) {
  return {
    domainKey: z
      .enum(domains.map((domain) => domain.key))
      .optional()
      .describe("選擇已設定的服事類型；不確定才省略，不能自行發明 key。"),
    scheduleType: z
      .enum(
        domains.flatMap((domain) =>
          domain.binding.kind === "saved_schedule" ? [domain.binding.scheduleType] : []
        )
      )
      .optional()
  };
}

export function scheduleDomainToolDescription(domains: ScheduleDomainConfig[]): string {
  return (
    "可用 domainKey：" + domains.map((domain) => `${domain.key}=${domain.displayName}`).join("；")
  );
}

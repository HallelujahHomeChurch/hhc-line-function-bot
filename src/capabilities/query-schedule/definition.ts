import { queryScheduleArgumentsSchema } from "../../function-arguments.js";
import type { FunctionDefinition } from "../../functions/definitions.js";

export const queryScheduleDefinition: FunctionDefinition = {
  name: "query_schedule",
  displayName: "查服事表",
  shortDescription: "依日期、聚會或服事類型查詢目前可用的服事安排。",
  examples: [
    "小哈 下一場服事表",
    "小哈 查主日服事",
    "小哈 查 7/19 舉牌服事",
    "小哈 查 7/17 晨更家族服事"
  ],
  requires: ["memory"],
  scope: "group_capable",
  sideEffectLevel: "read",
  agentCapability: {
    intents: ["查服事", "查服事表", "找服事", "下一場服事", "本週服事", "主日服事"],
    candidateHints: ["服事", "服事表", "服事安排", "聚會服事"],
    semanticDescription: "依日期、聚會、服事角色或服事表類型查詢安排。",
    arguments: {
      query: { type: "string", authority: "current_text" },
      date: { type: "string", authority: "model_grounded" },
      specificDate: { type: "string", authority: "model_grounded" },
      dateIntent: {
        type: "string",
        authority: "model_grounded",
        values: [
          "today",
          "tomorrow",
          "day_after_tomorrow",
          "this_week",
          "next_meeting",
          "specific_date",
          "upcoming"
        ]
      },
      meeting: { type: "string", authority: "model_grounded" },
      role: { type: "string", authority: "model_grounded" },
      month: { type: "string", authority: "model_grounded" },
      participant: { type: "string", authority: "model_grounded" },
      domainKey: { type: "string", authority: "active_task_only" },
      scheduleType: {
        type: "string",
        authority: "model_grounded",
        values: [
          "morning_prayer_family",
          "street_sign_service",
          "children_sunday",
          "prayer_meeting_family",
          "custom_service_schedule"
        ]
      },
      limit: { type: "number", authority: "explicit_current_text" }
    },
    retrievalEvidence: {
      provider: "schedule",
      queryStopWords: ["服事表", "服事安排"]
    },
    argumentEvidence: {
      queryArgument: "query",
      allOf: ["role"],
      anyOf: ["meeting", "date", "specificDate", "dateIntent"]
    },
    entityTypes: ["date", "meeting", "role", "scheduleType"],
    refinableFields: ["date", "specificDate", "dateIntent", "meeting", "role", "scheduleType"],
    operations: ["continue", "refine", "advance", "select"],
    responseProjection: {
      defaultMode: "focused",
      fields: {
        date: { label: "日期", aliases: ["日期", "哪一天", "何時", "什麼時候"] },
        meeting: { label: "聚會", aliases: ["聚會", "哪一場"] },
        scheduleType: { label: "服事表", aliases: ["類型", "哪種服事表"] },
        role: { label: "服事", aliases: ["誰", "人員", "角色", "家族"] }
      }
    },
    ambiguity: "clarify",
    activeEvidence: {
      arguments: {
        date: { entityTypes: ["date"], anchorKeys: ["date"] },
        specificDate: {
          entityTypes: ["date"],
          anchorKeys: ["specificDate", "date"]
        },
        dateIntent: { entityTypes: ["date"], anchorKeys: ["dateIntent"] },
        meeting: { entityTypes: ["meeting"], anchorKeys: ["meeting"] },
        role: { entityTypes: ["role"], anchorKeys: ["role"] },
        scheduleType: {
          entityTypes: ["scheduleType"],
          anchorKeys: ["scheduleType"]
        }
      }
    }
  },
  allowedSources: ["user", "group"],
  requiredSlots: [
    {
      name: "schedule_range_or_type",
      argument: "query",
      missingWhen: "blank",
      genericRequest: {
        phrases: [
          "服事",
          "服事表",
          "服事人員",
          "服事安排",
          "聚會服事",
          "聚會服事表",
          "聚會服事人員"
        ],
        clearArguments: ["date", "dateIntent", "specificDate", "meeting", "role"]
      },
      prompt: "要查哪一天、哪一場聚會，或哪一類服事？",
      quickReplies: [
        { label: "下一場", text: "下一場服事" },
        { label: "本週", text: "本週服事" },
        { label: "主日", text: "主日服事" },
        { label: "舉牌", text: "查舉牌服事" }
      ]
    }
  ],
  resourcePolicy: { kind: "none", remember: false, alias: false },
  memoryPolicy: { kind: "retrieve_text" },
  clarificationPrompt: "要查哪一天、哪一場聚會，或哪一類服事？",
  description:
    '- query_schedule: query service schedules by date, meeting, role, or schedule type. It may combine configured schedule sources, but never mention or ask the user to choose an internal data source. Arguments: {"query":"user request", "dateIntent":"today|tomorrow|day_after_tomorrow|this_week|next_meeting|specific_date|upcoming optional", "specificDate":"YYYY-MM-DD optional", "meeting":"optional", "role":"optional", "limit":number optional}.',
  argumentSchema: queryScheduleArgumentsSchema,
  quickReply: {
    label: "查服事表",
    command: "小哈 查服事表"
  },
  helpText: "依日期、聚會或類型查服事表，例如下一場、主日、晨更或舉牌。"
};

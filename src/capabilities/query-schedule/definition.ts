import { queryScheduleArgumentsSchema } from "../../function-arguments.js";
import type { FunctionDefinition } from "../catalog.js";

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
    semanticDescription: "查詢正式服事安排；日期或期間省略時，伺服器會依目前時間取得最新有效資料。",
    retrievalEvidence: {
      provider: "schedule",
      queryStopWords: ["服事表", "服事安排"]
    },
    operations: ["continue", "refine", "advance", "select"]
  },
  allowedSources: ["user", "group"],
  requiredSlots: [],
  resourcePolicy: { kind: "none", remember: false, alias: false },
  memoryPolicy: { kind: "retrieve_text" },
  clarificationPrompt: "要查哪一天、哪一場聚會，或哪一類服事？",
  description:
    '- query_schedule: query official service schedules by date, meeting, role, or schedule type. Omit date and period arguments to resolve the latest valid schedule at server time. It may combine configured schedule domains, but never mention or ask the user to choose an internal data source. Arguments: {"query":"user request", "dateIntent":"today|tomorrow|day_after_tomorrow|this_week|next_meeting|specific_date|upcoming optional", "specificDate":"YYYY-MM-DD optional", "meeting":"optional", "role":"optional", "limit":number optional}.',
  argumentSchema: queryScheduleArgumentsSchema,
  quickReply: {
    label: "查服事表",
    command: "小哈 查服事表"
  },
  helpText: "依日期、聚會或類型查服事表，例如下一場、主日、晨更或舉牌。"
};

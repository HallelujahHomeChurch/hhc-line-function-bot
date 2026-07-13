import type { z } from "zod";

import {
  findResourceArgumentsSchema,
  findPopSheetMusicArgumentsSchema,
  findPptSlidesArgumentsSchema,
  queryWikipediaArgumentsSchema,
  queryScheduleArgumentsSchema,
  queryKnowledgeArgumentsSchema,
  queryScheduleMemoryArgumentsSchema,
  queryServiceScheduleArgumentsSchema,
  retrieveMemoryArgumentsSchema,
  saveMemoryArgumentsSchema,
  saveResourceArgumentsSchema,
  saveScheduleArgumentsSchema,
  saveScheduleMemoryArgumentsSchema
} from "../function-arguments.js";
import type { AgentResourceType, FunctionName, JsonRecord } from "../types.js";

export interface FunctionKeywordFallback {
  keywords: string[];
  stripWords: string[];
  defaultArguments?: JsonRecord;
}

export type FunctionSideEffectLevel = "read" | "write" | "admin" | "destructive";
export type FunctionAllowedSource = "user" | "group";
export type FunctionRequiredSlotMissingWhen = "blank";

export interface FunctionGenericRequest {
  phrases: string[];
  clearArguments?: string[];
}

export interface FunctionRequiredSlot {
  name: string;
  argument: string;
  missingWhen: FunctionRequiredSlotMissingWhen;
  genericRequest?: FunctionGenericRequest;
  prompt: string;
  quickReplies?: Array<{
    label: string;
    text: string;
  }>;
}

export interface FunctionResourcePolicy {
  kind: "none" | "graph_file" | "external_link";
  resourceTypes?: AgentResourceType[];
  remember: boolean;
  alias: boolean;
}

export interface FunctionMemoryPolicy {
  kind: "none" | "resource_metadata" | "explicit_text" | "retrieve_text";
}

export interface AgentCapabilityContract {
  intents: string[];
  candidateHints: string[];
  entityTypes?: string[];
  refinableFields?: string[];
  operations?: Array<"continue" | "refine" | "advance" | "select">;
  ambiguity?: "clarify";
}

export interface FunctionDefinition {
  name: FunctionName;
  displayName: string;
  shortDescription: string;
  examples: string[];
  requires: Array<"graph" | "notion" | "session" | "cache" | "memory" | "wikipedia" | "knowledge">;
  scope: "profile" | "group_capable";
  sideEffectLevel: FunctionSideEffectLevel;
  agentCapability?: AgentCapabilityContract;
  allowedSources: FunctionAllowedSource[];
  requiredSlots: FunctionRequiredSlot[];
  resourcePolicy: FunctionResourcePolicy;
  memoryPolicy: FunctionMemoryPolicy;
  clarificationPrompt: string;
  description: string;
  argumentSchema: z.ZodType;
  quickReply: {
    label: string;
    command: string;
  };
  helpText: string;
  deprecated?: boolean;
  keywordFallback?: FunctionKeywordFallback;
  continuation?: FunctionContinuationPolicy;
}

export interface FunctionContinuationPolicy {
  carryArguments: string[];
  exclusiveGroups?: string[][];
}

const commonStripWords = ["小哈", "請", "幫我", "幫忙", "查詢", "查", "找", "搜尋"];

export const FUNCTION_DEFINITIONS: FunctionDefinition[] = [
  {
    name: "find_ppt_slides",
    displayName: "查投影片",
    shortDescription: "幫你找聚會或詩歌需要的投影片。",
    examples: ["小哈 查投影片 奇異恩典", "小哈 查主日報告投影片"],
    requires: ["graph", "session"],
    scope: "group_capable",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查投影片", "找投影片", "搜尋投影片", "查簡報", "找簡報"],
      candidateHints: ["投影片", "簡報", "ppt", "powerpoint", "slides", "keynote", "odp"],
      entityTypes: ["selection"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["投影片", "ppt", "powerpoint", "slides", "keynote", "odp"]
        },
        prompt: "要查哪一份投影片？請直接回覆名稱。"
      }
    ],
    resourcePolicy: {
      kind: "graph_file",
      resourceTypes: ["ppt_slide"],
      remember: true,
      alias: true
    },
    memoryPolicy: { kind: "resource_metadata" },
    clarificationPrompt: "要查哪一份投影片？請直接回覆名稱。",
    description:
      '- find_ppt_slides: find church presentation files by title or keyword. Only pptx, ppt, key, and odp files are searchable. Arguments: {"query":"extracted filename/title keyword", "originalQuery":"full user request optional", "matchMode":"fuzzy|exact optional"}. Use fuzzy for typo-tolerant song/title lookup.',
    argumentSchema: findPptSlidesArgumentsSchema,
    quickReply: {
      label: "查投影片",
      command: "小哈 查投影片"
    },
    helpText: "查教會投影片，找到後回 1 天有效下載連結。",
    keywordFallback: {
      keywords: ["投影片", "ppt", "powerpoint", "slides"],
      stripWords: [...commonStripWords, "投影片", "ppt", "powerpoint", "slides", "keynote", "odp"],
      defaultArguments: { matchMode: "fuzzy" }
    }
  },
  {
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
      entityTypes: ["date", "meeting", "role", "scheduleType"],
      refinableFields: ["date", "meeting", "role", "scheduleType"],
      operations: ["continue", "refine", "advance", "select"],
      ambiguity: "clarify"
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
    helpText: "依日期、聚會或類型查服事表，例如下一場、主日、晨更或舉牌。",
    keywordFallback: {
      keywords: ["服事表", "服事"],
      stripWords: [...commonStripWords]
    },
    continuation: {
      carryArguments: ["date", "dateIntent", "specificDate", "meeting", "role", "scheduleType"],
      exclusiveGroups: [["date", "dateIntent", "specificDate"]]
    }
  },
  {
    name: "query_knowledge",
    displayName: "查已加入知識",
    shortDescription: "查詢管理員已加入的計畫、SOP與其他內部知識。",
    examples: ["小哈 這次出遊第一個地點是哪裡", "小哈 聚會結束後場地怎麼復原"],
    requires: ["knowledge"],
    scope: "group_capable",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查知識", "知識查詢", "找知識"],
      candidateHints: ["知識", "sop", "計畫", "流程"],
      entityTypes: ["source", "document", "section", "ordinal"],
      refinableFields: ["source", "document", "section", "ordinal"],
      operations: ["continue", "refine", "advance", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: { phrases: ["查知識", "知識查詢"] },
        prompt: "想查已加入知識中的哪一項資訊？"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "none" },
    clarificationPrompt: "想查已加入知識中的哪一項資訊？",
    description:
      '- query_knowledge: answer from administrator-registered internal knowledge sources. Arguments: {"query":"full user question","sourceKey":"known source optional","documentId":"continuation document optional","ordinal":"zero-based requested item optional","limit":number optional}. Never use it for service schedules when query_schedule applies.',
    argumentSchema: queryKnowledgeArgumentsSchema,
    quickReply: { label: "查知識", command: "小哈 查知識" },
    helpText: "查詢管理員已加入的計畫、SOP與其他內部資訊。",
    keywordFallback: {
      keywords: ["查知識", "知識查詢", "SOP", "計畫"],
      stripWords: [...commonStripWords, "查知識", "知識查詢", "知識", "SOP"]
    },
    continuation: {
      carryArguments: []
    }
  },
  {
    name: "save_schedule",
    displayName: "記服事表",
    shortDescription: "把文字版服事表整理為可查詢的共用資料。",
    examples: ["小哈幫我記住這份晨更服事表：七/10五黃弘家族2"],
    requires: ["memory", "session"],
    scope: "group_capable",
    sideEffectLevel: "write",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "content",
        argument: "content",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["服事表", "記住服事表", "保存服事表", "儲存服事表"]
        },
        prompt: "請貼上要記住的服事表文字內容。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "explicit_text" },
    clarificationPrompt: "請貼上要記住的服事表文字內容。",
    description:
      '- save_schedule: manage the profile-shared canonical service schedule. Use operation "replace" with content for a full pasted schedule; "add_entry" with scheduleType and entry; "update_entry" with targetQuery and changes; "delete_entry" with targetQuery; or "delete_schedule" with targetQuery. Every write previews first unless confirm is true. Never invent content, targets, titles, or changes.',
    argumentSchema: saveScheduleArgumentsSchema,
    quickReply: {
      label: "記服事表",
      command: "小哈 幫我記住服事表"
    },
    helpText: "貼上文字版服事表，先整理預覽，確認後保存一年。",
    keywordFallback: {
      keywords: ["記住服事表", "保存服事表", "儲存服事表", "記住晨更", "記住舉牌"],
      stripWords: [...commonStripWords, "記住", "保存", "儲存", "服事表"]
    }
  },
  {
    name: "query_service_schedule",
    deprecated: true,
    displayName: "查服事表",
    shortDescription: "幫你看近期聚會的服事安排。",
    examples: ["小哈 下一場聚會服事表", "小哈 查主日服事"],
    requires: ["notion"],
    scope: "group_capable",
    sideEffectLevel: "read",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "service_schedule_range",
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
        prompt: "要查哪一場聚會或哪一天的服事？",
        quickReplies: [
          { label: "下一場", text: "下一場" },
          { label: "本週", text: "本週" },
          { label: "明天", text: "明天" },
          { label: "主日", text: "主日服事" }
        ]
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "none" },
    clarificationPrompt: "要查哪一場聚會或哪一天的服事？",
    description:
      '- query_service_schedule: query church meeting service schedule or serving assignments. Arguments: {"query":"original user request text", "dateIntent":"today|tomorrow|day_after_tomorrow|this_week|next_meeting|specific_date|upcoming optional", "specificDate":"YYYY-MM-DD required for specific_date", "meeting":"text optional", "role":"text optional", "limit": number optional}. For requests like 下一場/最近一場, use dateIntent next_meeting.',
    argumentSchema: queryServiceScheduleArgumentsSchema,
    quickReply: {
      label: "查服事表",
      command: "小哈 查服事表"
    },
    helpText: "查 Notion 上的聚會服事安排，例如下一場、本週、明天或主日。",
    keywordFallback: {
      keywords: ["服事表", "服事"],
      stripWords: [...commonStripWords]
    }
  },
  {
    name: "find_sheet_music",
    displayName: "查歌譜",
    shortDescription: "搜尋已設定的流行歌譜與詩歌歌譜，並回傳可開啟的臨時連結。",
    examples: ["小哈 查歌譜 Yesterday", "小哈 找 A TIME FOR US 歌譜"],
    requires: ["graph", "cache"],
    scope: "group_capable",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查歌譜", "找歌譜", "搜尋歌譜", "查樂譜", "找樂譜"],
      candidateHints: ["歌譜", "樂譜", "流行歌譜", "詩歌歌譜", "sheet music", "score"],
      entityTypes: ["selection"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["歌譜", "樂譜", "流行歌譜", "詩歌歌譜", "sheet music", "score"]
        },
        prompt: "請告訴我要查哪一首歌的歌譜。"
      }
    ],
    resourcePolicy: {
      kind: "graph_file",
      resourceTypes: ["sheet_music"],
      remember: true,
      alias: true
    },
    memoryPolicy: { kind: "resource_metadata" },
    clarificationPrompt: "請告訴我要查哪一首歌的歌譜。",
    description:
      '- find_sheet_music: find configured sheet music PDF/image files by song title or artist. It may search multiple configured catalog item kinds such as pop_sheet and hymn_sheet without asking the user to choose an internal source. Arguments: {"query":"song title keyword", "artist":"artist optional", "fileType":"pdf|image|any optional", "matchMode":"fuzzy|exact optional"}.',
    argumentSchema: findPopSheetMusicArgumentsSchema,
    quickReply: {
      label: "查歌譜",
      command: "小哈 查歌譜"
    },
    helpText: "查詢已設定的流行歌譜或詩歌歌譜；本地找不到時可詢問是否上網找公開結果。",
    keywordFallback: {
      keywords: ["歌譜", "樂譜", "流行歌譜", "詩歌歌譜", "sheet music", "score"],
      stripWords: [
        ...commonStripWords,
        "歌譜",
        "樂譜",
        "流行歌譜",
        "詩歌歌譜",
        "sheet music",
        "score",
        "pdf",
        "jpg",
        "jpeg",
        "png",
        "image"
      ],
      defaultArguments: { fileType: "pdf", matchMode: "fuzzy" }
    }
  },
  {
    name: "find_pop_sheet_music",
    deprecated: true,
    displayName: "查流行歌譜",
    shortDescription: "協助查找流行歌曲樂譜，適合同工臨時找譜使用。",
    examples: ["小哈 查流行歌譜 Yesterday", "小哈 幫我找 A TIME FOR US 的樂譜"],
    requires: ["graph", "cache"],
    scope: "group_capable",
    sideEffectLevel: "read",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["譜", "流行歌譜", "流行歌曲樂譜", "歌譜", "樂譜", "sheet music", "score"]
        },
        prompt: "要查哪一首流行歌曲樂譜？請直接回覆歌名。"
      }
    ],
    resourcePolicy: {
      kind: "graph_file",
      resourceTypes: ["sheet_music"],
      remember: true,
      alias: true
    },
    memoryPolicy: { kind: "resource_metadata" },
    clarificationPrompt: "要查哪一首流行歌曲樂譜？請直接回覆歌名。",
    description:
      '- find_pop_sheet_music: find pop song sheet music PDF/image files by title or artist. Arguments: {"query":"song title keyword", "artist":"artist optional", "fileType":"pdf|image|any optional", "matchMode":"fuzzy|exact optional"}. Use this only for 流行歌譜, 流行歌曲樂譜, 樂譜, or sheet music requests.',
    argumentSchema: findPopSheetMusicArgumentsSchema,
    quickReply: {
      label: "查流行歌譜",
      command: "小哈 查流行歌譜"
    },
    helpText: "查 OneDrive 裡的流行歌曲樂譜 PDF 或圖片，找到後回 1 天有效下載連結。",
    keywordFallback: {
      keywords: ["流行歌譜", "流行歌曲樂譜", "樂譜", "歌譜", "sheet music"],
      stripWords: [
        ...commonStripWords,
        "流行歌譜",
        "流行歌曲樂譜",
        "流行歌曲",
        "樂譜",
        "歌譜",
        "sheet music",
        "pdf",
        "jpg",
        "jpeg",
        "png",
        "圖片",
        "image"
      ],
      defaultArguments: { fileType: "pdf", matchMode: "fuzzy" }
    }
  },
  {
    name: "save_schedule_memory",
    deprecated: true,
    displayName: "記服事表",
    shortDescription: "把文字版服事表整理成可查詢的短期記憶。",
    examples: ["小哈幫我記住這份晨更服事表：七/10五黃弘家族2"],
    requires: ["memory", "session"],
    scope: "group_capable",
    sideEffectLevel: "write",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "content",
        argument: "content",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["服事表", "記住服事表", "保存服事表", "儲存服事表"]
        },
        prompt: "請貼上要記住的服事表文字內容。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "explicit_text" },
    clarificationPrompt: "請貼上要記住的服事表文字內容。",
    description:
      '- save_schedule_memory: save one canonical structured text-only service schedule such as 晨更家族服事表 or 為耶穌舉牌服事表. Arguments: {"content":"full pasted schedule text", "scheduleType":"morning_prayer_family|street_sign_service|custom_service_schedule optional", "title":"optional", "visibility":"private|group optional", "confirm": boolean optional}. Preview first unless confirm is true. Do not use for images or duplicate text memories.',
    argumentSchema: saveScheduleMemoryArgumentsSchema,
    quickReply: {
      label: "記服事表",
      command: "小哈 幫我記住服事表"
    },
    helpText: "貼上文字版服事表，先整理預覽，確認後保存一年。",
    keywordFallback: {
      keywords: ["記住服事表", "保存服事表", "儲存服事表", "記住晨更", "記住舉牌"],
      stripWords: [...commonStripWords, "記住", "保存", "儲存", "服事表"]
    }
  },
  {
    name: "find_resource",
    displayName: "查教會資料",
    shortDescription: "搜尋已同步的小哈資料庫或其他泛用教會資料。",
    examples: ["小哈 查教會資料 週報音檔", "小哈 找 2026-07 週報音檔"],
    requires: ["graph"],
    scope: "group_capable",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查教會資料", "找教會資料", "查小哈資料庫", "找小哈資料庫"],
      candidateHints: ["教會資料", "小哈資料庫", "週報音檔"],
      entityTypes: ["selection"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["教會資料", "小哈資料庫", "文件", "音檔"]
        },
        prompt: "請告訴我要查什麼教會資料。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "none" },
    clarificationPrompt: "請告訴我要查什麼教會資料。",
    description:
      '- find_resource: search the authorized internal church catalog for general resources such as documents, images, or future audio sources. Do not use this for clear schedule, presentation, or sheet-music requests; use the specialized functions instead. Arguments: {"query":"keyword", "itemKind":"optional catalog item kind", "domain":"optional domain", "limit":number optional}.',
    argumentSchema: findResourceArgumentsSchema,
    quickReply: {
      label: "查教會資料",
      command: "小哈 查教會資料"
    },
    helpText: "查詢小哈資料庫或其他已授權的泛用教會資料。",
    keywordFallback: {
      keywords: ["教會資料", "小哈資料庫", "文件", "音檔"],
      stripWords: [...commonStripWords, "教會資料", "小哈資料庫", "文件", "音檔"],
      defaultArguments: {}
    }
  },
  {
    name: "query_schedule_memory",
    deprecated: true,
    displayName: "查記住的服事",
    shortDescription: "查詢已記住的文字版服事表，不混用既有影視團隊服事表。",
    examples: ["小哈查7/19舉牌", "小哈查7/17晨更家族服事"],
    requires: ["memory"],
    scope: "group_capable",
    sideEffectLevel: "read",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["記住的服事", "保存的服事", "服事表"]
        },
        prompt: "請告訴我要查哪個已記住的服事，例如 7/19 舉牌。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "retrieve_text" },
    clarificationPrompt: "請告訴我要查哪個已記住的服事，例如 7/19 舉牌。",
    description:
      '- query_schedule_memory: query structured saved schedule memories. Arguments: {"query":"date/type/topic", "scheduleType":"morning_prayer_family|street_sign_service|custom_service_schedule optional", "date":"YYYY-MM-DD optional", "meeting":"optional", "limit": number optional}. Use this for saved 晨更家族 or 舉牌 schedules, not the media team service schedule.',
    argumentSchema: queryScheduleMemoryArgumentsSchema,
    quickReply: {
      label: "查記住的服事",
      command: "小哈 查記住的服事"
    },
    helpText: "查已保存的文字版服事表，例如晨更家族或為耶穌舉牌。",
    keywordFallback: {
      keywords: ["查舉牌", "查晨更家族", "查記住的服事", "查保存的服事"],
      stripWords: [...commonStripWords, "查", "找", "看", "記住的", "保存的", "服事表"]
    }
  },
  {
    name: "query_wikipedia",
    displayName: "查維基百科",
    shortDescription: "查詢維基百科條目並整理重點。",
    examples: ["小哈 查維基百科 馬丁路德", "小哈 維基百科告訴我什麼是量子力學"],
    requires: ["wikipedia"],
    scope: "group_capable",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查維基百科", "找維基百科", "查wiki", "查wikipedia"],
      candidateHints: ["維基百科", "wiki", "wikipedia"],
      entityTypes: ["topic"],
      refinableFields: ["topic"],
      operations: ["continue", "refine", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["維基百科", "wiki", "wikipedia"]
        },
        prompt: "想查哪個維基百科主題？"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "none" },
    clarificationPrompt: "想查哪個維基百科主題？",
    description:
      '- query_wikipedia: look up one encyclopedia topic in Wikipedia. Arguments: {"query":"topic or person to look up"}. Use only for requests that explicitly ask for Wikipedia or ask for a factual encyclopedia explanation.',
    argumentSchema: queryWikipediaArgumentsSchema,
    quickReply: {
      label: "查維基百科",
      command: "小哈 查維基百科"
    },
    helpText: "查維基百科條目並整理重點。",
    keywordFallback: {
      keywords: ["維基百科", "wiki", "wikipedia"],
      stripWords: [...commonStripWords, "維基百科", "wiki", "wikipedia", "查", "查詢", "幫我"]
    }
  },
  {
    name: "save_memory",
    displayName: "記住資訊",
    shortDescription: "保存使用者明確要求小哈記住的文字資訊。",
    examples: ["小哈幫我記住這個月服事表：主日導播是小明"],
    requires: ["memory"],
    scope: "profile",
    sideEffectLevel: "write",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "content",
        argument: "content",
        missingWhen: "blank",
        prompt: "請直接告訴我要記住的內容。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "explicit_text" },
    clarificationPrompt: "請直接告訴我要記住的內容。",
    description:
      '- save_memory: save explicit user-provided text memory only when the user clearly asks the bot to remember/save/store information. Arguments: {"title":"short optional title", "content":"the exact text to remember", "query":"optional lookup phrase"}. Do not use for passive group chatter.',
    argumentSchema: saveMemoryArgumentsSchema,
    quickReply: {
      label: "記住資訊",
      command: "小哈幫我記住："
    },
    helpText: "保存你明確交代小哈記住的文字資訊，預設只保留一段時間。",
    keywordFallback: {
      keywords: ["幫我記住", "記住這個", "幫我保存", "幫我儲存"],
      stripWords: [...commonStripWords, "幫我記住", "記住這個", "幫我保存", "幫我儲存"]
    }
  },
  {
    name: "save_resource",
    displayName: "保存連結資源",
    shortDescription: "保存同工明確交代的投影片或歌譜 HTTPS 連結。",
    examples: [
      "小哈幫我保存這份投影片 https://example.org/slides 名稱是青年聚會投影片",
      "小哈保存歌譜 https://example.org/score 名稱是恩典之路歌譜"
    ],
    requires: ["memory", "session"],
    scope: "group_capable",
    sideEffectLevel: "write",
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "url",
        argument: "url",
        missingWhen: "blank",
        prompt: "請提供要保存的 HTTPS 連結。"
      },
      {
        name: "resource_type",
        argument: "resourceType",
        missingWhen: "blank",
        prompt: "這是投影片還是歌譜？"
      },
      {
        name: "title",
        argument: "title",
        missingWhen: "blank",
        prompt: "請提供這份資源的名稱。"
      }
    ],
    resourcePolicy: {
      kind: "external_link",
      resourceTypes: ["ppt_slide", "sheet_music"],
      remember: true,
      alias: false
    },
    memoryPolicy: { kind: "explicit_text" },
    clarificationPrompt: "請提供要保存的連結、類型與名稱。",
    description:
      '- save_resource: save an explicit HTTPS link as a private resource by default. Arguments: {"url":"https URL", "resourceType":"ppt_slide|sheet_music", "title":"user-provided title", "description":"optional", "visibility":"private|group optional", "confirm":boolean optional}. Always preview before persisting. Use visibility group only when the requester explicitly asks to share with the group.',
    argumentSchema: saveResourceArgumentsSchema,
    quickReply: {
      label: "保存連結",
      command: "小哈幫我保存投影片連結："
    },
    helpText: "保存明確提供的投影片或歌譜 HTTPS 連結；預設私人，需確認後才寫入。",
    keywordFallback: {
      keywords: ["保存投影片", "儲存投影片", "記住投影片", "保存歌譜", "儲存歌譜", "記住歌譜"],
      stripWords: [...commonStripWords, "保存", "儲存", "記住", "投影片", "歌譜", "樂譜"]
    }
  },
  {
    name: "retrieve_memory",
    displayName: "查記住的資訊",
    shortDescription: "查詢使用者曾明確請小哈記住的資訊。",
    examples: ["小哈查我記住的服事表"],
    requires: ["memory"],
    scope: "profile",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查我記住的", "查我保存的", "查我儲存的", "查記住的資訊"],
      candidateHints: ["記住的資訊", "保存的資訊", "小哈記得"],
      entityTypes: ["selection"],
      refinableFields: ["query", "selection"],
      operations: ["continue", "refine", "select"],
      ambiguity: "clarify"
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["記憶", "記住的資訊", "已記住的資訊", "保存的資訊", "已保存的資訊"]
        },
        prompt: "要查哪一段記住的資訊？請回覆關鍵字。"
      }
    ],
    resourcePolicy: { kind: "none", remember: false, alias: false },
    memoryPolicy: { kind: "retrieve_text" },
    clarificationPrompt: "請告訴我要查哪一段記住的資訊。",
    description:
      '- retrieve_memory: retrieve explicit saved text memories. Arguments: {"query":"keyword or topic to search"}. Use only when the user asks what the bot remembered/saved/stored.',
    argumentSchema: retrieveMemoryArgumentsSchema,
    quickReply: {
      label: "查記憶",
      command: "小哈查我記住的"
    },
    helpText: "查詢先前明確保存的文字資訊。",
    keywordFallback: {
      keywords: ["查我記住", "查我保存", "查我儲存", "我記住的", "小哈記得"],
      stripWords: [
        ...commonStripWords,
        "查我記住的",
        "查我保存的",
        "查我儲存的",
        "我記住的",
        "小哈記得"
      ]
    }
  }
];

export function getFunctionDefinition(name: FunctionName): FunctionDefinition | undefined {
  return FUNCTION_DEFINITIONS.find((definition) => definition.name === name);
}

export function getFunctionDefinitions(names: FunctionName[]): FunctionDefinition[] {
  return names
    .map((name) => getFunctionDefinition(name))
    .filter((definition): definition is FunctionDefinition => Boolean(definition));
}

export function isGrantableFunctionName(name: FunctionName): boolean {
  return !getFunctionDefinition(name)?.deprecated;
}

export function userFacingFunctionNames(): FunctionName[] {
  return FUNCTION_DEFINITIONS.filter((definition) => !definition.deprecated).map(
    (definition) => definition.name
  );
}

import type { z } from "zod";

import {
  findResourceArgumentsSchema,
  findPopSheetMusicArgumentsSchema,
  findPptSlidesArgumentsSchema,
  queryWikipediaArgumentsSchema,
  queryScheduleArgumentsSchema,
  queryKnowledgeArgumentsSchema,
  retrieveMemoryArgumentsSchema,
  saveMemoryArgumentsSchema,
  saveResourceArgumentsSchema,
  saveScheduleArgumentsSchema
} from "../function-arguments.js";
import type { AgentResourceType, FunctionName } from "../types.js";

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

export interface FunctionGrantPolicy {
  principals: Array<"user" | "group">;
}

export type AgentOperation = "continue" | "refine" | "advance" | "select" | "view_full";

export interface AgentResponseField {
  label: string;
  aliases: string[];
}

export interface AgentResponseProjection {
  defaultMode: "focused" | "full";
  fields: Record<string, AgentResponseField>;
}

export interface AgentCapabilityHandoff {
  on: "success";
  to: FunctionName;
  map: Record<string, string>;
  when?: Record<string, string>;
}

export interface AgentCapabilityContract {
  intents: string[];
  candidateHints: string[];
  semanticDescription: string;
  genericWriteFallback?: boolean;
  argumentEvidence?: AgentArgumentEvidenceContract;
  retrievalEvidence?: { provider: string };
  entityTypes?: string[];
  refinableFields?: string[];
  operations: AgentOperation[];
  responseProjection: AgentResponseProjection;
  handoffs?: AgentCapabilityHandoff[];
  ambiguity?: "clarify";
  activeEvidence?: AgentActiveEvidenceContract;
}

export interface AgentArgumentEvidenceContract {
  queryArgument: string;
  allOf: string[];
  anyOf?: string[];
}

export interface AgentActiveEvidenceRule {
  entityTypes?: string[];
  anchorKeys?: string[];
  referenceKeys?: string[];
}

export interface AgentActiveEvidenceContract {
  arguments?: Record<string, AgentActiveEvidenceRule>;
  references?: Record<string, AgentActiveEvidenceRule>;
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
  grantPolicy?: FunctionGrantPolicy;
  clarificationPrompt: string;
  description: string;
  argumentSchema: z.ZodType;
  quickReply: {
    label: string;
    command: string;
  };
  helpText: string;
}

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
      semanticDescription: "依名稱或關鍵字搜尋教會投影片檔案。",
      retrievalEvidence: { provider: "catalog_presentation" },
      entityTypes: ["resource"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select", "view_full"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          title: { label: "投影片", aliases: ["名稱", "標題", "哪一份"] },
          link: { label: "連結", aliases: ["連結", "下載", "開啟"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: { query: { entityTypes: ["resource"] } }
      }
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
    helpText: "查教會投影片，找到後回 1 天有效下載連結。"
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
      semanticDescription: "依日期、聚會、服事角色或服事表類型查詢安排。",
      retrievalEvidence: { provider: "schedule" },
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
      semanticDescription: "從管理員已加入的內部知識回答問題。",
      retrievalEvidence: { provider: "knowledge" },
      entityTypes: ["source", "document", "section", "ordinal"],
      refinableFields: ["sourceKey", "sourceId", "documentId", "sectionKey", "ordinal"],
      operations: ["continue", "refine", "select"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          answer: { label: "答案", aliases: ["是什麼", "哪裡", "誰", "如何", "為什麼"] },
          ordinal: { label: "順序", aliases: ["第一個", "第二個", "第幾個"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: {
          sourceKey: { entityTypes: ["source"] },
          sourceId: { entityTypes: ["source"], anchorKeys: ["sourceId"] },
          documentId: {
            entityTypes: ["document"],
            anchorKeys: ["documentId"],
            referenceKeys: ["documentId"]
          },
          sectionKey: {
            entityTypes: ["section"],
            anchorKeys: ["sectionKey"],
            referenceKeys: ["sectionKey"]
          },
          ordinal: { entityTypes: ["ordinal"], anchorKeys: ["ordinal"] }
        },
        references: {
          documentId: { referenceKeys: ["documentId"] }
        }
      }
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
      '- query_knowledge: answer from administrator-registered internal knowledge sources. Arguments: {"query":"full user question","sourceKey":"eligible source key optional","sourceId":"active-task opaque source id optional","documentId":"active-task document id optional","sectionKey":"active-task opaque section id optional","ordinal":"zero-based requested item optional","limit":number optional}. Never use it for service schedules when query_schedule applies.',
    argumentSchema: queryKnowledgeArgumentsSchema,
    quickReply: { label: "查知識", command: "小哈 查知識" },
    helpText: "查詢管理員已加入的計畫、SOP與其他內部資訊。"
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
    grantPolicy: { principals: ["user"] },
    agentCapability: {
      intents: [
        "服事表",
        "幫我記住服事表",
        "記住服事表",
        "保存服事表",
        "儲存服事表",
        "新增服事",
        "修改服事",
        "刪除服事"
      ],
      candidateHints: ["服事表"],
      semanticDescription: "整理並保存使用者明確提供的共用服事表。",
      entityTypes: ["schedule"],
      refinableFields: ["content", "scheduleType", "operation", "targetQuery"],
      operations: [],
      responseProjection: {
        defaultMode: "focused",
        fields: { summary: { label: "保存結果", aliases: ["保存", "結果"] } }
      },
      handoffs: [
        {
          on: "success",
          to: "query_schedule",
          map: { scheduleType: "scheduleType" }
        }
      ],
      ambiguity: "clarify"
    },
    clarificationPrompt: "請貼上要記住的服事表文字內容。",
    description:
      '- save_schedule: manage the profile-shared canonical service schedule. Use operation "replace" with content for a full pasted schedule; "add_entry" with scheduleType and entry; "update_entry" with targetQuery and changes; "delete_entry" with targetQuery; or "delete_schedule" with targetQuery. Every write previews first unless confirm is true. Never invent content, targets, titles, or changes.',
    argumentSchema: saveScheduleArgumentsSchema,
    quickReply: {
      label: "記服事表",
      command: "小哈 幫我記住服事表"
    },
    helpText: "貼上文字版服事表，先整理預覽，確認後保存一年。"
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
      semanticDescription: "依歌名、演出者或檔案類型搜尋歌譜。",
      retrievalEvidence: { provider: "catalog_sheet_music" },
      entityTypes: ["resource"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select", "view_full"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          title: { label: "歌譜", aliases: ["名稱", "歌名", "哪一份"] },
          link: { label: "連結", aliases: ["連結", "下載", "開啟"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: { query: { entityTypes: ["resource"] } }
      }
    },
    allowedSources: ["user", "group"],
    requiredSlots: [
      {
        name: "query",
        argument: "query",
        missingWhen: "blank",
        genericRequest: {
          phrases: ["歌譜", "樂譜", "查譜", "流行歌譜", "詩歌歌譜", "sheet music", "score"]
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
    helpText: "查詢已設定的流行歌譜或詩歌歌譜；本地找不到時可詢問是否上網找公開結果。"
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
      semanticDescription: "搜尋已授權的泛用教會文件、圖片或音檔資源。",
      retrievalEvidence: { provider: "catalog_general" },
      entityTypes: ["resource"],
      refinableFields: ["query", "type", "selection"],
      operations: ["continue", "refine", "select", "view_full"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          title: { label: "資料", aliases: ["名稱", "標題", "哪一份"] },
          link: { label: "連結", aliases: ["連結", "下載", "開啟"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: { query: { entityTypes: ["resource"] } }
      }
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
    helpText: "查詢小哈資料庫或其他已授權的泛用教會資料。"
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
      semanticDescription: "查詢一個維基百科主題並回答相關事實問題。",
      entityTypes: ["topic"],
      refinableFields: ["query"],
      operations: ["continue", "refine", "view_full"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          answer: { label: "答案", aliases: ["誰", "什麼", "何時", "哪裡", "為什麼"] },
          summary: { label: "摘要", aliases: ["摘要", "完整內容", "全文"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: { query: { entityTypes: ["topic"] } }
      }
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
    helpText: "查維基百科條目並整理重點。"
  },
  {
    name: "save_memory",
    displayName: "記住資訊",
    shortDescription: "保存使用者明確請我記住的文字資訊。",
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
    grantPolicy: { principals: ["user"] },
    agentCapability: {
      intents: ["幫我記住", "記住這個", "幫我保存", "幫我儲存", "保存這段資訊"],
      candidateHints: ["記住", "保存", "儲存"],
      semanticDescription: "保存使用者明確要求記住的文字資訊。",
      genericWriteFallback: true,
      entityTypes: ["memory"],
      refinableFields: ["title", "content", "visibility"],
      operations: [],
      responseProjection: {
        defaultMode: "focused",
        fields: { summary: { label: "保存結果", aliases: ["保存", "結果"] } }
      },
      handoffs: [
        {
          on: "success",
          to: "retrieve_memory",
          map: { memoryId: "memoryId" }
        }
      ],
      ambiguity: "clarify"
    },
    clarificationPrompt: "請直接告訴我要記住的內容。",
    description:
      '- save_memory: save explicit user-provided text memory only when the user clearly asks the bot to remember/save/store information. Arguments: {"title":"short optional title", "content":"the exact text to remember", "query":"optional lookup phrase"}. Do not use for passive group chatter.',
    argumentSchema: saveMemoryArgumentsSchema,
    quickReply: {
      label: "記住資訊",
      command: "小哈幫我記住："
    },
    helpText: "保存你明確交代我記住的文字資訊，預設只保留一段時間。"
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
    agentCapability: {
      intents: ["保存連結", "保存檔案", "上傳檔案", "幫我保存"],
      candidateHints: ["保存", "上傳", "檔案", "連結"],
      semanticDescription: "經確認後保存投影片、歌譜或泛用教會資源。",
      entityTypes: ["resource"],
      refinableFields: ["url", "resourceType", "title", "visibility"],
      operations: [],
      responseProjection: {
        defaultMode: "focused",
        fields: { summary: { label: "保存結果", aliases: ["保存", "結果"] } }
      },
      handoffs: [
        {
          on: "success",
          to: "find_ppt_slides",
          map: { query: "title" },
          when: { resourceKind: "ppt_slide" }
        },
        {
          on: "success",
          to: "find_sheet_music",
          map: { query: "title" },
          when: { resourceKind: "sheet_music" }
        },
        {
          on: "success",
          to: "find_resource",
          map: { query: "title" },
          when: { resourceKind: "resource" }
        }
      ],
      ambiguity: "clarify"
    },
    clarificationPrompt: "請提供要保存的連結、類型與名稱。",
    description:
      '- save_resource: save an explicit HTTPS link as a private resource by default. Arguments: {"url":"https URL", "resourceType":"ppt_slide|sheet_music", "title":"user-provided title", "description":"optional", "visibility":"private|group optional", "confirm":boolean optional}. Always preview before persisting. Use visibility group only when the requester explicitly asks to share with the group.',
    argumentSchema: saveResourceArgumentsSchema,
    quickReply: {
      label: "保存連結",
      command: "小哈幫我保存投影片連結："
    },
    helpText: "保存明確提供的投影片或歌譜 HTTPS 連結；預設私人，需確認後才寫入。"
  },
  {
    name: "retrieve_memory",
    displayName: "查記住的資訊",
    shortDescription: "查詢使用者曾明確請我記住的資訊。",
    examples: ["小哈查我記住的服事表"],
    requires: ["memory"],
    scope: "profile",
    sideEffectLevel: "read",
    agentCapability: {
      intents: ["查我記住的", "查我保存的", "查我儲存的", "查記住的資訊"],
      candidateHints: ["記住的資訊", "保存的資訊", "小哈記得"],
      semanticDescription: "查詢目前來源中可見且未過期的明確文字記憶。",
      retrievalEvidence: { provider: "memory" },
      entityTypes: ["memory"],
      refinableFields: ["query", "selection"],
      operations: ["continue", "refine", "select", "view_full"],
      responseProjection: {
        defaultMode: "focused",
        fields: {
          answer: { label: "答案", aliases: ["誰", "什麼", "何時", "哪裡", "內容"] },
          title: { label: "記憶", aliases: ["名稱", "標題", "哪一段"] }
        }
      },
      ambiguity: "clarify",
      activeEvidence: {
        arguments: { query: { entityTypes: ["memory"] } }
      }
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
    helpText: "查詢先前明確保存的文字資訊。"
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
  return Boolean(getFunctionDefinition(name));
}

export function isFunctionGrantableForPrincipal(
  name: FunctionName,
  principal: "user" | "group"
): boolean {
  const definition = getFunctionDefinition(name);
  return Boolean(
    definition && (definition.grantPolicy?.principals ?? ["user", "group"]).includes(principal)
  );
}

export function userFacingFunctionNames(): FunctionName[] {
  return FUNCTION_DEFINITIONS.map((definition) => definition.name);
}

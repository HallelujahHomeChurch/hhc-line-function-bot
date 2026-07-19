import type { CacheStore } from "../cache/cache-store.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type { SheetMusicExternalSearchSummarizer } from "../search/sheet-music-external-summarizer.js";
import type { SessionStore } from "../state/session-store.js";
import { FUNCTION_NAMES } from "../types.js";
import type {
  AppConfig,
  FunctionName,
  FunctionRegistry,
  GraphDriveClient,
  JsonRecord,
  LineContentClient,
  NotionDatabaseClient,
  PostbackHandlerRegistry,
  TextMessageHandlerRegistry,
  AdminHandlerRegistry,
  TextGenerationProvider,
  VirusScanner,
  WebSearchClient
} from "../types.js";
import { getFunctionDefinition, type FunctionDefinition } from "./definitions.js";
import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler,
  createFindPptSlidesTextMessageHandler
} from "./find-ppt-slides.js";
import {
  createFindPopSheetMusicHandler,
  createFindPopSheetMusicPostbackHandler,
  createFindPopSheetMusicTextMessageHandler
} from "./find-pop-sheet-music.js";
import { createQueryScheduleHandler } from "./query-schedule.js";
import { createWikipediaLookupHandler, type WikipediaSummarizer } from "../wikipedia/lookup.js";
import type { WikipediaClient } from "../wikipedia/client.js";
import { createRetrieveMemoryHandler, createSaveMemoryHandler } from "./agent-memory-functions.js";
import { createPendingAttachmentTextMessageHandler } from "./attachment-save.js";
import { createUploadIntentTextMessageHandler } from "./upload-intent.js";
import { createFindResourceHandler } from "./find-resource.js";
import type { CatalogStore } from "../catalog/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { ExternalBinaryClient } from "../clients/external-binary.js";
import type { EmbeddingClient } from "../clients/ollama-embedding.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { createResourceBinaryPublisher } from "./resource-binary-publisher.js";
import { createSaveResourceHandler } from "./save-resource.js";
import {
  createQueryKnowledgeHandler,
  createQueryKnowledgePostbackHandler,
  createQueryKnowledgeTextMessageHandler
} from "./query-knowledge.js";
import { createSaveScheduleHandler } from "./schedule-memory.js";

export interface FunctionModuleContext {
  config: AppConfig;
  clients: {
    graph?: GraphDriveClient;
    notion?: NotionDatabaseClient;
    sessionStore: SessionStore;
    cache: CacheStore;
    memoryStore?: AgentMemoryStore;
    catalog?: CatalogStore;
    scheduleStore?: ScheduleStore;
    lineContent?: LineContentClient;
    externalBinary?: ExternalBinaryClient;
    virusScanner?: VirusScanner;
    wikipedia?: WikipediaClient;
    wikipediaSummarizer?: WikipediaSummarizer;
    webSearch?: WebSearchClient;
    sheetMusicExternalSearchSummarizer?: SheetMusicExternalSearchSummarizer;
    knowledgeStore?: KnowledgeStore;
    embedding?: EmbeddingClient;
    knowledgeTextGenerator?: TextGenerationProvider;
    now?: () => Date;
    requestIdFactory?: () => string;
  };
}

export interface FunctionModuleRegistrations {
  functions?: FunctionRegistry;
  postbacks?: PostbackHandlerRegistry;
  textMessages?: TextMessageHandlerRegistry;
  adminHandlers?: AdminHandlerRegistry;
}

export interface RouterEvalCase {
  kind: "positive" | "missing_slot" | "typo" | "negative" | "disabled" | "cross_function";
  text: string;
  enabledFunctions?: FunctionName[];
  expected:
    | {
        type: "execute";
        action: FunctionName;
        arguments: JsonRecord;
      }
    | {
        type: "deny";
        reason: string;
      };
}

export interface FunctionModule {
  name: FunctionName;
  definition: FunctionDefinition;
  routerEvalCases: RouterEvalCase[];
  register(context: FunctionModuleContext): FunctionModuleRegistrations;
}

export const FUNCTION_MODULES: FunctionModule[] = [
  {
    name: "find_ppt_slides",
    definition: requiredDefinition("find_ppt_slides"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查投影片 主日報告 pdf",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "主日報告", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查投影片",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "", matchMode: "fuzzy" }
        }
      },
      {
        kind: "typo",
        text: "小哈 查奇易恩點的投影片",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "奇易恩點", matchMode: "fuzzy" }
        }
      },
      {
        kind: "negative",
        text: "小哈 查詩歌 奇異恩典",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈 查投影片 主日報告",
        enabledFunctions: withoutFunction("find_ppt_slides"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈 查流行歌曲樂譜 奇異恩典",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "奇異恩典", fileType: "pdf", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ config, clients }) => {
      if (!config.graph || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_ppt_slides: createFindPptSlidesHandler({
            graph: clients.graph,
            catalog: clients.catalog,
            driveId: config.graph.driveId,
            folderItemId: config.graph.pptFolderItemId,
            allowedExtensions: config.graph.allowedExtensions,
            defaultIncludePdf: config.graph.defaultIncludePdf,
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            observabilityHmacKey: config.observability?.hmacKey,
            requestIdFactory: clients.requestIdFactory
          })
        },
        postbacks: {
          select_ppt: createFindPptSlidesPostbackHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            now: clients.now
          })
        },
        textMessages: {
          ppt_numeric_selection: createFindPptSlidesTextMessageHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            now: clients.now
          })
        }
      };
    }
  },
  {
    name: "query_schedule",
    definition: requiredDefinition("query_schedule"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 下一場聚會服事表",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: { query: "下一場聚會服事表", dateIntent: "next_meeting" }
        }
      },
      {
        kind: "positive",
        text: "小哈 給我下一場影視團隊的服事表",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: {
            query: "給我下一場影視團隊的服事表",
            dateIntent: "next_meeting"
          }
        }
      },
      {
        kind: "positive",
        text: "小哈 下一場服事表的音控是誰",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: {
            query: "下一場服事表的音控是誰",
            dateIntent: "next_meeting"
          }
        }
      },
      {
        kind: "positive",
        text: "小哈 下一場青年出隊服事表",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: {
            query: "下一場青年出隊服事表",
            dateIntent: "next_meeting"
          }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查服事表",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: { query: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈 查7/19舉牌",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: { query: "7/19舉牌", scheduleType: "street_sign_service" }
        }
      },
      {
        kind: "negative",
        text: "小哈 幫我訂便當",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈 下一場聚會服事表",
        enabledFunctions: withoutFunction("query_schedule"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈 查投影片 主日報告",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "主日報告", matchMode: "fuzzy" }
        }
      },
      {
        kind: "cross_function",
        text: "小哈 查流行歌譜 奇異恩典",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "奇異恩典", fileType: "pdf", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ config, clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          query_schedule: createQueryScheduleHandler({
            memoryStore: clients.memoryStore,
            scheduleStore: clients.scheduleStore,
            notion: clients.notion,
            databaseId: config.notion?.databaseId,
            properties: config.notion?.properties,
            timeZone: config.timeZone,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          })
        }
      };
    }
  },
  {
    name: "query_knowledge",
    definition: requiredDefinition("query_knowledge"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查知識 這次出遊第一個地點是哪裡",
        expected: {
          type: "execute",
          action: "query_knowledge",
          arguments: { query: "這次出遊第一個地點是哪裡", ordinal: 0 }
        }
      },
      {
        kind: "positive",
        text: "小哈 查知識 聚會結束後場地怎麼復原",
        expected: {
          type: "execute",
          action: "query_knowledge",
          arguments: { query: "聚會結束後場地怎麼復原" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查知識",
        expected: { type: "execute", action: "query_knowledge", arguments: { query: "" } }
      },
      {
        kind: "typo",
        text: "小哈 知識查詢 聚會場復 SOP",
        expected: { type: "execute", action: "query_knowledge", arguments: { query: "聚會場復" } }
      },
      {
        kind: "negative",
        text: "小哈 幫我訂餐廳",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "cross_function",
        text: "小哈 下一場服事表",
        expected: {
          type: "execute",

          action: "query_schedule",
          arguments: { query: "下一場服事表", dateIntent: "next_meeting" }
        }
      },
      {
        kind: "disabled",
        text: "小哈 聚會 SOP 是什麼",
        enabledFunctions: withoutFunction("query_knowledge"),
        expected: { type: "deny", reason: "function_disabled" }
      }
    ],
    register: ({ clients }) =>
      clients.knowledgeStore
        ? {
            functions: {
              query_knowledge: createQueryKnowledgeHandler({
                store: clients.knowledgeStore,
                embedding: clients.embedding,
                textGenerator: clients.knowledgeTextGenerator,
                sessionStore: clients.sessionStore,
                now: clients.now,
                requestIdFactory: clients.requestIdFactory
              })
            },
            postbacks: {
              select_knowledge_source: createQueryKnowledgePostbackHandler({
                store: clients.knowledgeStore,
                embedding: clients.embedding,
                textGenerator: clients.knowledgeTextGenerator,
                sessionStore: clients.sessionStore,
                now: clients.now,
                requestIdFactory: clients.requestIdFactory
              })
            },
            textMessages: {
              knowledge_numeric_selection: createQueryKnowledgeTextMessageHandler({
                store: clients.knowledgeStore,
                embedding: clients.embedding,
                textGenerator: clients.knowledgeTextGenerator,
                sessionStore: clients.sessionStore,
                now: clients.now,
                requestIdFactory: clients.requestIdFactory
              })
            }
          }
        : {}
  },
  {
    name: "save_schedule",
    definition: requiredDefinition("save_schedule"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈幫我記住這份晨更服事表：七/10五黃弘家族2",
        expected: {
          type: "execute",
          action: "save_schedule",
          arguments: { content: "七/10五黃弘家族2" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈記住晨更服事表",
        expected: {
          type: "execute",
          action: "save_schedule",
          arguments: { content: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈保存舉牌服事表：7/19黃弘家族(音樂人)",
        expected: {
          type: "execute",
          action: "save_schedule",
          arguments: { content: "7/19黃弘家族(音樂人)" }
        }
      },
      {
        kind: "negative",
        text: "小哈今天晚餐吃什麼",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈幫我記住這份晨更服事表：七/10五黃弘家族2",
        enabledFunctions: withoutFunction("save_schedule"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈查7/19舉牌",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: { query: "7/19舉牌", scheduleType: "street_sign_service" }
        }
      }
    ],
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          save_schedule: createSaveScheduleHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          })
        }
      };
    }
  },
  {
    name: "find_sheet_music",
    definition: requiredDefinition("find_sheet_music"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查歌譜 A TIME FOR US",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "A TIME FOR US", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查歌譜",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "typo",
        text: "小哈 查歌譜 Yestarday",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "Yestarday", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "negative",
        text: "小哈 查天氣",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈 查歌譜 Yesterday",
        enabledFunctions: withoutFunction("find_sheet_music"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈 查維基百科 馬丁路德",
        expected: {
          type: "execute",
          action: "query_wikipedia",
          arguments: { query: "馬丁路德" }
        }
      }
    ],
    register: ({ config, clients }) => {
      if (!config.graph || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_sheet_music: createFindPopSheetMusicHandler({
            graph: clients.graph,
            catalog: clients.catalog,
            driveId: config.graph.driveId,
            allowedExtensions: config.graph.sheetMusicAllowedExtensions,
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            externalSearch:
              clients.webSearch && clients.sheetMusicExternalSearchSummarizer
                ? {
                    webSearch: clients.webSearch,
                    summarize: clients.sheetMusicExternalSearchSummarizer
                  }
                : undefined,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory,
            functionName: "find_sheet_music"
          })
        },
        postbacks: {
          select_sheet_music: createFindPopSheetMusicPostbackHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            now: clients.now
          })
        },
        textMessages: {
          sheet_music_numeric_selection: createFindPopSheetMusicTextMessageHandler({
            graph: clients.graph,
            sessionStore: clients.sessionStore,
            externalSearch:
              clients.webSearch && clients.sheetMusicExternalSearchSummarizer
                ? {
                    webSearch: clients.webSearch,
                    summarize: clients.sheetMusicExternalSearchSummarizer
                  }
                : undefined,
            externalImport:
              clients.externalBinary && clients.catalog && clients.virusScanner
                ? {
                    client: clients.externalBinary,
                    publisher: createResourceBinaryPublisher({
                      catalog: clients.catalog,
                      graph: clients.graph,
                      scanner: clients.virusScanner,
                      maxBytes: config.attachments?.maxBytes ?? 25 * 1024 * 1024
                    }),
                    maxBytes: config.attachments?.maxBytes ?? 25 * 1024 * 1024,
                    timeoutMs: config.externalResources?.downloadTimeoutMs ?? 15_000,
                    maxRedirects: config.externalResources?.maxRedirects ?? 3
                  }
                : undefined,
            now: clients.now
          })
        }
      };
    }
  },
  {
    name: "find_resource",
    definition: requiredDefinition("find_resource"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查教會資料 週報音檔",
        expected: {
          type: "execute",
          action: "find_resource",
          arguments: { query: "", itemKind: "weekly_report_audio", domain: "audio" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查教會資料",
        expected: {
          type: "execute",
          action: "find_resource",
          arguments: { query: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈 查教會資料 weekly report",
        expected: {
          type: "execute",
          action: "find_resource",
          arguments: { query: "weekly report" }
        }
      },
      {
        kind: "negative",
        text: "小哈 幫我查資料",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "cross_function",
        text: "小哈 查服事表",
        expected: { type: "execute", action: "query_schedule", arguments: { query: "" } }
      },
      {
        kind: "disabled",
        text: "小哈 查教會資料 週報音檔",
        enabledFunctions: withoutFunction("find_resource"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈 查歌譜 Amazing Grace",
        expected: {
          type: "execute",
          action: "find_sheet_music",
          arguments: { query: "Amazing Grace", fileType: "pdf", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ clients }) => {
      if (!clients.catalog || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_resource: createFindResourceHandler({
            catalog: clients.catalog,
            graph: clients.graph,
            allowedItemKinds: [
              "church_document",
              "church_image",
              "church_other",
              "weekly_report_audio"
            ],
            now: clients.now
          })
        }
      };
    }
  },
  {
    name: "query_wikipedia",
    definition: requiredDefinition("query_wikipedia"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查維基百科 馬丁路德",
        expected: { type: "execute", action: "query_wikipedia", arguments: { query: "馬丁路德" } }
      },
      {
        kind: "missing_slot",
        text: "小哈 查維基百科",
        expected: { type: "execute", action: "query_wikipedia", arguments: { query: "" } }
      },
      {
        kind: "typo",
        text: "小哈 維基百科 馬丁路得",
        expected: { type: "execute", action: "query_wikipedia", arguments: { query: "馬丁路得" } }
      },
      {
        kind: "negative",
        text: "小哈 幫我買咖啡",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈 查維基百科 馬丁路德",
        enabledFunctions: withoutFunction("query_wikipedia"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈 查投影片 奇異恩典",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "奇異恩典", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ clients }) => {
      if (!clients.wikipedia || !clients.wikipediaSummarizer) {
        return {};
      }
      return {
        functions: {
          query_wikipedia: createWikipediaLookupHandler({
            client: clients.wikipedia,
            summarize: clients.wikipediaSummarizer
          })
        }
      };
    }
  },
  {
    name: "save_memory",
    definition: requiredDefinition("save_memory"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈幫我記住這個月服事表：主日導播是小明",

        expected: {
          type: "execute",
          action: "save_memory",
          arguments: { content: "這個月服事表：主日導播是小明" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈幫我記住",
        expected: {
          type: "execute",
          action: "save_memory",
          arguments: { content: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈幫我儲存主日提醒",
        expected: {
          type: "execute",
          action: "save_memory",
          arguments: { content: "主日提醒" }
        }
      },
      {
        kind: "negative",
        text: "小哈請幫我訂便當",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈幫我記住這個月服事表",
        enabledFunctions: withoutFunction("save_memory"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈查投影片 奇異恩典",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "奇異恩典", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          save_memory: createSaveMemoryHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory,
            embedding: clients.embedding
          })
        }
      };
    }
  },
  {
    name: "save_resource",
    definition: requiredDefinition("save_resource"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈保存投影片 https://example.org/youth 名稱是青年聚會投影片",
        expected: {
          type: "execute",
          action: "save_resource",
          arguments: {
            url: "https://example.org/youth",
            resourceType: "ppt_slide",
            title: "青年聚會投影片"
          }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈保存投影片",
        expected: { type: "execute", action: "save_resource", arguments: { url: "" } }
      },
      {
        kind: "typo",
        text: "小哈儲存歌譜 https://example.org/score 名稱是恩典之路",
        expected: {
          type: "execute",
          action: "save_resource",
          arguments: {
            url: "https://example.org/score",
            resourceType: "sheet_music",
            title: "恩典之路"
          }
        }
      },
      {
        kind: "negative",
        text: "小哈幫我買咖啡",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈保存投影片 https://example.org/youth 名稱是青年聚會投影片",
        enabledFunctions: withoutFunction("save_resource"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈查投影片 奇異恩典",
        expected: {
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "奇異恩典", matchMode: "fuzzy" }
        }
      }
    ],
    register: ({ config, clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      const registrations: FunctionModuleRegistrations = {
        functions: {
          save_resource: createSaveResourceHandler({
            memoryStore: clients.memoryStore,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          })
        }
      };
      if (clients.catalog && clients.graph && clients.lineContent) {
        registrations.textMessages = {
          upload_intent_activation: createUploadIntentTextMessageHandler({
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
          }),
          pending_attachment_answer: createPendingAttachmentTextMessageHandler({
            sessionStore: clients.sessionStore,
            catalog: clients.catalog,
            lineContent: clients.lineContent,
            graph: clients.graph,
            scanner: clients.virusScanner,
            maxBytes: config.attachments?.maxBytes ?? 25 * 1024 * 1024,
            lineDownloadTimeoutMs: config.attachments?.lineDownloadTimeoutMs ?? 30_000,
            now: clients.now
          })
        };
      }
      return registrations;
    }
  },
  {
    name: "retrieve_memory",
    definition: requiredDefinition("retrieve_memory"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈查我記住的服事表",
        expected: {
          type: "execute",
          action: "retrieve_memory",
          arguments: { query: "服事表" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈查我記住的",
        expected: {
          type: "execute",
          action: "retrieve_memory",
          arguments: { query: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈找我保存的服事",
        expected: {
          type: "execute",
          action: "retrieve_memory",
          arguments: { query: "服事" }
        }
      },
      {
        kind: "negative",
        text: "小哈查今天股價",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈查我記住的服事表",
        enabledFunctions: withoutFunction("retrieve_memory"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈查服事表",
        expected: {
          type: "execute",
          action: "query_schedule",
          arguments: { query: "" }
        }
      }
    ],
    register: ({ clients }) => {
      if (!clients.memoryStore) {
        return {};
      }
      return {
        functions: {
          retrieve_memory: createRetrieveMemoryHandler({
            memoryStore: clients.memoryStore,
            now: clients.now,
            embedding: clients.embedding,
            textGenerator: clients.knowledgeTextGenerator
          })
        }
      };
    }
  }
];

export function getRouterEvalCases(): RouterEvalCase[] {
  return FUNCTION_MODULES.flatMap((module) => module.routerEvalCases);
}

function withoutFunction(name: FunctionName): FunctionName[] {
  return FUNCTION_NAMES.filter((functionName) => functionName !== name);
}

function requiredDefinition(name: FunctionName): FunctionDefinition {
  const definition = getFunctionDefinition(name);
  if (!definition) {
    throw new Error(`Missing function definition: ${name}`);
  }
  if (definition.sideEffectLevel === "read" && !definition.agentCapability) {
    throw new Error(`Missing agent capability contract: ${name}`);
  }
  return definition;
}

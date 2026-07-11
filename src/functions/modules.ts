import type { CacheStore } from "../cache/cache-store.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
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
  VirusScanner
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
  createFindPopSheetMusicTextMessageHandler,
  SHEET_MUSIC_INDEX_CACHE_PREFIX
} from "./find-pop-sheet-music.js";
import { createQueryServiceScheduleHandler } from "./query-service-schedule.js";
import { createQueryScheduleHandler } from "./query-schedule.js";
import { createWikipediaLookupHandler, type WikipediaSummarizer } from "../wikipedia/lookup.js";
import type { WikipediaClient } from "../wikipedia/client.js";
import { createRetrieveMemoryHandler, createSaveMemoryHandler } from "./agent-memory-functions.js";
import { createPendingAttachmentTextMessageHandler } from "./attachment-save.js";
import { createFindResourceHandler } from "./find-resource.js";
import type { CatalogStore } from "../catalog/store.js";
import type { ScheduleStore } from "../schedules/store.js";
import { createSaveResourceHandler } from "./save-resource.js";
import {
  createQueryScheduleMemoryHandler,
  createSaveScheduleHandler,
  createSaveScheduleMemoryHandler
} from "./schedule-memory.js";

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
    virusScanner?: VirusScanner;
    wikipedia?: WikipediaClient;
    wikipediaSummarizer?: WikipediaSummarizer;
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
    name: "query_service_schedule",
    definition: requiredDefinition("query_service_schedule"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 下一場聚會服事表",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "下一場聚會服事表", dateIntent: "next_meeting" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查服事表",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈 明天聚會服事仁員",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "明天聚會服事仁員" }
        }
      },
      {
        kind: "positive",
        text: "小哈 明天聚會服事人員",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "明天聚會服事人員" }
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
        enabledFunctions: withoutFunction("query_service_schedule"),
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
      }
    ],
    register: ({ config, clients }) => {
      if (!config.notion || !clients.notion) {
        return {};
      }
      return {
        functions: {
          query_service_schedule: createQueryServiceScheduleHandler({
            notion: clients.notion,
            databaseId: config.notion.databaseId,
            properties: config.notion.properties,
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
            folderItemId: config.graph.sheetMusicFolderItemId,
            folderPath: config.graph.sheetMusicFolderPath,
            allowedExtensions: config.graph.sheetMusicAllowedExtensions,
            recursive: config.graph.sheetMusicRecursive,
            memoryStore: clients.memoryStore,
            cache: clients.cache,
            sessionStore: clients.sessionStore,
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
            now: clients.now
          })
        },
        adminHandlers: {
          "refresh-sheet-music-cache": async () => {
            const removed = await clients.cache.deleteByPrefix(SHEET_MUSIC_INDEX_CACHE_PREFIX);
            return {
              ok: true,
              replyText: `已清除歌譜 cache（${removed} 筆），下次查詢會重新建立。`
            };
          }
        }
      };
    }
  },
  {
    name: "find_pop_sheet_music",
    definition: requiredDefinition("find_pop_sheet_music"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 查流行歌譜 A TIME FOR US",
        expected: {
          type: "execute",
          action: "find_pop_sheet_music",
          arguments: { query: "A TIME FOR US", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "positive",
        text: "小哈 查歌譜 Yesterday jpg",
        expected: {
          type: "execute",
          action: "find_pop_sheet_music",
          arguments: { query: "Yesterday", fileType: "image", matchMode: "fuzzy" }
        }
      },
      {
        kind: "positive",
        text: "小哈，幫我找 Yesterday 的流行歌曲樂譜",
        expected: {
          type: "execute",
          action: "find_pop_sheet_music",
          arguments: { query: "Yesterday", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查流行歌曲樂譜",
        expected: {
          type: "execute",
          action: "find_pop_sheet_music",
          arguments: { query: "", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "typo",
        text: "小哈 查流行歌譜 Yestarday",
        expected: {
          type: "execute",
          action: "find_pop_sheet_music",
          arguments: { query: "Yestarday", fileType: "pdf", matchMode: "fuzzy" }
        }
      },
      {
        kind: "negative",
        text: "小哈 查流行歌 Yesterday",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈 查流行歌譜 Yesterday",
        enabledFunctions: withoutFunction("find_pop_sheet_music"),
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
    register: ({ config, clients }) => {
      if (!config.graph || !clients.graph) {
        return {};
      }
      return {
        functions: {
          find_pop_sheet_music: createFindPopSheetMusicHandler({
            graph: clients.graph,
            catalog: clients.catalog,
            driveId: config.graph.driveId,
            folderItemId: config.graph.sheetMusicFolderItemId,
            folderPath: config.graph.sheetMusicFolderPath,
            allowedExtensions: config.graph.sheetMusicAllowedExtensions,
            recursive: config.graph.sheetMusicRecursive,
            memoryStore: clients.memoryStore,
            cache: clients.cache,
            sessionStore: clients.sessionStore,
            now: clients.now,
            requestIdFactory: clients.requestIdFactory
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
            now: clients.now
          })
        },
        adminHandlers: {
          "refresh-sheet-music-cache": async () => {
            const removed = await clients.cache.deleteByPrefix(SHEET_MUSIC_INDEX_CACHE_PREFIX);
            return {
              ok: true,
              replyText: `已清除流行歌譜 cache（${removed} 筆），下次查詢會重新建立。`
            };
          }
        }
      };
    }
  },
  {
    name: "save_schedule_memory",
    definition: requiredDefinition("save_schedule_memory"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈幫我記住這份晨更服事表：七/10五黃弘家族2",
        expected: {
          type: "execute",
          action: "save_schedule_memory",
          arguments: { content: "七/10五黃弘家族2" }
        }
      },
      {
        kind: "positive",
        text: "小哈保存舉牌服事表：7/19黃弘家族(音樂人)",
        expected: {
          type: "execute",
          action: "save_schedule_memory",
          arguments: { content: "7/19黃弘家族(音樂人)" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈記住晨更服事表",
        expected: {
          type: "execute",
          action: "save_schedule_memory",
          arguments: { content: "" }
        }
      },
      {
        kind: "typo",
        text: "小哈保存仙履奇緣服事表：七/16四仙履奇緣",
        expected: {
          type: "execute",
          action: "save_schedule_memory",
          arguments: { content: "七/16四仙履奇緣" }
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
        enabledFunctions: withoutFunction("save_schedule_memory"),
        expected: { type: "deny", reason: "function_disabled" }
      },
      {
        kind: "cross_function",
        text: "小哈查7/19舉牌",
        expected: {
          type: "execute",
          action: "query_schedule_memory",
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
          save_schedule_memory: createSaveScheduleMemoryHandler({
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
    name: "query_schedule_memory",
    definition: requiredDefinition("query_schedule_memory"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈查7/19舉牌",
        expected: {
          type: "execute",
          action: "query_schedule_memory",
          arguments: { query: "7/19舉牌", scheduleType: "street_sign_service" }
        }
      },
      {
        kind: "positive",
        text: "小哈查7/17晨更家族服事",
        expected: {
          type: "execute",
          action: "query_schedule_memory",
          arguments: { query: "7/17晨更家族服事", scheduleType: "morning_prayer_family" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈查舉牌",
        expected: {
          type: "execute",
          action: "query_schedule_memory",
          arguments: { query: "舉牌", scheduleType: "street_sign_service" }
        }
      },
      {
        kind: "typo",
        text: "小哈找7/19舉牌",
        expected: {
          type: "execute",
          action: "query_schedule_memory",
          arguments: { query: "7/19舉牌", scheduleType: "street_sign_service" }
        }
      },
      {
        kind: "negative",
        text: "小哈查昨天吃什麼",
        expected: { type: "deny", reason: "keyword_no_match" }
      },
      {
        kind: "disabled",
        text: "小哈查7/19舉牌",
        enabledFunctions: withoutFunction("query_schedule_memory"),
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
          query_schedule_memory: createQueryScheduleMemoryHandler({
            memoryStore: clients.memoryStore,
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
            requestIdFactory: clients.requestIdFactory
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
          pending_attachment_answer: createPendingAttachmentTextMessageHandler({
            sessionStore: clients.sessionStore,
            catalog: clients.catalog,
            lineContent: clients.lineContent,
            graph: clients.graph,
            scanner: clients.virusScanner,
            sources: config.catalog?.sources ?? [],
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
            now: clients.now
          })
        }
      };
    }
  }
];

export function getRouterEvalCases(): RouterEvalCase[] {
  return FUNCTION_MODULES.filter((module) => !module.definition.deprecated).flatMap(
    (module) => module.routerEvalCases
  );
}

function withoutFunction(name: FunctionName): FunctionName[] {
  const legacyAlias =
    name === "query_schedule"
      ? "query_service_schedule"
      : name === "save_schedule"
        ? "save_schedule_memory"
        : name === "find_sheet_music"
          ? "find_pop_sheet_music"
          : undefined;
  return FUNCTION_NAMES.filter(
    (functionName) => functionName !== name && functionName !== legacyAlias
  );
}

function requiredDefinition(name: FunctionName): FunctionDefinition {
  const definition = getFunctionDefinition(name);
  if (!definition) {
    throw new Error(`Missing function definition: ${name}`);
  }
  return definition;
}

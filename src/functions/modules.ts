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
  NotionDatabaseClient,
  PostbackHandlerRegistry,
  TextMessageHandlerRegistry,
  AdminHandlerRegistry
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
import { createRetrieveMemoryHandler, createSaveMemoryHandler } from "./agent-memory-functions.js";

export interface FunctionModuleContext {
  config: AppConfig;
  clients: {
    graph?: GraphDriveClient;
    notion?: NotionDatabaseClient;
    sessionStore: SessionStore;
    cache: CacheStore;
    memoryStore?: AgentMemoryStore;
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
          action: "find_pop_sheet_music",
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
    name: "query_service_schedule",
    definition: requiredDefinition("query_service_schedule"),
    routerEvalCases: [
      {
        kind: "positive",
        text: "小哈 下一場聚會服事表",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "下一場聚會服事表" }
        }
      },
      {
        kind: "missing_slot",
        text: "小哈 查服事表",
        expected: {
          type: "execute",
          action: "query_service_schedule",
          arguments: { query: "服事表" }
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
            now: clients.now
          })
        }
      };
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
          action: "query_service_schedule",
          arguments: { query: "服事表" }
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
  return definition;
}

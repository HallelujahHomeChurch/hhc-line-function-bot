import type { CacheStore } from "../cache/cache-store.js";
import type { SessionStore } from "../state/session-store.js";
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

export interface FunctionModuleContext {
  config: AppConfig;
  clients: {
    graph?: GraphDriveClient;
    notion?: NotionDatabaseClient;
    sessionStore: SessionStore;
    cache: CacheStore;
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
  text: string;
  action: FunctionName;
  arguments: JsonRecord;
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
        text: "小哈 查投影片 主日報告 pdf",
        action: "find_ppt_slides",
        arguments: { query: "主日報告", fileType: "pdf", matchMode: "fuzzy" }
      },
      {
        text: "小哈 查投影片",
        action: "find_ppt_slides",
        arguments: { query: "", matchMode: "fuzzy" }
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
        text: "小哈 下一場聚會服事表",
        action: "query_service_schedule",
        arguments: { query: "下一場聚會服事表" }
      },
      {
        text: "小哈 查服事表",
        action: "query_service_schedule",
        arguments: { query: "服事表" }
      },
      {
        text: "小哈 明天聚會服事人員",
        action: "query_service_schedule",
        arguments: { query: "明天聚會服事人員" }
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
        text: "小哈 查流行歌譜 A TIME FOR US",
        action: "find_pop_sheet_music",
        arguments: { query: "A TIME FOR US", fileType: "pdf", matchMode: "fuzzy" }
      },
      {
        text: "小哈 查歌譜 Yesterday jpg",
        action: "find_pop_sheet_music",
        arguments: { query: "Yesterday", fileType: "image", matchMode: "fuzzy" }
      },
      {
        text: "小哈，幫我找 Yesterday 的流行歌曲樂譜",
        action: "find_pop_sheet_music",
        arguments: { query: "Yesterday", fileType: "pdf", matchMode: "fuzzy" }
      },
      {
        text: "小哈 查流行歌曲樂譜",
        action: "find_pop_sheet_music",
        arguments: { query: "", fileType: "pdf", matchMode: "fuzzy" }
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
  }
];

export function getRouterEvalCases(): RouterEvalCase[] {
  return FUNCTION_MODULES.flatMap((module) => module.routerEvalCases);
}

function requiredDefinition(name: FunctionName): FunctionDefinition {
  const definition = getFunctionDefinition(name);
  if (!definition) {
    throw new Error(`Missing function definition: ${name}`);
  }
  return definition;
}

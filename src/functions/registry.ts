import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { MemoryCacheStore, type CacheStore } from "../cache/cache-store.js";
import { InMemorySessionStore, type SessionStore } from "../state/session-store.js";
import type {
  AppConfig,
  AdminHandlerRegistry,
  FunctionRegistry,
  GraphDriveClient,
  NotionDatabaseClient,
  PostbackHandlerRegistry,
  TextMessageHandlerRegistry
} from "../types.js";
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

export interface RegistryClients {
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  sessionStore?: SessionStore;
  cache?: CacheStore;
}

export interface FunctionRegistries {
  functions: FunctionRegistry;
  postbacks: PostbackHandlerRegistry;
  textMessages: TextMessageHandlerRegistry;
  adminHandlers: AdminHandlerRegistry;
}

export function createFunctionRegistries(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistries {
  const functions: FunctionRegistry = {};
  const postbacks: PostbackHandlerRegistry = {};
  const textMessages: TextMessageHandlerRegistry = {};
  const adminHandlers: AdminHandlerRegistry = {};

  if (config.graph) {
    const graph = clients.graph ?? createGraphDriveClient(config.graph);
    const sessionStore = clients.sessionStore ?? new InMemorySessionStore();
    const cache = clients.cache ?? new MemoryCacheStore();
    functions.find_ppt_slides = createFindPptSlidesHandler({
      graph,
      driveId: config.graph.driveId,
      folderItemId: config.graph.pptFolderItemId,
      allowedExtensions: config.graph.allowedExtensions,
      defaultIncludePdf: config.graph.defaultIncludePdf,
      sessionStore
    });
    postbacks.select_ppt = createFindPptSlidesPostbackHandler({
      graph,
      sessionStore
    });
    textMessages.ppt_numeric_selection = createFindPptSlidesTextMessageHandler({
      graph,
      sessionStore
    });
    functions.find_pop_sheet_music = createFindPopSheetMusicHandler({
      graph,
      driveId: config.graph.driveId,
      folderItemId: config.graph.sheetMusicFolderItemId,
      folderPath: config.graph.sheetMusicFolderPath,
      allowedExtensions: config.graph.sheetMusicAllowedExtensions,
      recursive: config.graph.sheetMusicRecursive,
      cache,
      sessionStore
    });
    postbacks.select_sheet_music = createFindPopSheetMusicPostbackHandler({
      graph,
      sessionStore
    });
    textMessages.sheet_music_numeric_selection = createFindPopSheetMusicTextMessageHandler({
      graph,
      sessionStore
    });
    adminHandlers["refresh-sheet-music-cache"] = async () => {
      const removed = await cache.deleteByPrefix(SHEET_MUSIC_INDEX_CACHE_PREFIX);
      return {
        ok: true,
        replyText: `已清除流行歌譜 cache（${removed} 筆），下次查詢會重新建立。`
      };
    };
  }

  if (config.notion) {
    const notion = clients.notion ?? createNotionDatabaseClient(config.notion);
    functions.query_service_schedule = createQueryServiceScheduleHandler({
      notion,
      databaseId: config.notion.databaseId,
      properties: config.notion.properties,
      timeZone: config.timeZone
    });
  }

  return { functions, postbacks, textMessages, adminHandlers };
}

export function createFunctionRegistry(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistry {
  return createFunctionRegistries(config, clients).functions;
}

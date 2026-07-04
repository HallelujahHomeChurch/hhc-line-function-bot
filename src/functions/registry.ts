import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { InMemorySessionStore, type SessionStore } from "../state/session-store.js";
import type {
  AppConfig,
  FunctionRegistry,
  GraphDriveClient,
  NotionDatabaseClient,
  PostbackHandlerRegistry
} from "../types.js";
import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler
} from "./find-ppt-slides.js";
import { createQueryServiceScheduleHandler } from "./query-service-schedule.js";

export interface RegistryClients {
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  sessionStore?: SessionStore;
}

export interface FunctionRegistries {
  functions: FunctionRegistry;
  postbacks: PostbackHandlerRegistry;
}

export function createFunctionRegistries(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistries {
  const functions: FunctionRegistry = {};
  const postbacks: PostbackHandlerRegistry = {};

  if (config.graph) {
    const graph = clients.graph ?? createGraphDriveClient(config.graph);
    const sessionStore = clients.sessionStore ?? new InMemorySessionStore();
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

  return { functions, postbacks };
}

export function createFunctionRegistry(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistry {
  return createFunctionRegistries(config, clients).functions;
}

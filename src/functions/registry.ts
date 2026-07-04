import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import type {
  AppConfig,
  FunctionRegistry,
  GraphDriveClient,
  NotionDatabaseClient
} from "../types.js";
import { createFindPptSlidesHandler } from "./find-ppt-slides.js";
import { createQueryServiceScheduleHandler } from "./query-service-schedule.js";

export interface RegistryClients {
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
}

export function createFunctionRegistry(
  config: AppConfig,
  clients: RegistryClients = {}
): FunctionRegistry {
  const registry: FunctionRegistry = {};

  if (config.graph) {
    const graph = clients.graph ?? createGraphDriveClient(config.graph);
    registry.find_ppt_slides = createFindPptSlidesHandler({
      graph,
      driveId: config.graph.driveId,
      folderItemId: config.graph.pptFolderItemId,
      allowedExtensions: config.graph.allowedExtensions,
      defaultIncludePdf: config.graph.defaultIncludePdf
    });
  }

  if (config.notion) {
    const notion = clients.notion ?? createNotionDatabaseClient(config.notion);
    registry.query_service_schedule = createQueryServiceScheduleHandler({
      notion,
      databaseId: config.notion.databaseId,
      properties: config.notion.properties
    });
  }

  return registry;
}

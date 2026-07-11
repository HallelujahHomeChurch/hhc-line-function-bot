import type { GraphDriveClient, NotionConfig, NotionDatabaseClient } from "../types.js";
import { syncNotionScheduleSource } from "../schedules/notion-sync.js";
import type { ScheduleStore } from "../schedules/store.js";
import { syncOneDriveCatalogSource } from "./onedrive-sync.js";
import type { CatalogSourceInput, CatalogStore } from "./store.js";

export interface SyncCatalogSourcesOptions {
  catalog: CatalogStore;
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  notionProperties?: NotionConfig["properties"];
  schedules?: ScheduleStore;
  sources: CatalogSourceInput[];
  now?: () => Date;
}

export interface SyncCatalogSourcesResult {
  sources: number;
  synced: number;
  skipped: number;
  upserted: number;
  itemSkipped: number;
  tombstoned: number;
  scheduleUpserted: number;
  scheduleSkipped: number;
  scheduleTombstoned: number;
}

export async function syncCatalogSources(
  options: SyncCatalogSourcesOptions
): Promise<SyncCatalogSourcesResult> {
  const result: SyncCatalogSourcesResult = {
    sources: options.sources.length,
    synced: 0,
    skipped: 0,
    upserted: 0,
    itemSkipped: 0,
    tombstoned: 0,
    scheduleUpserted: 0,
    scheduleSkipped: 0,
    scheduleTombstoned: 0
  };

  for (const input of options.sources) {
    const source = await options.catalog.upsertSource(input);
    if (!source.enabled) {
      result.skipped += 1;
      continue;
    }
    if (source.adapterType === "notion" && source.domain === "schedule") {
      if (!options.notion || !options.schedules || !options.notionProperties) {
        throw new Error(`catalog_sync_notion_schedule_required:${source.sourceKey}`);
      }
      const databaseId = source.rootLocation.databaseId;
      if (!databaseId) {
        throw new Error(`catalog_sync_notion_database_required:${source.sourceKey}`);
      }
      const sync = await syncNotionScheduleSource({
        schedules: options.schedules,
        notion: options.notion,
        source,
        databaseId,
        properties: options.notionProperties,
        now: options.now
      });
      result.synced += 1;
      result.scheduleUpserted += sync.upserted;
      result.scheduleSkipped += sync.skipped;
      result.scheduleTombstoned += sync.tombstoned;
      continue;
    }
    if (source.adapterType !== "onedrive") {
      result.skipped += 1;
      continue;
    }
    if (!options.graph) {
      throw new Error(`catalog_sync_graph_required:${source.sourceKey}`);
    }
    const sync = await syncOneDriveCatalogSource({
      catalog: options.catalog,
      graph: options.graph,
      source
    });
    result.synced += 1;
    result.upserted += sync.upserted;
    result.itemSkipped += sync.skipped;
    result.tombstoned += sync.tombstoned;
  }

  return result;
}

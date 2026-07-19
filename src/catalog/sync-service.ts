import type { GraphDriveClient, NotionConfig, NotionDatabaseClient } from "../types.js";
import { syncNotionScheduleSource } from "../schedules/notion-sync.js";
import type { ScheduleStore } from "../schedules/store.js";
import { syncOneDriveCatalogSource } from "./onedrive-sync.js";
import type { CatalogStore } from "./store.js";

export interface SyncCatalogSourcesOptions {
  catalog: CatalogStore;
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  notionProperties?: NotionConfig["properties"];
  schedules?: ScheduleStore;
  profileName?: string;
  sourceKeys?: string[];
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
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
  const sources = await options.catalog.listSources({
    profileName: options.profileName,
    sourceKeys: options.sourceKeys
  });
  options.logger?.({
    event: "catalog_sync_start",
    sources: sources.length,
    profileName: options.profileName,
    sourceKeys: options.sourceKeys
  });
  const result: SyncCatalogSourcesResult = {
    sources: sources.length,
    synced: 0,
    skipped: 0,
    upserted: 0,
    itemSkipped: 0,
    tombstoned: 0,
    scheduleUpserted: 0,
    scheduleSkipped: 0,
    scheduleTombstoned: 0
  };

  for (const source of sources) {
    const startedAt = Date.now();
    const baseLog = {
      sourceKey: source.sourceKey,
      adapterType: source.adapterType,
      domain: source.domain,
      itemKind: source.defaultItemKind
    };
    options.logger?.({ event: "catalog_source_sync_start", ...baseLog });
    if (!source.enabled) {
      result.skipped += 1;
      options.logger?.({
        event: "catalog_source_sync_skipped",
        reason: "disabled",
        elapsedMs: Date.now() - startedAt,
        ...baseLog
      });
      continue;
    }
    try {
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
        const publishedAt = (options.now ?? (() => new Date()))().toISOString();
        const promoted = await options.catalog.publishSourceSnapshot({
          sourceId: source.id,
          expectedRevision: source.revision,
          items: [],
          publishedAt
        });
        if (!promoted) {
          throw new Error(`catalog_publication_revision_conflict:${source.sourceKey}`);
        }
        result.synced += 1;
        result.scheduleUpserted += sync.upserted;
        result.scheduleSkipped += sync.skipped;
        result.scheduleTombstoned += sync.tombstoned;
        options.logger?.({
          event: "catalog_source_sync_done",
          elapsedMs: Date.now() - startedAt,
          scheduleUpserted: sync.upserted,
          scheduleSkipped: sync.skipped,
          scheduleTombstoned: sync.tombstoned,
          scheduleMalformed: sync.malformed,
          ...baseLog
        });
        continue;
      }
      if (source.adapterType !== "onedrive") {
        result.skipped += 1;
        options.logger?.({
          event: "catalog_source_sync_skipped",
          reason: "unsupported_adapter",
          elapsedMs: Date.now() - startedAt,
          ...baseLog
        });
        continue;
      }
      if (!options.graph) {
        throw new Error(`catalog_sync_graph_required:${source.sourceKey}`);
      }
      const sync = await syncOneDriveCatalogSource({
        catalog: options.catalog,
        graph: options.graph,
        source,
        now: options.now
      });
      result.synced += 1;
      result.upserted += sync.upserted;
      result.itemSkipped += sync.skipped;
      result.tombstoned += sync.tombstoned;
      options.logger?.({
        event: "catalog_source_sync_done",
        elapsedMs: Date.now() - startedAt,
        upserted: sync.upserted,
        itemSkipped: sync.skipped,
        tombstoned: sync.tombstoned,
        ...baseLog
      });
    } catch (error) {
      await options.catalog.markSourceSyncFailure({
        sourceId: source.id,
        expectedRevision: source.revision,
        failedAt: (options.now ?? (() => new Date()))().toISOString(),
        errorCode: catalogSyncErrorCode(error)
      });
      options.logger?.({
        event: "catalog_source_sync_failed",
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...baseLog
      });
      throw error;
    }
  }

  options.logger?.({ event: "catalog_sync_done", ...result });
  return result;
}

function catalogSyncErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split(":", 1)[0]
      ?.replace(/[^a-z0-9_]/giu, "_")
      .slice(0, 80) || "sync_failed"
  );
}

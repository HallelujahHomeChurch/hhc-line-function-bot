import type { AccessStore } from "../access/types.js";
import type { ScheduleStore } from "../schedules/store.js";
import type {
  AdminHandler,
  AdminHandlerRegistry,
  AppConfig,
  GraphDriveClient,
  NotionDatabaseClient
} from "../types.js";
import { syncCatalogSources, type SyncCatalogSourcesResult } from "./sync-service.js";
import type { CatalogSourceRecord, CatalogStore } from "./store.js";

export interface CreateCatalogAdminHandlersOptions {
  config: AppConfig;
  catalog: CatalogStore;
  accessStore?: AccessStore;
  graph?: GraphDriveClient;
  notion?: NotionDatabaseClient;
  schedules?: ScheduleStore;
}

export function createCatalogAdminHandlers(
  options: CreateCatalogAdminHandlersOptions
): AdminHandlerRegistry {
  return {
    "catalog-sources": createListHandler(options.catalog),
    "catalog-source-status": createStatusHandler(options.catalog),
    "catalog-source-enable": createEnableHandler(options, true),
    "catalog-source-disable": createEnableHandler(options, false),
    "catalog-sync-now": createSyncHandler(options)
  };
}

function createListHandler(catalog: CatalogStore): AdminHandler {
  return async ({ profile }) => {
    const sources = await catalog.listSources({ profileName: profile.name });
    return {
      ok: true,
      replyText: formatCatalogSources("Catalog sources", sources)
    };
  };
}

function createStatusHandler(catalog: CatalogStore): AdminHandler {
  return async ({ profile, args }) => {
    const sourceKey = args[0];
    if (!sourceKey) {
      return { ok: true, replyText: "Usage: /catalog-source-status <sourceKey>" };
    }
    const source = (
      await catalog.listSources({ profileName: profile.name, sourceKeys: [sourceKey] })
    )[0];
    if (!source) {
      return { ok: true, replyText: `Catalog source not found: ${sourceKey}` };
    }
    return {
      ok: true,
      replyText: formatCatalogSources("Catalog source", [source])
    };
  };
}

function createEnableHandler(
  options: CreateCatalogAdminHandlersOptions,
  enabled: boolean
): AdminHandler {
  return async ({ profile, event, args }) => {
    const sourceKey = args[0];
    const actorUserId = event.source.userId;
    if (!sourceKey) {
      return {
        ok: true,
        replyText: `Usage: /catalog-source-${enabled ? "enable" : "disable"} <sourceKey>`
      };
    }
    const source = await options.catalog.updateSourceEnabled({
      profileName: profile.name,
      sourceKey,
      enabled
    });
    if (!source) {
      return { ok: true, replyText: `Catalog source not found: ${sourceKey}` };
    }
    if (actorUserId && options.accessStore) {
      await options.accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: enabled ? "catalog.source.enable" : "catalog.source.disable",
        targetType: "catalog_source",
        targetId: sourceKey,
        metadata: { enabled }
      });
    }
    return {
      ok: true,
      replyText: `${enabled ? "enabled" : "disabled"} ${source.sourceKey}`
    };
  };
}

function createSyncHandler(options: CreateCatalogAdminHandlersOptions): AdminHandler {
  return async ({ profile, event, args }) => {
    const sourceKey = args[0];
    const sources = sourceKey
      ? await options.catalog.listSources({ profileName: profile.name, sourceKeys: [sourceKey] })
      : await options.catalog.listSources({ profileName: profile.name });
    if (sourceKey && sources.length === 0) {
      return { ok: true, replyText: `Catalog source not found: ${sourceKey}` };
    }
    const result = await syncCatalogSources({
      catalog: options.catalog,
      graph: options.graph,
      notion: options.notion,
      notionProperties: options.config.notion?.properties,
      schedules: options.schedules,
      profileName: profile.name,
      sourceKeys: sourceKey ? [sourceKey] : sources.map((source) => source.sourceKey)
    });
    const actorUserId = event.source.userId;
    if (actorUserId && options.accessStore) {
      await options.accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "catalog.source.sync",
        targetType: "catalog_source",
        targetId: sourceKey ?? "*",
        metadata: summarizeSyncResult(result)
      });
    }
    return {
      ok: true,
      replyText: [
        "Catalog sync",
        `sources: ${result.sources}`,
        `synced: ${result.synced}`,
        `skipped: ${result.skipped}`,
        `upserted: ${result.upserted}`,
        `tombstoned: ${result.tombstoned}`,
        `scheduleUpserted: ${result.scheduleUpserted}`,
        `scheduleTombstoned: ${result.scheduleTombstoned}`
      ].join("\n")
    };
  };
}

function formatCatalogSources(title: string, sources: CatalogSourceRecord[]): string {
  if (sources.length === 0) {
    return `${title}\n(none)`;
  }
  return [
    title,
    ...sources.map((source) =>
      [
        `- ${source.sourceKey}`,
        `enabled=${source.enabled}`,
        `adapter=${source.adapterType}`,
        `domain=${source.domain}`,
        `itemKind=${source.defaultItemKind}`,
        `health=${source.healthStatus}`,
        `revision=${source.revision}`,
        `items=${source.publishedItemCount}`,
        `lastSuccess=${source.lastSuccessAt ?? "(never)"}`,
        `lastFailure=${source.lastFailureAt ?? "(none)"}`,
        `mode=${source.syncPolicy.mode}`,
        `read=${source.capabilities.read.join(",") || "(none)"}`,
        `write=${source.capabilities.write.join(",") || "(none)"}`
      ].join(" ")
    )
  ].join("\n");
}

function summarizeSyncResult(result: SyncCatalogSourcesResult): Record<string, unknown> {
  return {
    sources: result.sources,
    synced: result.synced,
    skipped: result.skipped,
    upserted: result.upserted,
    tombstoned: result.tombstoned,
    scheduleUpserted: result.scheduleUpserted,
    scheduleTombstoned: result.scheduleTombstoned
  };
}

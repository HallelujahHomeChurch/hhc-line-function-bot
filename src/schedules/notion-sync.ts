import { configuredPropertyToText } from "../functions/query-service-schedule.js";
import type { CatalogSourceRecord } from "../catalog/store.js";
import type { NotionConfig, NotionDatabaseClient } from "../types.js";
import type { ScheduleStore } from "./store.js";

export interface SyncNotionScheduleSourceOptions {
  schedules: ScheduleStore;
  notion: NotionDatabaseClient;
  source: CatalogSourceRecord;
  databaseId: string;
  properties: NotionConfig["properties"];
  now?: () => Date;
}

export interface SyncNotionScheduleSourceResult {
  upserted: number;
  skipped: number;
  tombstoned: number;
}

export async function syncNotionScheduleSource(
  options: SyncNotionScheduleSourceOptions
): Promise<SyncNotionScheduleSourceResult> {
  const pages = await options.notion.queryDatabase(options.databaseId);
  const liveExternalIds: string[] = [];
  let upserted = 0;
  let skipped = 0;

  for (const page of pages) {
    const serviceDate = extractDateKey(
      configuredPropertyToText(page.properties, options.properties.date)
    );
    if (!serviceDate) {
      skipped += 1;
      continue;
    }
    liveExternalIds.push(page.id);
    await options.schedules.upsertItem({
      profileName: options.source.profileName,
      sourceKey: options.source.sourceKey,
      origin: "notion",
      externalId: page.id,
      serviceDate,
      meeting: configuredPropertyToText(page.properties, options.properties.meeting),
      role: configuredPropertyToText(page.properties, options.properties.role),
      assignee: configuredPropertyToText(page.properties, options.properties.person)
    });
    upserted += 1;
  }

  const tombstoned = await options.schedules.tombstoneMissingExternalIds({
    profileName: options.source.profileName,
    sourceKey: options.source.sourceKey,
    origin: "notion",
    liveExternalIds,
    deletedAt: (options.now ?? (() => new Date()))().toISOString()
  });

  return { upserted, skipped, tombstoned };
}

function extractDateKey(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

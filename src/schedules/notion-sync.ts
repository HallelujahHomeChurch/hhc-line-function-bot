import { configuredPropertyToText } from "../functions/query-service-schedule.js";
import type { CatalogSourceRecord } from "../catalog/store.js";
import type { NotionConfig, NotionDatabaseClient } from "../types.js";
import { normalizeNotionSchedulePage } from "./notion-adapter.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleItemInput } from "./store.js";

export interface SyncNotionScheduleSourceOptions {
  schedules: ScheduleStore;
  notion: NotionDatabaseClient;
  source: CatalogSourceRecord;
  databaseId: string;
  properties: NotionConfig["properties"];
  now?: () => Date;
  signal?: AbortSignal;
}

export interface SyncNotionScheduleSourceResult {
  upserted: number;
  skipped: number;
  tombstoned: number;
  malformed: number;
}

export async function syncNotionScheduleSource(
  options: SyncNotionScheduleSourceOptions
): Promise<SyncNotionScheduleSourceResult> {
  options.signal?.throwIfAborted();
  const pages = await options.notion.queryDatabase(options.databaseId);
  options.signal?.throwIfAborted();
  const snapshotItems: ScheduleItemInput[] = [];
  let skipped = 0;
  let malformed = 0;

  for (const page of pages) {
    const serviceDate = extractDateKey(
      configuredPropertyToText(page.properties, options.properties.date)
    );
    if (!serviceDate) {
      skipped += 1;
      continue;
    }
    const normalized = normalizeNotionSchedulePage({
      pageId: page.id,
      serviceDate,
      meeting: configuredPropertyToText(page.properties, options.properties.meeting),
      role: configuredPropertyToText(page.properties, options.properties.role),
      person: configuredPropertyToText(page.properties, options.properties.person)
    });
    malformed += normalized.malformedLines;
    if (normalized.meeting.assignments.length === 0) {
      skipped += 1;
      continue;
    }
    for (const assignment of normalized.meeting.assignments) {
      snapshotItems.push({
        profileName: options.source.profileName,
        sourceKey: options.source.sourceKey,
        origin: "notion",
        externalId: page.id,
        externalKey: assignment.externalKey,
        serviceDate: normalized.meeting.serviceDate,
        meeting: normalized.meeting.meeting,
        role: assignment.role,
        assignee: assignment.assignees.join(",")
      });
    }
  }

  options.signal?.throwIfAborted();
  const publishedAt = (options.now ?? (() => new Date()))().toISOString();
  const publication = await options.schedules.publishSnapshot({
    profileName: options.source.profileName,
    sourceKey: options.source.sourceKey,
    origin: "notion",
    revision: `${options.source.id}:${publishedAt}`,
    items: snapshotItems,
    publishedAt
  });

  options.signal?.throwIfAborted();
  return {
    upserted: publication.published,
    skipped,
    tombstoned: Math.max(0, publication.replaced - publication.published),
    malformed
  };
}

function extractDateKey(value: string): string {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

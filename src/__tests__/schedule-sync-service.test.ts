import { describe, expect, it, vi } from "vitest";

import { syncCatalogSources } from "../catalog/sync-service.js";
import { InMemoryCatalogStore, type CatalogSourceInput } from "../catalog/store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import type { NotionDatabaseClient } from "../types.js";

const notionScheduleSource: CatalogSourceInput = {
  profileName: "helper",
  sourceKey: "media_team_service_schedule",
  adapterType: "notion",
  domain: "schedule",
  defaultItemKind: "media_service_schedule",
  rootLocation: { databaseId: "database-1" },
  enabled: true,
  syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
  capabilities: { read: ["query_schedule"], write: [] }
};

describe("schedule sync service", () => {
  it("syncs enabled Notion schedule sources into the schedule read model", async () => {
    const catalog = new InMemoryCatalogStore();
    const schedules = new InMemoryScheduleStore();
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            日期: { type: "date", date: { start: "2026-07-12" } },
            聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
            角色: { type: "rich_text", rich_text: [{ plain_text: "投影" }] },
            同工: { type: "rich_text", rich_text: [{ plain_text: "知樂" }] }
          }
        }
      ])
    };

    const result = await syncCatalogSources({
      catalog,
      schedules,
      notion,
      notionProperties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      sources: [notionScheduleSource]
    });

    expect(result.scheduleUpserted).toBe(1);
    expect(result.scheduleTombstoned).toBe(0);
    await expect(
      schedules.searchItems({ profileName: "helper", query: "主日投影", limit: 10 })
    ).resolves.toMatchObject([
      {
        profileName: "helper",
        sourceKey: "media_team_service_schedule",
        origin: "notion",
        externalId: "page-1",
        serviceDate: "2026-07-12",
        meeting: "主日",
        role: "投影",
        assignee: "知樂"
      }
    ]);
  });

  it("tombstones Notion-origin schedule rows missing from a later sync", async () => {
    const catalog = new InMemoryCatalogStore();
    const schedules = new InMemoryScheduleStore();
    const notion: NotionDatabaseClient = {
      queryDatabase: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "page-1",
            properties: {
              日期: { type: "date", date: { start: "2026-07-12" } },
              聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
              角色: { type: "rich_text", rich_text: [{ plain_text: "投影" }] },
              同工: { type: "rich_text", rich_text: [{ plain_text: "知樂" }] }
            }
          },
          {
            id: "page-2",
            properties: {
              日期: { type: "date", date: { start: "2026-07-19" } },
              聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
              角色: { type: "rich_text", rich_text: [{ plain_text: "音控" }] },
              同工: { type: "rich_text", rich_text: [{ plain_text: "Ray" }] }
            }
          }
        ])
        .mockResolvedValueOnce([
          {
            id: "page-2",
            properties: {
              日期: { type: "date", date: { start: "2026-07-19" } },
              聚會: { type: "rich_text", rich_text: [{ plain_text: "主日" }] },
              角色: { type: "rich_text", rich_text: [{ plain_text: "音控" }] },
              同工: { type: "rich_text", rich_text: [{ plain_text: "Ray" }] }
            }
          }
        ])
    };

    await syncCatalogSources({
      catalog,
      schedules,
      notion,
      notionProperties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      sources: [notionScheduleSource]
    });
    const result = await syncCatalogSources({
      catalog,
      schedules,
      notion,
      notionProperties: { date: "日期", meeting: "聚會", role: "角色", person: "同工" },
      sources: [notionScheduleSource],
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });

    expect(result.scheduleTombstoned).toBe(1);
    await expect(
      schedules.searchItems({ profileName: "helper", query: "投影", limit: 10 })
    ).resolves.toHaveLength(0);
    await expect(
      schedules.searchItems({ profileName: "helper", query: "音控", limit: 10 })
    ).resolves.toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { searchCatalogWithFreshness } from "../catalog/retrieval.js";
import { InMemoryCatalogStore } from "../catalog/store.js";

const sourceInput = {
  profileName: "helper",
  sourceKey: "slides",
  adapterType: "onedrive" as const,
  domain: "presentation",
  defaultItemKind: "ppt_slide",
  rootLocation: { driveId: "d", folderItemId: "f" },
  enabled: true,
  syncPolicy: { mode: "scheduled" as const, intervalMinutes: 10 },
  capabilities: { read: ["find_ppt_slides"], write: [] }
};

describe("catalog publication freshness", () => {
  it("does not present a never-synced source as not found", async () => {
    const catalog = new InMemoryCatalogStore();
    await catalog.upsertSource(sourceInput);
    await expect(
      searchCatalogWithFreshness({
        catalog,
        search: { profileName: "helper", query: "新檔案", domains: ["presentation"] }
      })
    ).resolves.toMatchObject({ status: "unavailable", items: [] });
  });

  it("publishes a complete source atomically and classifies a real miss", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource(sourceInput);
    const published = await catalog.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: "0",
      publishedAt: "2026-07-20T00:00:00.000Z",
      items: [
        {
          sourceId: source.id,
          itemKind: "ppt_slide",
          domain: "presentation",
          title: "新的投影片.pptx",
          storageRef: { provider: "graph", driveId: "d", itemId: "new" }
        }
      ]
    });
    expect(published).toMatchObject({ revision: "1", healthStatus: "ready" });
    await expect(
      searchCatalogWithFreshness({
        catalog,
        search: { profileName: "helper", query: "不存在", domains: ["presentation"] },
        now: new Date("2026-07-20T00:05:00.000Z")
      })
    ).resolves.toMatchObject({ status: "not_found", revision: "slides:1" });
  });

  it("keeps the prior revision when a publication loses the revision race", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource(sourceInput);
    await catalog.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: "0",
      publishedAt: "2026-07-20T00:00:00.000Z",
      items: []
    });
    await expect(
      catalog.publishSourceSnapshot({
        sourceId: source.id,
        expectedRevision: "0",
        publishedAt: "2026-07-20T00:01:00.000Z",
        items: []
      })
    ).resolves.toBeUndefined();
    await expect(catalog.listSources({ profileName: "helper" })).resolves.toEqual([
      expect.objectContaining({ revision: "1", lastSuccessAt: "2026-07-20T00:00:00.000Z" })
    ]);
  });
});

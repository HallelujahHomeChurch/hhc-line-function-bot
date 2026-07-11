import { describe, expect, it } from "vitest";

import { syncCatalogSources } from "../catalog/sync-service.js";
import { InMemoryCatalogStore, type CatalogSourceInput } from "../catalog/store.js";
import type { GraphDriveClient } from "../types.js";

const enabledSource: CatalogSourceInput = {
  profileName: "helper",
  sourceKey: "weekly_report_audio",
  adapterType: "onedrive",
  domain: "audio",
  defaultItemKind: "weekly_report_audio",
  rootLocation: { driveId: "drive-1", folderItemId: "folder-1" },
  enabled: true,
  syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
  capabilities: { read: ["helper"], write: [] }
};

describe("catalog sync service", () => {
  it("syncs enabled OneDrive sources and skips disabled sources", async () => {
    const catalog = new InMemoryCatalogStore();
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderFilesRecursive: async () => [
        {
          id: "audio-1",
          driveId: "drive-1",
          name: "2026-07-週報音檔.mp3",
          path: "2026/2026-07-週報音檔.mp3"
        }
      ],
      createSharingLink: async () => "unused"
    };

    const result = await syncCatalogSources({
      catalog,
      graph,
      sources: [enabledSource, { ...enabledSource, sourceKey: "disabled_audio", enabled: false }]
    });

    expect(result).toEqual({
      sources: 2,
      synced: 1,
      skipped: 1,
      upserted: 1,
      itemSkipped: 0,
      tombstoned: 0,
      scheduleUpserted: 0,
      scheduleSkipped: 0,
      scheduleTombstoned: 0
    });
    await expect(
      catalog.searchItems({
        profileName: "helper",
        query: "週報音檔",
        itemKinds: ["weekly_report_audio"]
      })
    ).resolves.toHaveLength(1);
  });
});

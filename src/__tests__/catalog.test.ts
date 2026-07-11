import { describe, expect, it } from "vitest";

import {
  InMemoryCatalogStore,
  normalizeCatalogText,
  type CatalogItemInput,
  type CatalogSourceInput
} from "../catalog/store.js";
import { syncOneDriveCatalogSource } from "../catalog/onedrive-sync.js";
import type { GraphDriveClient } from "../types.js";

const helperSource: CatalogSourceInput = {
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

const mainSource: CatalogSourceInput = {
  ...helperSource,
  profileName: "main",
  sourceKey: "main_weekly_report_audio",
  capabilities: { read: ["main"], write: [] }
};

function audioItem(sourceId: string, title: string): CatalogItemInput {
  return {
    sourceId,
    itemKind: "weekly_report_audio",
    domain: "audio",
    title,
    path: `${title}.mp3`,
    mimeType: "audio/mpeg",
    extension: ".mp3",
    sizeBytes: 1024,
    sha256: `sha-${title}`,
    storageRef: { provider: "graph", driveId: "drive-1", itemId: `item-${title}` },
    externalUpdatedAt: "2026-07-11T00:00:00.000Z"
  };
}

describe("catalog store", () => {
  it("indexes future item kinds such as weekly report audio without schema changes", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource(helperSource);
    await store.upsertItem(audioItem(source.id, "2026-07-週報音檔"));

    const results = await store.searchItems({
      profileName: "helper",
      query: "週報音檔",
      itemKinds: ["weekly_report_audio"],
      allowedSourceKeys: ["weekly_report_audio"]
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      itemKind: "weekly_report_audio",
      title: "2026-07-週報音檔",
      source: { sourceKey: "weekly_report_audio", domain: "audio" },
      storageRef: { provider: "graph", driveId: "drive-1" }
    });
  });

  it("filters catalog search by profile, source, item kind, and deleted state", async () => {
    const store = new InMemoryCatalogStore();
    const helper = await store.upsertSource(helperSource);
    const main = await store.upsertSource(mainSource);
    const active = await store.upsertItem(audioItem(helper.id, "active weekly report"));
    await store.upsertItem(audioItem(main.id, "main weekly report"));
    await store.upsertItem({
      ...audioItem(helper.id, "deleted weekly report"),
      deletedAt: "2026-07-11T01:00:00.000Z"
    });

    const results = await store.searchItems({
      profileName: "helper",
      query: "weekly report",
      itemKinds: ["weekly_report_audio"],
      allowedSourceKeys: ["weekly_report_audio"]
    });

    expect(results.map((item) => item.id)).toEqual([active.id]);
  });

  it("normalizes catalog text for fuzzy Chinese and filename lookup", () => {
    expect(normalizeCatalogText("  週報音檔-2026/07.MP3  ")).toBe("週報音檔202607mp3");
  });

  it("syncs an enabled OneDrive source into catalog items with arbitrary item kinds", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource(helperSource);
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderFilesRecursive: async () => [
        {
          id: "audio-1",
          driveId: "drive-1",
          name: "2026-07-週報音檔.mp3",
          path: "weekly/2026-07-週報音檔.mp3"
        }
      ],
      createSharingLink: async () => "unused"
    };

    const result = await syncOneDriveCatalogSource({ catalog: store, graph, source });

    expect(result).toEqual({ upserted: 1, skipped: 0 });
    await expect(
      store.searchItems({
        profileName: "helper",
        query: "週報音檔",
        itemKinds: ["weekly_report_audio"],
        allowedSourceKeys: ["weekly_report_audio"]
      })
    ).resolves.toMatchObject([
      {
        title: "2026-07-週報音檔.mp3",
        itemKind: "weekly_report_audio",
        storageRef: { provider: "graph", driveId: "drive-1", itemId: "audio-1" }
      }
    ]);
  });
});

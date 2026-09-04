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
  it("round-trips source responsibility and preserves it when an upsert omits the fields", async () => {
    const store = new InMemoryCatalogStore();
    await store.upsertSource({
      ...helperSource,
      ownerLabel: "週報同工",
      freshnessResponsibility: "每週一前確認音檔"
    });

    await store.upsertSource({ ...helperSource, enabled: false });

    await expect(store.listSources({ profileName: "helper" })).resolves.toMatchObject([
      {
        sourceKey: "weekly_report_audio",
        enabled: false,
        ownerLabel: "週報同工",
        freshnessResponsibility: "每週一前確認音檔"
      }
    ]);

    await store.upsertSource({
      ...helperSource,
      ownerLabel: "影音同工",
      freshnessResponsibility: "每週二前確認音檔"
    });

    await expect(store.listSources({ profileName: "helper" })).resolves.toMatchObject([
      {
        ownerLabel: "影音同工",
        freshnessResponsibility: "每週二前確認音檔"
      }
    ]);
  });

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

  it("returns newer matching catalog items first", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource(helperSource);
    await store.upsertItem({
      ...audioItem(source.id, "A old weekly report"),
      externalUpdatedAt: "2026-07-01T00:00:00.000Z"
    });
    await store.upsertItem({
      ...audioItem(source.id, "Z new weekly report"),
      externalUpdatedAt: "2026-07-12T00:00:00.000Z"
    });

    const results = await store.searchItems({
      profileName: "helper",
      query: "weekly report"
    });

    expect(results.map(({ title }) => title)).toEqual([
      "Z new weekly report",
      "A old weekly report"
    ]);
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

  it("filters expired catalog items from normal search", async () => {
    const store = new InMemoryCatalogStore();
    const helper = await store.upsertSource(helperSource);
    await store.upsertItem({
      ...audioItem(helper.id, "expired weekly report"),
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    const active = await store.upsertItem({
      ...audioItem(helper.id, "future weekly report"),
      expiresAt: "2999-01-01T00:00:00.000Z"
    });

    const results = await store.searchItems({
      profileName: "helper",
      query: "weekly report",
      itemKinds: ["weekly_report_audio"],
      allowedSourceKeys: ["weekly_report_audio"]
    });

    expect(results.map((item) => item.id)).toEqual([active.id]);
  });

  it("updates source enabled state without changing source metadata", async () => {
    const store = new InMemoryCatalogStore();
    await store.upsertSource(helperSource);

    const disabled = await store.updateSourceEnabled({
      profileName: "helper",
      sourceKey: "weekly_report_audio",
      enabled: false
    });
    const missing = await store.updateSourceEnabled({
      profileName: "helper",
      sourceKey: "missing_source",
      enabled: true
    });

    expect(disabled).toMatchObject({
      profileName: "helper",
      sourceKey: "weekly_report_audio",
      enabled: false,
      rootLocation: { driveId: "drive-1", folderItemId: "folder-1" },
      capabilities: { read: ["helper"], write: [] }
    });
    expect(missing).toBeUndefined();
    await expect(
      store.listSources({ profileName: "helper", enabled: false })
    ).resolves.toHaveLength(1);
  });

  it("persists and clears a source delta cursor", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource(helperSource);

    await store.updateSourceSyncCursor(source.id, "https://graph.microsoft.com/delta/token-1");
    expect((await store.listSources({ profileName: "helper" }))[0].syncCursor).toBe(
      "https://graph.microsoft.com/delta/token-1"
    );

    await store.updateSourceSyncCursor(source.id, undefined);
    expect((await store.listSources({ profileName: "helper" }))[0].syncCursor).toBeUndefined();
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

    expect(result).toEqual({ upserted: 1, skipped: 0, tombstoned: 0 });
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

  it("skips files outside the source extension policy", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource({
      ...helperSource,
      defaultItemKind: "pop_sheet",
      domain: "sheet_music",
      syncPolicy: {
        mode: "scheduled",
        intervalMinutes: 15,
        allowedExtensions: [".pdf", ".jpg", ".jpeg"]
      }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderFilesRecursive: async () => [
        { id: "pdf-1", driveId: "pop-drive", name: "A TIME FOR US.pdf" },
        { id: "gif-1", driveId: "pop-drive", name: "cover.gif" },
        { id: "db-1", driveId: "pop-drive", name: "Thumbs.db" }
      ],
      createSharingLink: async () => "unused"
    };

    const result = await syncOneDriveCatalogSource({ catalog: store, graph, source });

    expect(result).toEqual({ upserted: 1, skipped: 2, tombstoned: 0 });
    await expect(
      store.searchItems({ profileName: "helper", itemKinds: ["pop_sheet"] })
    ).resolves.toMatchObject([{ title: "A TIME FOR US.pdf" }]);
  });

  it("applies incremental delta upserts and deletions before advancing the cursor", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource({
      ...helperSource,
      defaultItemKind: "pop_sheet",
      domain: "sheet_music",
      syncPolicy: { mode: "scheduled", allowedExtensions: [".pdf"] }
    });
    await store.upsertItem({
      sourceId: source.id,
      itemKind: "pop_sheet",
      domain: "sheet_music",
      title: "Deleted.pdf",
      extension: ".pdf",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "deleted-1" }
    });
    await store.updateSourceSyncCursor(source.id, "cursor-1");
    const current = (await store.listSources({ sourceKeys: [source.sourceKey] }))[0];
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderDelta: async (_driveId, _folderItemId, cursor) => {
        expect(cursor).toBe("cursor-1");
        return {
          items: [
            { id: "added-1", driveId: "drive-1", name: "Added.pdf" },
            { id: "deleted-1", driveId: "drive-1", name: "", deleted: true }
          ],
          deltaLink: "cursor-2"
        };
      },
      createSharingLink: async () => "unused"
    };

    const result = await syncOneDriveCatalogSource({ catalog: store, graph, source: current });

    expect(result).toEqual({ upserted: 1, skipped: 0, tombstoned: 1 });
    await expect(
      store.searchItems({ profileName: "helper", itemKinds: ["pop_sheet"] })
    ).resolves.toMatchObject([{ title: "Added.pdf" }]);
    expect((await store.listSources({ sourceKeys: [source.sourceKey] }))[0].syncCursor).toBe(
      "cursor-2"
    );
  });

  it("clears a stale delta cursor and re-enumerates after Graph returns 410", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource({
      ...helperSource,
      defaultItemKind: "pop_sheet",
      domain: "sheet_music",
      syncPolicy: { mode: "scheduled", allowedExtensions: [".pdf"] }
    });
    await store.updateSourceSyncCursor(source.id, "stale-cursor");
    const current = (await store.listSources({ sourceKeys: [source.sourceKey] }))[0];
    const cursors: Array<string | undefined> = [];
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderDelta: async (_driveId, _folderItemId, cursor) => {
        cursors.push(cursor);
        if (cursor) {
          throw Object.assign(new Error("resync required"), { statusCode: 410 });
        }
        return {
          items: [{ id: "fresh-1", driveId: "drive-1", name: "Fresh.pdf" }],
          deltaLink: "fresh-cursor"
        };
      },
      createSharingLink: async () => "unused"
    };

    await expect(
      syncOneDriveCatalogSource({ catalog: store, graph, source: current })
    ).resolves.toEqual({ upserted: 1, skipped: 0, tombstoned: 0 });
    expect(cursors).toEqual(["stale-cursor", undefined]);
    expect((await store.listSources({ sourceKeys: [source.sourceKey] }))[0].syncCursor).toBe(
      "fresh-cursor"
    );
  });

  it("falls back to a full crawl when a source does not support delta", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource({
      ...helperSource,
      defaultItemKind: "pop_sheet",
      domain: "sheet_music",
      syncPolicy: { mode: "scheduled", allowedExtensions: [".pdf"] }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [
        { id: "fallback-1", driveId: "drive-1", name: "Fallback.pdf" }
      ],
      listFolderDelta: async () => {
        throw Object.assign(new Error("not supported"), { statusCode: 400 });
      },
      createSharingLink: async () => "unused"
    };

    await expect(syncOneDriveCatalogSource({ catalog: store, graph, source })).resolves.toEqual({
      upserted: 1,
      skipped: 0,
      tombstoned: 0
    });
    await expect(
      store.searchItems({ profileName: "helper", itemKinds: ["pop_sheet"] })
    ).resolves.toMatchObject([{ title: "Fallback.pdf" }]);
  });

  it("tombstones catalog items missing from a later OneDrive full crawl", async () => {
    const store = new InMemoryCatalogStore();
    const source = await store.upsertSource(helperSource);
    const graph: GraphDriveClient = {
      listFolderChildren: async () => [],
      listFolderFilesRecursive: async () => [
        { id: "audio-1", driveId: "drive-1", name: "保留.mp3" },
        { id: "audio-2", driveId: "drive-1", name: "刪除.mp3" }
      ],
      createSharingLink: async () => "unused"
    };
    await syncOneDriveCatalogSource({ catalog: store, graph, source });
    graph.listFolderFilesRecursive = async () => [
      { id: "audio-1", driveId: "drive-1", name: "保留.mp3" }
    ];

    const result = await syncOneDriveCatalogSource({
      catalog: store,
      graph,
      source,
      now: () => new Date("2026-07-11T01:00:00.000Z")
    });

    expect(result).toEqual({ upserted: 1, skipped: 0, tombstoned: 1 });
    await expect(
      store.searchItems({
        profileName: "helper",
        itemKinds: ["weekly_report_audio"]
      })
    ).resolves.toMatchObject([{ title: "保留.mp3" }]);
  });
});

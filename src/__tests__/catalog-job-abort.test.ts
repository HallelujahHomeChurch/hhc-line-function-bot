import { describe, expect, it, vi } from "vitest";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { syncCatalogSources } from "../catalog/sync-service.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { syncKnowledgeSource } from "../knowledge/sync-service.js";
import { syncScheduledKnowledgeSources } from "../knowledge/scheduled-sync.js";

async function knowledgeSource(store: InMemoryKnowledgeStore, sourceKey = "sop") {
  return store.upsertSource({
    profileName: "helper",
    sourceKey,
    displayName: "SOP",
    adapterType: "notion",
    externalRootId: "root",
    rootUrl: "https://example.test/root",
    enabled: true
  });
}
const documents = [
  {
    externalId: "doc",
    title: "SOP",
    url: "https://example.test/doc",
    properties: {},
    nodes: [{ externalId: "p", type: "paragraph", ordinal: 0, text: "設備關閉步驟" }]
  }
];

describe("catalog job terminal abort", () => {
  it("does not turn owner abort into embedding_pending or publish a snapshot", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await knowledgeSource(store);
    const publish = vi.spyOn(store, "publishSourceSnapshot");
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    await expect(
      syncKnowledgeSource({
        source,
        store,
        signal: controller.signal,
        notion: { fetchRoot: async () => documents },
        embedding: {
          provider: "fixture",
          model: "fixture",
          dimensions: 3,
          embed: async () => {
            controller.abort(reason);
            throw reason;
          }
        }
      })
    ).rejects.toBe(reason);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not mark failed or continue to another knowledge source after owner abort", async () => {
    const store = new InMemoryKnowledgeStore();
    const sources = [await knowledgeSource(store, "first"), await knowledgeSource(store, "second")];
    const mark = vi.spyOn(store, "markSourceSyncFailed");
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    const fetchRoot = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      syncScheduledKnowledgeSources({
        sources,
        store,
        notion: { fetchRoot },
        signal: controller.signal
      })
    ).rejects.toBe(reason);
    expect(fetchRoot).toHaveBeenCalledOnce();
    expect(mark).not.toHaveBeenCalled();
  });

  it("does not reset a committed delta cursor or write failure bookkeeping after abort", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "audio",
      adapterType: "onedrive",
      domain: "audio",
      defaultItemKind: "weekly_report_audio",
      rootLocation: { driveId: "drive", folderItemId: "folder" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: [] }
    });
    await catalog.updateSourceSyncCursor(source.id, "committed-cursor");
    const cursor = vi.spyOn(catalog, "updateSourceSyncCursor");
    const mark = vi.spyOn(catalog, "markSourceSyncFailure");
    const controller = new AbortController();
    const reason = Object.assign(new Error("job_stopped"), { statusCode: 410 });
    const listFolderDelta = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      syncCatalogSources({
        catalog,
        signal: controller.signal,
        graph: {
          listFolderDelta,
          listFolderChildren: async () => [],
          createSharingLink: async () => "unused"
        }
      })
    ).rejects.toBe(reason);
    expect(listFolderDelta).toHaveBeenCalledOnce();
    expect(cursor).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect((await catalog.listSources())[0]?.syncCursor).toBe("committed-cursor");
  });
  it("keeps an earlier committed source receipt when a later source aborts", async () => {
    const catalog = new InMemoryCatalogStore();
    const base = {
      profileName: "helper",
      adapterType: "onedrive" as const,
      domain: "audio",
      defaultItemKind: "weekly_report_audio",
      enabled: true,
      syncPolicy: { mode: "scheduled" as const, intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: [] }
    };
    await catalog.upsertSource({
      ...base,
      sourceKey: "a",
      rootLocation: { driveId: "drive", folderItemId: "a" }
    });
    const second = await catalog.upsertSource({
      ...base,
      sourceKey: "b",
      rootLocation: { driveId: "drive", folderItemId: "b" }
    });
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    let committed: unknown;
    await expect(
      syncCatalogSources({
        catalog,
        signal: controller.signal,
        graph: {
          listFolderChildren: async () => [],
          createSharingLink: async () => "unused",
          listFolderFilesRecursive: async (_drive, folder) => {
            if (folder === "a") return [{ id: "file-a", name: "a.mp3", driveId: "drive" }];
            committed = (await catalog.listSources()).find((source) => source.sourceKey === "a");
            controller.abort(reason);
            throw reason;
          }
        }
      })
    ).rejects.toBe(reason);
    const sources = await catalog.listSources();
    expect(sources.find((source) => source.sourceKey === "a")).toEqual(committed);
    expect(sources.find((source) => source.sourceKey === "a")?.publishedItemCount).toBe(1);
    expect(sources.find((source) => source.sourceKey === "b")).toEqual(second);
  });
});

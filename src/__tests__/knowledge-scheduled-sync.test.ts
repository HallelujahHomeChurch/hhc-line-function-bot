import { describe, expect, it, vi } from "vitest";

import { syncScheduledKnowledgeSources } from "../knowledge/scheduled-sync.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";

describe("scheduled knowledge synchronization", () => {
  it("counts a stale invocation separately without mutating newer ready health", async () => {
    const store = new InMemoryKnowledgeStore();
    let source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    source = await store.publishSourceSnapshot({
      sourceId: source.id,
      expectedStagingRevision: source.stagingRevision,
      syncedAt: "2026-07-12T00:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "聚會 SOP",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });

    const result = await syncScheduledKnowledgeSources({
      sources: [source],
      store,
      notion: {
        fetchRoot: vi.fn(async () => {
          await store.publishSourceSnapshot({
            sourceId: source.id,
            expectedStagingRevision: source.stagingRevision,
            syncedAt: "2026-07-13T00:00:00Z",
            syncStatus: "ready",
            routingDisplayName: "聚會 SOP",
            aliases: [],
            topics: [],
            sampleQueries: [],
            documents: [],
            embeddings: []
          });
          return [];
        })
      }
    });

    expect(result).toEqual({
      sources: 1,
      synced: 0,
      failed: 0,
      stale: 1,
      documents: 0,
      chunks: 0,
      embedded: 0
    });
    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({ syncStatus: "ready", syncErrorCode: undefined })
    ]);
  });
});

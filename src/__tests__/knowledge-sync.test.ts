import { describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { syncKnowledgeSource } from "../knowledge/sync-service.js";
import { rebuildFailed } from "../tools/rebuild-knowledge-embeddings.js";

describe("knowledge sync", () => {
  it("publishes lexical content when embedding is unavailable and marks it pending", async () => {
    const store = new InMemoryKnowledgeStore(() => new Date("2026-07-12T00:00:00Z"));
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });

    const result = await syncKnowledgeSource({
      source,
      store,
      notion: {
        fetchRoot: vi.fn().mockResolvedValue([
          {
            externalId: "doc",
            title: "聚會 SOP",
            url: "https://example.test/doc",
            properties: {},
            nodes: [{ externalId: "p", type: "paragraph", ordinal: 0, text: "聚會後關閉設備" }]
          }
        ])
      },
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 3,
        embed: vi.fn().mockRejectedValue(new Error("offline"))
      },
      batchSize: 16,
      now: () => new Date("2026-07-12T00:00:00Z")
    });

    expect(result).toMatchObject({
      documents: 1,
      chunks: 1,
      embedded: 0,
      status: "embedding_pending"
    });
    expect(
      rebuildFailed(
        {
          sources: 1,
          synced: 1,
          failed: 0,
          stale: 0,
          embeddingPending: 1,
          documents: result.documents,
          chunks: result.chunks,
          embedded: result.embedded
        },
        false
      )
    ).toBe(true);
    await expect(store.search({ profileName: "helper", query: "關閉設備" })).resolves.toHaveLength(
      1
    );
    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([expect.objectContaining({ syncStatus: "embedding_pending" })]);
  });
});

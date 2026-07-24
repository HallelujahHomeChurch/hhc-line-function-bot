import { describe, expect, it } from "vitest";

import { InMemoryKnowledgeStore } from "../knowledge/store.js";

describe("knowledge store", () => {
  it("filters disabled and expired sources before hybrid retrieval", async () => {
    const store = new InMemoryKnowledgeStore(() => new Date("2026-07-12T00:00:00Z"));
    const active = await store.upsertSource({
      profileName: "helper",
      sourceKey: "meeting-sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "page-1",
      rootUrl: "https://www.notion.so/page-1",
      enabled: true
    });
    const expired = await store.upsertSource({
      profileName: "helper",
      sourceKey: "old-trip",
      displayName: "舊行程",
      adapterType: "notion",
      externalRootId: "page-2",
      rootUrl: "https://www.notion.so/page-2",
      enabled: true,
      expiresAt: "2026-07-11T00:00:00Z"
    });

    await store.replaceDocument({
      sourceId: active.id,
      externalId: "doc-1",
      title: "聚會 SOP",
      url: active.rootUrl,
      nodes: [{ externalId: "node-1", type: "paragraph", ordinal: 0, text: "聚會後關閉音控設備" }],
      chunks: [
        { headingPath: ["場復"], ordinal: 0, content: "聚會後關閉音控設備", contentHash: "h1" }
      ]
    });
    await store.replaceDocument({
      sourceId: expired.id,
      externalId: "doc-2",
      title: "舊行程",
      url: expired.rootUrl,
      nodes: [{ externalId: "node-2", type: "paragraph", ordinal: 0, text: "聚會後關閉音控設備" }],
      chunks: [{ headingPath: [], ordinal: 0, content: "聚會後關閉音控設備", contentHash: "h2" }]
    });
    for (const sourceKey of [active.sourceKey, expired.sourceKey]) {
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-10T00:00:00Z"
      });
    }

    const results = await store.search({ profileName: "helper", query: "關閉音控", limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.source.sourceKey).toBe("meeting-sop");
  });

  it("combines lexical and vector ranks while preserving exact ordinal matches", async () => {
    const store = new InMemoryKnowledgeStore(() => new Date("2026-07-12T00:00:00Z"));
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "trip",
      displayName: "八月出遊",
      adapterType: "notion",
      externalRootId: "page-1",
      rootUrl: "https://www.notion.so/page-1",
      enabled: true
    });
    const document = await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc-1",
      title: "八月出遊",
      url: source.rootUrl,
      nodes: [],
      chunks: [
        { headingPath: ["第一天"], ordinal: 0, content: "第一個地點是日月潭", contentHash: "h1" },
        { headingPath: ["第二天"], ordinal: 1, content: "第二個地點是清境農場", contentHash: "h2" }
      ]
    });
    await store.upsertEmbedding({
      chunkId: document.chunks[0]!.id,
      provider: "azure_openai",
      model: "text-embedding-3-small",
      dimensions: 3,
      embedding: [0, 1, 0],
      contentHash: "h1"
    });
    await store.upsertEmbedding({
      chunkId: document.chunks[1]!.id,
      provider: "azure_openai",
      model: "text-embedding-3-small",
      dimensions: 3,
      embedding: [1, 0, 0],
      contentHash: "h2"
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: source.sourceKey,
      syncStatus: "ready",
      lastSyncedAt: "2026-07-10T00:00:00Z"
    });

    const results = await store.search({
      profileName: "helper",
      query: "第一個地點",
      queryEmbedding: [1, 0, 0],
      ordinal: 0,
      limit: 2
    });

    expect(results[0]?.content).toContain("日月潭");
  });

  it("keeps the complete prior live snapshot when snapshot validation fails", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "舊 SOP",
      adapterType: "notion",
      externalRootId: "old-root",
      rootUrl: "https://example.test/old",
      enabled: true
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc-a",
      title: "舊文件",
      url: "https://example.test/old-doc",
      nodes: [],
      chunks: [{ headingPath: [], ordinal: 0, content: "舊版關閉設備。", contentHash: "old" }]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "sop",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-12T00:00:00Z"
    });
    await expect(
      (
        store as unknown as {
          publishSourceSnapshot(input: Record<string, unknown>): Promise<unknown>;
        }
      ).publishSourceSnapshot({
        sourceId: source.id,
        expectedStagingRevision: (source as unknown as { stagingRevision?: string })
          .stagingRevision,
        syncedAt: "2026-07-13T00:00:00Z",
        syncStatus: "ready",
        routingDisplayName: "新 SOP",
        aliases: [],
        topics: [],
        sampleQueries: [],
        documents: [
          {
            externalId: "doc-a",
            title: "新文件",
            url: "https://example.test/new-doc",
            properties: {},
            nodes: [],
            chunks: [{ headingPath: [], ordinal: 0, content: "新版關閉設備。", contentHash: "new" }]
          }
        ],
        embeddings: [
          {
            documentExternalId: "doc-a",
            contentHash: "new",
            provider: "azure_openai",
            model: "text-embedding-3-small",
            dimensions: 3,
            embedding: [1, 0]
          }
        ]
      })
    ).rejects.toThrow("knowledge_embedding_invalid");

    await expect(store.search({ profileName: "helper", query: "舊版關閉設備" })).resolves.toEqual([
      expect.objectContaining({ content: "舊版關閉設備。" })
    ]);
    const fuzzyResults = await store.search({ profileName: "helper", query: "新版關閉設備" });
    expect(fuzzyResults).not.toEqual([]);
    expect(fuzzyResults.every(({ content }) => content === "舊版關閉設備。")).toBe(true);
  });

  it("stages a re-added disabled source without changing its live core or lifecycle", async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "舊名稱",
      adapterType: "notion",
      externalRootId: "old-root",
      rootUrl: "https://example.test/old",
      enabled: true
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "retreat",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-12T00:00:00Z"
    });
    await store.updateSource({ profileName: "helper", sourceKey: "retreat", enabled: false });

    const restaged = await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "新名稱",
      adapterType: "notion",
      externalRootId: "new-root",
      rootUrl: "https://example.test/new",
      enabled: true,
      expiresAt: "2027-01-01T00:00:00Z"
    });

    expect(restaged).toMatchObject({
      displayName: "舊名稱",
      externalRootId: "old-root",
      rootUrl: "https://example.test/old",
      enabled: false,
      stagedDisplayName: "新名稱",
      stagedExternalRootId: "new-root",
      stagedRootUrl: "https://example.test/new",
      stagedEnabled: true,
      stagedExpiresAt: "2027-01-01T00:00:00Z"
    });
  });

  it("publishing one source snapshot preserves embeddings owned by other sources", async () => {
    const store = new InMemoryKnowledgeStore();
    const sources = [];
    for (const sourceKey of ["alpha", "beta"]) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: sourceKey,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      const document = await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: sourceKey,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [
          { headingPath: [], ordinal: 0, content: `${sourceKey} content`, contentHash: sourceKey }
        ]
      });
      await store.upsertEmbedding({
        chunkId: document.chunks[0]!.id,
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 3,
        embedding: [1, 0, 0],
        contentHash: sourceKey
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
      sources.push(source);
    }

    await store.publishSourceSnapshot({
      sourceId: sources[0]!.id,
      expectedStagingRevision: sources[0]!.stagingRevision,
      syncedAt: "2026-07-13T01:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "alpha",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });

    await expect(
      store.search({
        profileName: "helper",
        query: "",
        queryEmbedding: [1, 0, 0],
        sourceId: sources[1]!.id
      })
    ).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ sourceKey: "beta" }) })
    ]);
  });

  it("keeps one top result per bounded eligible source before context limiting", async () => {
    const store = new InMemoryKnowledgeStore();
    const sourceIds: string[] = [];
    for (const sourceKey of ["alpha", "beta"]) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} manual`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} document`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks:
          sourceKey === "alpha"
            ? Array.from({ length: 8 }, (_, ordinal) => ({
                headingPath: [],
                ordinal,
                content: "共同暗號",
                contentHash: `alpha-${ordinal}`
              }))
            : [
                {
                  headingPath: [],
                  ordinal: 8,
                  content: "共同暗號",
                  contentHash: "beta"
                }
              ]
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
      sourceIds.push(source.id);
    }

    await expect(
      store.search({ profileName: "helper", query: "共同暗號", sourceIds, limit: 8 })
    ).resolves.toSatisfy((results) => results.every(({ source }) => source.sourceKey === "alpha"));
    await expect(
      store.searchTopPerSource({ profileName: "helper", query: "共同暗號", sourceIds })
    ).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ sourceKey: "alpha" }) }),
      expect.objectContaining({ source: expect.objectContaining({ sourceKey: "beta" }) })
    ]);
    await expect(
      store.searchTopPerSource({
        profileName: "helper",
        query: "共同暗號",
        ordinal: 8,
        sourceIds
      })
    ).resolves.toEqual([
      expect.objectContaining({
        score: 4,
        ordinal: 8,
        source: expect.objectContaining({ sourceKey: "beta" })
      }),
      expect.objectContaining({
        score: 1.5,
        source: expect.objectContaining({ sourceKey: "alpha" })
      })
    ]);
    await expect(
      store.searchTopPerSource({
        profileName: "helper",
        query: "共同暗號",
        sourceIds: Array.from({ length: 21 }, (_, index) => `source-${index}`)
      })
    ).rejects.toThrow("knowledge_source_scope_limit");
  });

  it("rotates the staging revision and ignores failure from the published revision", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });

    const published = await store.publishSourceSnapshot({
      sourceId: source.id,
      expectedStagingRevision: source.stagingRevision,
      syncedAt: "2026-07-13T00:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "SOP",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });

    expect(published.stagingRevision).not.toBe(source.stagingRevision);
    await expect(
      store.markSourceSyncFailed({
        profileName: "helper",
        sourceKey: "sop",
        expectedStagingRevision: source.stagingRevision,
        syncErrorCode: "source_unavailable"
      })
    ).resolves.toBe("stale");
    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([
      expect.objectContaining({ syncStatus: "ready", syncErrorCode: undefined })
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { createQueryKnowledgeHandler } from "../functions/query-knowledge.js";
import type { BotProfileConfig } from "../types.js";

const profile = { name: "helper", enabledFunctions: ["query_knowledge"] } as BotProfileConfig;

describe("query_knowledge", () => {
  it("answers only from retrieved evidence and includes a source link without provider names", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "trip",
      displayName: "八月出遊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://www.notion.so/root",
      enabled: true
    });
    const document = await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "八月出遊",
      url: "https://www.notion.so/doc",
      nodes: [],
      chunks: [
        { headingPath: ["第一天"], ordinal: 0, content: "第一個地點是日月潭。", contentHash: "h1" }
      ]
    });
    const embed = vi.fn().mockResolvedValue([[1, 0, 0]]);
    await store.upsertEmbedding({
      chunkId: document.chunks[0]!.id,
      provider: "ollama",
      model: "bge-m3",
      dimensions: 3,
      embedding: [1, 0, 0],
      contentHash: "h1"
    });
    const completeText = vi.fn().mockResolvedValue("第一個地點是日月潭。");
    const handler = createQueryKnowledgeHandler({
      store,
      embedding: { provider: "ollama", model: "bge-m3", dimensions: 3, embed },
      textGenerator: { completeText }
    });

    const result = await handler(
      { query: "第一個地點是哪裡", ordinal: 0 },
      {
        profile,
        event: {
          type: "message",
          replyToken: "r",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "第一個地點是哪裡" }
        }
      }
    );

    expect(result.replyText).toContain("第一個地點是日月潭");
    expect(result.replyText).toContain("八月出遊：https://www.notion.so/doc");
    expect(result.replyText).not.toMatch(/(?:Notion|pgvector|Ollama)[：:]/iu);
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("只能根據證據") })
    );
  });

  it("falls back to lexical retrieval and a controlled excerpt when providers fail", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "聚會 SOP",
      url: "https://example.test/doc",
      nodes: [],
      chunks: [
        {
          headingPath: ["場復"],
          ordinal: 0,
          content: "聚會結束後請關閉音控設備。",
          contentHash: "h1"
        }
      ]
    });
    const handler = createQueryKnowledgeHandler({
      store,
      embedding: {
        provider: "ollama",
        model: "bge-m3",
        dimensions: 3,
        embed: vi.fn().mockRejectedValue(new Error("offline"))
      },
      textGenerator: { completeText: vi.fn().mockRejectedValue(new Error("offline")) }
    });

    const result = await handler(
      { query: "關閉音控設備" },
      {
        profile,
        event: {
          type: "message",
          replyToken: "r",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "關閉音控設備" }
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("聚會結束後請關閉音控設備");
  });

  it("uses the canonical document first and falls back globally for a new topic", async () => {
    const store = new InMemoryKnowledgeStore();
    const trip = await store.upsertSource({
      profileName: "helper",
      sourceKey: "trip",
      displayName: "出遊計畫",
      adapterType: "notion",
      externalRootId: "trip-root",
      rootUrl: "https://example.test/trip",
      enabled: true
    });
    const sop = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "sop-root",
      rootUrl: "https://example.test/sop",
      enabled: true
    });
    const tripDocument = await store.replaceDocument({
      sourceId: trip.id,
      externalId: "trip-doc",
      title: "出遊計畫",
      url: "https://example.test/trip-doc",
      nodes: [],
      chunks: [{ headingPath: [], ordinal: 0, content: "共同事項是攜帶雨具。", contentHash: "t1" }]
    });
    await store.replaceDocument({
      sourceId: sop.id,
      externalId: "sop-doc",
      title: "聚會 SOP",
      url: "https://example.test/sop-doc",
      nodes: [],
      chunks: [
        {
          headingPath: [],
          ordinal: 0,
          content: "共同事項是關閉門窗。消防設備放在後門。",
          contentHash: "s1"
        }
      ]
    });
    const handler = createQueryKnowledgeHandler({ store });
    const continuation = {
      functionName: "query_knowledge" as const,
      arguments: {},
      resultReferences: { sourceKey: "trip", documentId: tripDocument.id },
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:01:00.000Z"
    };
    const handlerContext = {
      profile,
      continuation,
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "u" },
        message: { type: "text" as const, text: "共同事項" }
      }
    };

    const scoped = await handler({ query: "共同事項" }, handlerContext);
    const fallback = await handler(
      { query: "消防設備" },
      {
        ...handlerContext,
        event: { ...handlerContext.event, message: { type: "text", text: "消防設備" } }
      }
    );

    expect(scoped.replyText).toContain("攜帶雨具");
    expect(scoped.replyText).not.toContain("sop-doc");
    expect(fallback.replyText).toContain("消防設備放在後門");
    expect(fallback.continuation?.resultReferences).toEqual(
      expect.objectContaining({ sourceKey: "sop" })
    );
  });
});

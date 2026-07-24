import { describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import {
  createQueryKnowledgeHandler,
  createQueryKnowledgePostbackHandler,
  createQueryKnowledgeTextMessageHandler
} from "../functions/query-knowledge.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { BotProfileConfig } from "../types.js";

const profile = { name: "helper", enabledFunctions: ["query_knowledge"] } as BotProfileConfig;

function knowledgeTask(reference: Record<string, unknown>) {
  return {
    version: 1 as const,
    capability: "query_knowledge" as const,
    anchors: { ...reference },
    entities: [],
    references: { ...reference },
    supportedOperations: ["continue", "refine", "select"],
    createdAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-14T00:00:00.000Z"
  };
}

describe("query_knowledge", () => {
  it("clarifies an equal cross-source maximum hidden beyond the answer-context limit", async () => {
    const store = new InMemoryKnowledgeStore();
    const sessionStore = new InMemorySessionStore();
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
    }
    const handler = createQueryKnowledgeHandler({ store, sessionStore });

    const result = await handler(
      { query: "共同暗號" },
      {
        profile,
        event: {
          type: "message",
          replyToken: "r",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "共同暗號" }
        }
      }
    );

    expect(result.agentResult).toMatchObject({ status: "ambiguous" });
    expect(result.quickReplies).toHaveLength(2);
  });

  it("rejects unsynced sources consistently for search and anchors", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "draft",
      displayName: "尚未同步",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    const document = await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "草稿",
      url: "https://example.test/doc",
      nodes: [],
      chunks: [{ headingPath: ["段落"], ordinal: 0, content: "不可搜尋", contentHash: "h" }]
    });

    await expect(store.search({ profileName: "helper", query: "不可搜尋" })).resolves.toEqual([]);
    await expect(
      store.hasAnchor({
        profileName: "helper",
        sourceId: source.id,
        documentId: document.id
      })
    ).resolves.toBe(false);
  });

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
      provider: "azure_openai",
      model: "text-embedding-3-small",
      dimensions: 3,
      embedding: [1, 0, 0],
      contentHash: "h1"
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "trip",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-13T00:00:00Z"
    });
    const completeText = vi.fn().mockResolvedValue("第一個地點是日月潭。");
    const handler = createQueryKnowledgeHandler({
      store,
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 3,
        embed
      },
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
    expect(result.replyText).not.toMatch(/(?:Notion|pgvector)[：:]/iu);
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("只能根據證據") })
    );
    expect(result.agentResult).toMatchObject({
      status: "success",
      anchors: {
        sourceId: source.id,
        documentId: document.id,
        sectionKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        ordinal: 0
      },
      entities: expect.arrayContaining([
        expect.objectContaining({ type: "source", key: source.id, label: "知識來源" }),
        expect.objectContaining({ type: "document", key: document.id, label: "知識文件" }),
        expect.objectContaining({
          type: "section",
          key: expect.stringMatching(/^[a-f0-9]{64}$/u),
          label: "知識段落"
        }),
        expect.objectContaining({ type: "ordinal", key: "0" })
      ]),
      supportedOperations: ["continue", "refine", "select"]
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(
      /https?:|日月潭|notion|八月出遊|第一天|trip/iu
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
    await store.updateSource({
      profileName: "helper",
      sourceKey: "sop",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-13T00:00:00Z"
    });
    const handler = createQueryKnowledgeHandler({
      store,
      embedding: {
        provider: "azure_openai",
        model: "text-embedding-3-small",
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

  it("uses the canonical document first and only switches globally with current metadata evidence", async () => {
    const store = new InMemoryKnowledgeStore();
    const trip = await store.upsertSource({
      profileName: "helper",
      sourceKey: "trip",
      displayName: "出遊計畫",
      adapterType: "notion",
      externalRootId: "trip-root",
      rootUrl: "https://example.test/trip",
      enabled: true,
      aliases: ["出遊"],
      topics: ["共同事項"]
    });
    const sop = await store.upsertSource({
      profileName: "helper",
      sourceKey: "sop",
      displayName: "聚會 SOP",
      adapterType: "notion",
      externalRootId: "sop-root",
      rootUrl: "https://example.test/sop",
      enabled: true,
      aliases: ["場復"],
      topics: ["消防設備"]
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
    for (const sourceKey of ["trip", "sop"]) {
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z",
        aliases: sourceKey === "trip" ? ["出遊"] : ["場復"],
        topics: sourceKey === "trip" ? ["共同事項"] : ["消防設備"]
      });
    }
    const handler = createQueryKnowledgeHandler({ store });
    const handlerContext = {
      profile,
      activeTask: knowledgeTask({ sourceId: trip.id, documentId: tripDocument.id }),
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "u" },
        message: { type: "text" as const, text: "共同事項" }
      }
    };

    const scoped = await handler({ query: "共同事項" }, handlerContext);
    const noSwitch = await handler(
      { query: "後門在哪裡" },
      {
        ...handlerContext,
        event: { ...handlerContext.event, message: { type: "text", text: "後門在哪裡" } }
      }
    );
    const switched = await handler(
      { query: "消防設備放哪裡" },
      {
        ...handlerContext,
        event: { ...handlerContext.event, message: { type: "text", text: "消防設備放哪裡" } }
      }
    );

    expect(scoped.replyText).toContain("攜帶雨具");
    expect(scoped.replyText).not.toContain("sop-doc");
    expect(noSwitch.agentResult).toMatchObject({ status: "not_found" });
    expect(switched.replyText).toContain("消防設備放在後門");
    expect(switched.agentResult?.anchors).toEqual(expect.objectContaining({ sourceId: sop.id }));
  });

  it("returns safe not-found, ambiguous, and unavailable result envelopes", async () => {
    const now = () => new Date("2026-07-13T00:00:00Z");
    const store = new InMemoryKnowledgeStore(now);
    for (const sourceKey of ["alpha", "beta"]) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} 手冊`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true,
        topics: ["集合"]
      });
      await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} 文件`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [
          {
            headingPath: ["集合"],
            ordinal: 0,
            content: `${sourceKey} 集合資料`,
            contentHash: `${sourceKey}-hash`
          }
        ]
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z",
        topics: ["集合"]
      });
    }
    const handler = createQueryKnowledgeHandler({ store });
    const context = {
      profile,
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "u" },
        message: { type: "text" as const, text: "集合" }
      }
    };

    const ambiguous = await handler({ query: "集合" }, context);
    const notFound = await handler(
      { query: "完全不存在的詞" },
      {
        ...context,
        event: { ...context.event, message: { type: "text", text: "完全不存在的詞" } }
      }
    );
    const unavailable = await handler(
      { query: "再說一次" },
      {
        ...context,
        activeTask: knowledgeTask({ sourceId: "removed", documentId: "missing" }),
        event: { ...context.event, message: { type: "text", text: "再說一次" } }
      }
    );
    const missingExplicitAnchor = await handler(
      { query: "再說一次", sourceKey: "alpha", documentId: "missing" },
      {
        ...context,
        event: { ...context.event, message: { type: "text", text: "再說一次" } }
      }
    );

    expect(ambiguous.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: { choices: ["知識來源 1", "知識來源 2"] }
    });
    expect(notFound.agentResult).toMatchObject({ status: "not_found" });
    expect(unavailable.agentResult).toMatchObject({ status: "unavailable" });
    expect(missingExplicitAnchor.agentResult).toMatchObject({ status: "unavailable" });
    for (const result of [ambiguous, notFound, unavailable, missingExplicitAnchor]) {
      expect(JSON.stringify(result.agentResult)).not.toMatch(/https?:|集合資料/iu);
      expect(JSON.stringify(result.agentResult)).not.toMatch(/alpha 手冊|beta 手冊/u);
    }
  });

  it("retrieves a generic body-only query across only the capped eligible sources", async () => {
    const store = new InMemoryKnowledgeStore();
    const sources = [];
    for (const [sourceKey, content] of [
      ["alpha", "聚會結束後請關閉音控設備。"],
      ["beta", "兒童教室的玩具要分類收好。"]
    ] as const) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} 手冊`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} 文件`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [{ headingPath: [], ordinal: 0, content, contentHash: `${sourceKey}-hash` }]
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
      sources.push(source);
    }
    const search = vi.spyOn(store, "search");
    const searchTopPerSource = vi.spyOn(store, "searchTopPerSource");
    const result = await createQueryKnowledgeHandler({ store })(
      { query: "關閉音控設備" },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "關閉音控設備" }
        }
      }
    );

    expect(result.replyText).toContain("聚會結束後請關閉音控設備");
    expect(result.agentResult?.anchors).toEqual(
      expect.objectContaining({ sourceId: sources[0]!.id })
    );
    expect(searchTopPerSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: sources.map(({ id }) => id) })
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: sources[0]!.id, sourceIds: undefined })
    );
  });

  it("uses the requested ordinal while selecting a source for a body-only query", async () => {
    const store = new InMemoryKnowledgeStore();
    const sources = [];
    for (const [sourceKey, ordinal, content] of [
      ["alpha", 0, "集合地點是辦公室。"],
      ["beta", 1, "集合地點是禮堂。"]
    ] as const) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} 手冊`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} 文件`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [{ headingPath: [], ordinal, content, contentHash: `${sourceKey}-${ordinal}-hash` }]
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
      sources.push(source);
    }
    const searchTopPerSource = vi.spyOn(store, "searchTopPerSource");

    const result = await createQueryKnowledgeHandler({ store })(
      { query: "集合地點", ordinal: 1 },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "第二個集合地點" }
        }
      }
    );

    expect(result.replyText).toContain("禮堂");
    expect(result.replyText).not.toContain("辦公室");
    expect(result.agentResult).toMatchObject({ status: "success" });
    expect(searchTopPerSource).toHaveBeenCalledWith(
      expect.objectContaining({
        ordinal: 1,
        sourceIds: sources.map(({ id }) => id)
      })
    );
  });

  it("stores an opaque requester-scoped selection when top evidence ties across sources", async () => {
    const store = new InMemoryKnowledgeStore();
    const fixedNow = () => new Date("2026-07-13T00:00:00Z");
    const sessionStore = new InMemorySessionStore({ now: fixedNow });
    const sources = [];
    for (const sourceKey of ["alpha", "beta"]) {
      const source = await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `${sourceKey} 手冊`,
        adapterType: "notion",
        externalRootId: `${sourceKey}-root`,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await store.replaceDocument({
        sourceId: source.id,
        externalId: `${sourceKey}-doc`,
        title: `${sourceKey} 文件`,
        url: `https://example.test/${sourceKey}-doc`,
        nodes: [],
        chunks: [
          {
            headingPath: [],
            ordinal: 0,
            content: "集合時間是晚上七點。",
            contentHash: `${sourceKey}-hash`
          }
        ]
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
      sources.push(source);
    }
    const options = {
      store,
      sessionStore,
      requestIdFactory: () => "knowledge-choice",
      now: fixedNow
    };
    const handler = createQueryKnowledgeHandler(options);
    const searchTopPerSource = vi.spyOn(store, "searchTopPerSource");
    const result = await handler(
      { query: "集合時間", ordinal: 0 },
      {
        profile,
        event: {
          type: "message",
          source: { type: "group", groupId: "g", userId: "u" },
          message: { type: "text", text: "集合時間" }
        }
      }
    );

    expect(result.agentResult).toMatchObject({
      status: "ambiguous",
      clarification: { choices: ["知識來源 1", "知識來源 2"] }
    });
    expect(searchTopPerSource).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 0 }));
    expect(result.quickReplies).toEqual([
      expect.objectContaining({ action: expect.objectContaining({ type: "postback" }) }),
      expect.objectContaining({ action: expect.objectContaining({ type: "postback" }) })
    ]);
    await expect(sessionStore.get("knowledge-choice")).resolves.toMatchObject({
      type: "selection",
      action: "query_knowledge",
      profileName: "helper",
      requesterUserId: "u",
      source: { type: "group", groupId: "g", userId: "u" },
      arguments: { query: "集合時間" },
      items: sources.map(({ id }, index) => ({
        id,
        name: `${index === 0 ? "alpha" : "beta"} 手冊`,
        driveId: id
      }))
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/alpha|beta|手冊/iu);

    const selectedByPostback = await createQueryKnowledgePostbackHandler(options)(
      {
        action: "select_knowledge_source",
        params: { requestId: "knowledge-choice", index: "1" }
      },
      {
        profile,
        event: {
          type: "postback",
          source: { type: "group", groupId: "g", userId: "u" },
          postback: { data: "action=select_knowledge_source" }
        }
      }
    );
    expect(selectedByPostback.replyText).toContain("集合時間是晚上七點");
    expect(selectedByPostback.agentResult?.anchors).toEqual(
      expect.objectContaining({ sourceId: sources[1]!.id })
    );

    await handler(
      { query: "集合時間" },
      {
        profile,
        event: {
          type: "message",
          source: { type: "group", groupId: "g", userId: "u" },
          message: { type: "text", text: "集合時間" }
        }
      }
    );
    const numeric = createQueryKnowledgeTextMessageHandler(options);
    const numericContext = {
      profile,
      event: {
        type: "message" as const,
        source: { type: "group" as const, groupId: "g", userId: "u" },
        message: { type: "text" as const, text: "1" }
      }
    };
    await expect(numeric.matches({ text: "1" }, numericContext)).resolves.toBe(true);
    await expect(numeric.handle({ text: "1" }, numericContext)).resolves.toMatchObject({
      agentResult: { anchors: { sourceId: sources[0]!.id } }
    });
  });

  it("accepts an explicit safe section anchor and searches only that section", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "2026 青年出隊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    const document = await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "出隊行程",
      url: "https://example.test/doc",
      nodes: [],
      chunks: [
        { headingPath: ["第一天"], ordinal: 0, content: "集合時間是七點。", contentHash: "d1" },
        { headingPath: ["第二天"], ordinal: 1, content: "集合時間是八點。", contentHash: "d2" }
      ]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "retreat",
      syncStatus: "ready",
      lastSyncedAt: "2026-07-13T00:00:00Z"
    });
    const handler = createQueryKnowledgeHandler({ store });

    const result = await handler(
      {
        query: "集合時間",
        sourceKey: "retreat",
        sectionKey: document.chunks[1]!.sectionKey
      },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "第二天集合時間" }
        }
      }
    );

    expect(result.replyText).toContain("八點");
    expect(result.replyText).not.toContain("七點");
  });

  it("falls back from section to document to source without searching another source", async () => {
    const store = new InMemoryKnowledgeStore();
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "出隊",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true
    });
    const document = await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc-a",
      title: "文件 A",
      url: "https://example.test/a",
      nodes: [],
      chunks: [
        { headingPath: ["第一天"], ordinal: 0, content: "早餐七點。", contentHash: "a1" },
        { headingPath: ["第二天"], ordinal: 1, content: "集合八點。", contentHash: "a2" }
      ]
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc-b",
      title: "文件 B",
      url: "https://example.test/b",
      nodes: [],
      chunks: [{ headingPath: ["裝備"], ordinal: 0, content: "雨具放車上。", contentHash: "b1" }]
    });
    const other = await store.upsertSource({
      profileName: "helper",
      sourceKey: "other",
      displayName: "其他",
      adapterType: "notion",
      externalRootId: "other",
      rootUrl: "https://example.test/other",
      enabled: true
    });
    await store.replaceDocument({
      sourceId: other.id,
      externalId: "other-doc",
      title: "其他文件",
      url: "https://example.test/other-doc",
      nodes: [],
      chunks: [{ headingPath: [], ordinal: 0, content: "接送九點。", contentHash: "o1" }]
    });
    for (const sourceKey of ["retreat", "other"]) {
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z"
      });
    }
    const handler = createQueryKnowledgeHandler({ store });
    const context = {
      profile,
      activeTask: knowledgeTask({
        sourceId: source.id,
        documentId: document.id,
        sectionKey: document.chunks[0]!.sectionKey
      }),
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "u" },
        message: { type: "text" as const, text: "集合" }
      }
    };

    const documentFallback = await handler({ query: "集合" }, context);
    const sourceFallback = await handler(
      { query: "雨具" },
      { ...context, event: { ...context.event, message: { type: "text", text: "雨具" } } }
    );
    const noProfileFallback = await handler(
      { query: "接送" },
      { ...context, event: { ...context.event, message: { type: "text", text: "接送" } } }
    );

    expect(documentFallback.replyText).toContain("集合八點");
    expect(sourceFallback.replyText).toContain("雨具放車上");
    expect(noProfileFallback.agentResult).toMatchObject({ status: "not_found" });
  });

  it("resolves explicit source keys only from the capped eligible routing provider", async () => {
    const store = new InMemoryKnowledgeStore();
    for (let index = 0; index < 21; index += 1) {
      const sourceKey = `source-${String(index).padStart(2, "0")}`;
      await store.upsertSource({
        profileName: "helper",
        sourceKey,
        displayName: `來源 ${index}`,
        adapterType: "notion",
        externalRootId: sourceKey,
        rootUrl: `https://example.test/${sourceKey}`,
        enabled: true
      });
      await store.updateSource({
        profileName: "helper",
        sourceKey,
        syncStatus: "ready",
        lastSyncedAt: "2026-07-13T00:00:00Z",
        aliases: [`別名 ${index}`]
      });
    }
    const result = await createQueryKnowledgeHandler({ store })(
      { query: "查詢", sourceKey: "source-20" },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: "u" },
          message: { type: "text", text: "查詢" }
        }
      }
    );

    expect(result.agentResult).toMatchObject({ status: "unavailable" });
  });
});

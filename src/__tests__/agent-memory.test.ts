import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../agent/agent-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { PostgresAgentMemoryStore, type PgQueryable } from "../agent/postgres-memory-store.js";
import {
  createRetrieveMemoryHandler,
  createSaveMemoryHandler
} from "../functions/agent-memory-functions.js";
import type { BotProfileConfig, FunctionHandlerContext } from "../types.js";
import type { EmbeddingClient } from "../clients/ollama-embedding.js";
import type { TextGenerationProvider } from "../types.js";
import { backfillAgentTextMemoryEmbeddings } from "../agent/text-memory-embedding-backfill.js";

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["find_ppt_slides", "find_sheet_music", "save_memory", "retrieve_memory"]
  };
}

function context(): FunctionHandlerContext {
  return {
    profile: profile(),
    requestId: "req-1",
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    }
  };
}

describe("agent memory", () => {
  it("deduplicates resource metadata by stable storage identity and refreshes verification", async () => {
    let now = new Date("2026-07-16T12:00:00Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const first = await store.recordResource({
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "舊名稱.pptx",
      storage: { provider: "graph", driveId: "drive-1", itemId: "item-1" },
      sourceRevision: "rev-1"
    });
    now = new Date("2026-07-16T12:05:00Z");
    const refreshed = await store.recordResource({
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "新名稱.pptx",
      storage: { provider: "graph", driveId: "drive-1", itemId: "item-1" },
      sourceRevision: "rev-2"
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed).toMatchObject({
      title: "新名稱.pptx",
      sourceRevision: "rev-2",
      verifiedAt: "2026-07-16T12:05:00.000Z"
    });
    await expect(
      store.searchResources({
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1",
        resourceTypes: ["ppt_slide"]
      })
    ).resolves.toHaveLength(1);
  });
  it("can retrieve a visible memory by semantic similarity without a substring match", async () => {
    const store = new InMemoryAgentMemoryStore({ now: () => new Date("2026-07-16T12:00:00Z") });
    await store.saveTextMemory({
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      createdBy: "U1",
      content: "器材室鑰匙放在行政桌抽屜",
      embedding: [1, 0, 0]
    });

    await expect(
      store.searchTextMemories({
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1",
        query: "要去哪裡拿開門的東西",
        queryEmbedding: [0.98, 0.02, 0],
        limit: 5
      })
    ).resolves.toEqual([expect.objectContaining({ content: "器材室鑰匙放在行政桌抽屜" })]);
  });

  it("backfills missing text-memory embeddings in a bounded idempotent batch", async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.saveTextMemory({
      profileName: "helper",
      source: { type: "user", userId: "U1" },
      createdBy: "U1",
      title: "鑰匙",
      content: "放在行政桌"
    });
    const embedding: EmbeddingClient = {
      provider: "test",
      model: "test",
      dimensions: 3,
      embed: vi.fn().mockResolvedValue([[1, 0, 0]])
    };

    await expect(
      backfillAgentTextMemoryEmbeddings({ store, embedding, batchSize: 10 })
    ).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 });
    await expect(
      backfillAgentTextMemoryEmbeddings({ store, embedding, batchSize: 10 })
    ).resolves.toEqual({ scanned: 0, updated: 0, failed: 0 });
  });

  it("falls back to lexical memory search when embedding is unavailable", async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.saveTextMemory({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      content: "器材室鑰匙放在行政桌抽屜"
    });
    const embedding: EmbeddingClient = {
      provider: "test",
      model: "test",
      dimensions: 3,
      embed: vi.fn().mockRejectedValue(new Error("offline"))
    };
    const handler = createRetrieveMemoryHandler({ memoryStore: store, embedding });

    await expect(handler({ query: "器材室鑰匙" }, context())).resolves.toMatchObject({
      ok: true,
      replyText: "器材室鑰匙放在行政桌抽屜"
    });
  });

  it("sends only requester-visible memories to the grounded answer provider", async () => {
    const store = new InMemoryAgentMemoryStore();
    const source = { type: "group" as const, groupId: "C1", userId: "U1" };
    await store.saveTextMemory({
      profileName: "helper",
      source,
      createdBy: "U1",
      visibility: "group",
      title: "集合",
      content: "集合地點在一樓"
    });
    await store.saveTextMemory({
      profileName: "helper",
      source: { ...source, userId: "U2" },
      createdBy: "U2",
      visibility: "private",
      title: "私人",
      content: "不可洩漏的內容"
    });
    const completeText = vi.fn().mockResolvedValue("一樓");
    const textGenerator: TextGenerationProvider = { completeText };
    const handler = createRetrieveMemoryHandler({ memoryStore: store, textGenerator });

    await handler({ query: "集合" }, context());

    expect(completeText).toHaveBeenCalledOnce();
    expect(completeText.mock.calls[0]?.[0].text).toContain("集合地點在一樓");
    expect(completeText.mock.calls[0]?.[0].text).not.toContain("不可洩漏的內容");
  });
  it("previews group-shared memory with its 30-day retention before saving", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createSaveMemoryHandler({ memoryStore: store });

    const preview = await handler(
      { content: "集合時間是下午兩點半", visibility: "group" },
      context()
    );

    expect(preview.replyText).toContain("群組共用");
    expect(preview.replyText).toContain("30 天");
    await expect(store.summary()).resolves.toMatchObject({ textMemories: 0 });
  });

  it("makes confirmed group memory visible to another requester in the same group", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const save = createSaveMemoryHandler({ memoryStore: store, now: () => now });
    const retrieve = createRetrieveMemoryHandler({ memoryStore: store });

    await save({ content: "集合時間是下午兩點半", visibility: "group", confirm: true }, context());
    const otherContext = {
      ...context(),
      event: {
        ...context().event,
        source: { type: "group" as const, groupId: "C1", userId: "U2" }
      }
    };

    await expect(retrieve({ query: "集合時間" }, otherContext)).resolves.toMatchObject({
      replyText: expect.stringContaining("下午兩點半")
    });
  });

  it("keeps private group memory hidden from another requester", async () => {
    const store = new InMemoryAgentMemoryStore();
    const save = createSaveMemoryHandler({ memoryStore: store });
    const retrieve = createRetrieveMemoryHandler({ memoryStore: store });

    await save({ content: "我的私人提醒", confirm: true }, context());
    const otherContext = {
      ...context(),
      event: {
        ...context().event,
        source: { type: "group" as const, groupId: "C1", userId: "U2" }
      }
    };

    await expect(retrieve({ query: "私人提醒" }, otherContext)).resolves.toMatchObject({
      replyText: "我目前找不到符合的記憶。"
    });
  });

  it("does not allow group visibility from a direct chat", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createSaveMemoryHandler({ memoryStore: store });
    const directContext = {
      ...context(),
      event: {
        ...context().event,
        source: { type: "user" as const, userId: "U1" }
      }
    };

    const preview = await handler(
      { content: "集合時間是下午兩點半", visibility: "group" },
      directContext
    );

    expect(preview.replyText).toContain("僅你可查");
    expect(preview.replyText).not.toContain("群組共用");
  });

  it("returns opaque structured results when retrieving explicit text memories", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const saved = await store.saveTextMemory({
      profileName: "helper",
      source: context().event.source,
      createdBy: "U1",
      title: "牧者私人提醒",
      content: "請聯絡王小明處理主日服事"
    });
    const handler = createRetrieveMemoryHandler({ memoryStore: store });

    const result = await handler({ query: "主日服事" }, context());

    expect(result.replyText).toContain("王小明");
    expect(result.agentResult).toEqual({
      status: "success",
      replyText: "記憶查詢完成。",
      entities: [{ type: "memory", key: saved.id, label: "已保存資訊" }],
      evidence: [{ kind: "saved_memory", reference: { memoryId: saved.id } }],
      supportedOperations: ["continue", "refine", "view_full"]
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/牧者|王小明|主日服事/u);
  });

  it("retrieves an active-task memory by opaque id without fuzzy re-search", async () => {
    const store = new InMemoryAgentMemoryStore();
    const source = context().event.source;
    await store.saveTextMemory({
      profileName: "helper",
      source,
      createdBy: "U1",
      content: "另一筆同來源資訊"
    });
    const target = await store.saveTextMemory({
      profileName: "helper",
      source,
      createdBy: "U1",
      content: "集合時間是下午兩點半"
    });
    const handler = createRetrieveMemoryHandler({ memoryStore: store });

    const result = await handler({ memoryId: target.id, query: "內容" }, context());

    expect(result.replyText).toContain("集合時間是下午兩點半");
    expect(result.replyText).not.toContain("另一筆同來源資訊");
    expect(result.agentResult).toMatchObject({
      status: "success",
      evidence: [{ kind: "saved_memory", reference: { memoryId: target.id } }]
    });
  });

  it("returns a structured not-found result when no explicit memory matches", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createRetrieveMemoryHandler({ memoryStore: store });

    await expect(handler({ query: "不存在" }, context())).resolves.toMatchObject({
      agentResult: { status: "not_found", replyText: "我目前找不到符合的記憶。" }
    });
  });

  it("keeps resource aliases requester-scoped in groups", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const resource = await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "奇異恩典青年版.pptx",
      query: "奇異恩典",
      storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-2" },
      expiresAt: "2026-08-07T00:00:00.000Z"
    });
    await store.rememberAlias({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      alias: "奇異恩典",
      resourceId: resource.id
    });

    await expect(
      store.findResourceByAlias({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U2" },
        alias: "奇異恩典",
        resourceTypes: ["ppt_slide"]
      })
    ).resolves.toBeUndefined();
  });

  it("does not expose a legacy alias as a pre-handler execution path", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const resource = await store.recordResource({
      profileName: "helper",
      source: context().event.source,
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "私人投影片.pptx",
      query: "私人查詢",
      storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-2" },
      expiresAt: "2026-08-07T00:00:00.000Z"
    });
    await store.rememberAlias({
      profileName: "helper",
      source: context().event.source,
      createdBy: "U1",
      alias: "剛剛那份",
      resourceId: resource.id
    });
    const runtime = createAgentRuntime({
      memoryStore: store,
      graph: {
        listFolderChildren: vi.fn(),
        createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/temporary")
      },
      now: () => now
    });

    expect(runtime).not.toHaveProperty("handleBeforeFunctionExecution");
  });

  it("keeps group resources private by default and shares only when explicit", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "青年聚會投影片",
      query: "青年聚會",
      storage: {
        provider: "external_link",
        url: "https://example.com/youth-slides",
        sourceLabel: "Ray provided",
        description: "外部補充投影片"
      },
      expiresAt: "2026-08-07T00:00:00.000Z"
    });

    await expect(
      store.searchResources({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U2" },
        requesterUserId: "U2",
        query: "青年",
        resourceTypes: ["ppt_slide"],
        limit: 5
      })
    ).resolves.toEqual([]);

    await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      visibility: "group",
      resourceType: "ppt_slide",
      title: "青年聚會共用投影片",
      query: "青年聚會",
      storage: { provider: "external_link", url: "https://example.com/youth-shared" },
      expiresAt: "2026-08-07T00:00:00.000Z"
    });

    await expect(
      store.searchResources({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U2" },
        requesterUserId: "U2",
        query: "共用",
        resourceTypes: ["ppt_slide"],
        limit: 5
      })
    ).resolves.toMatchObject([
      {
        title: "青年聚會共用投影片",
        storage: {
          provider: "external_link",
          url: "https://example.com/youth-shared"
        }
      }
    ]);
  });

  it("allows only an owner or an admin to delete a group memory and physically purges it", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const memory = await store.saveTextMemory({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      content: "私人提醒"
    });

    await expect(
      store.forgetMemory({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U2" },
        id: memory.id,
        deletedBy: "U2"
      })
    ).resolves.toBe(false);
    await expect(
      store.forgetMemory({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "Uadmin" },
        id: memory.id,
        deletedBy: "Uadmin",
        isAdmin: true
      })
    ).resolves.toBe(true);
    await expect(store.purgeExpired()).resolves.toMatchObject({ textMemories: 1 });
    await expect(
      store.listTextMemories({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toEqual([]);
  });

  it("lists text memories and keeps memory status admin-only", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const runtime = createAgentRuntime({ memoryStore: store, now: () => now });

    await store.saveTextMemory({
      profileName: "helper",
      source: context().event.source,
      createdBy: "U1",
      content: "主日導播是知樂"
    });

    await expect(
      runtime.handleCommand({ text: "/memories", context: context(), isAdmin: false })
    ).resolves.toMatchObject({
      replyText: expect.stringContaining("主日導播是知樂")
    });
    await expect(
      runtime.handleCommand({ text: "/memory-status", context: context(), isAdmin: false })
    ).resolves.toMatchObject({
      replyText: "這個指令需要管理員權限。"
    });
    await expect(
      runtime.handleCommand({ text: "/memory-status", context: context(), isAdmin: true })
    ).resolves.toMatchObject({
      replyText: expect.stringContaining("textMemories: 1")
    });
  });

  it("lists and forgets external resource memories through memory commands", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const runtime = createAgentRuntime({ memoryStore: store, now: () => now });
    const resource = await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "青年聚會投影片",
      query: "青年聚會",
      storage: { provider: "external_link", url: "https://example.com/youth" },
      expiresAt: "2026-08-08T00:00:00.000Z"
    });

    await expect(
      runtime.handleCommand({ text: "/memories", context: context(), isAdmin: false })
    ).resolves.toMatchObject({
      replyText: expect.stringContaining("青年聚會投影片")
    });
    await expect(
      runtime.handleCommand({ text: "/memory-status", context: context(), isAdmin: true })
    ).resolves.toMatchObject({
      replyText: expect.stringContaining("externalResources: 1")
    });
    await expect(
      runtime.handleCommand({
        text: `/forget-memory ${resource.id}`,
        context: context(),
        isAdmin: false
      })
    ).resolves.toMatchObject({
      replyText: "已移除這段記憶。"
    });
  });

  it("maps external link resources from the Postgres memory store", async () => {
    const db: PgQueryable = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            profile_name: "helper",
            scope_type: "group",
            scope_id: "C1",
            resource_type: "ppt_slide",
            title: "青年聚會投影片",
            query_text: "青年聚會",
            storage_provider: "external_link",
            external_url: "https://example.com/youth",
            source_label: "Ray",
            description: "外部資源",
            created_by: "U1",
            created_at: "2026-07-08T00:00:00.000Z",
            expires_at: "2026-08-08T00:00:00.000Z",
            deleted_at: null
          }
        ]
      })
    };
    const store = new PostgresAgentMemoryStore(db);

    await expect(
      store.searchResources({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        query: "青年",
        resourceTypes: ["ppt_slide"],
        limit: 5
      })
    ).resolves.toMatchObject([
      {
        title: "青年聚會投影片",
        storage: {
          provider: "external_link",
          url: "https://example.com/youth",
          sourceLabel: "Ray",
          description: "外部資源"
        }
      }
    ]);
  });

  it("filters Postgres memory authority before hybrid ranking", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresAgentMemoryStore({ query });

    await store.searchTextMemories({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      requesterUserId: "U1",
      query: "鑰匙在哪裡",
      queryEmbedding: [1, 0, 0],
      limit: 3
    });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("with authorized_memories as materialized");
    expect(sql).toContain("profile_name = $1");
    expect(sql).toContain("visibility = 'group' or created_by");
    expect(sql).toContain("embedding <=>");
    expect(values).toEqual(["helper", "group", "C1", "U1", "鑰匙在哪裡", "[1,0,0]", 3]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../agent/agent-runtime.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { PostgresAgentMemoryStore, type PgQueryable } from "../agent/postgres-memory-store.js";
import { createRetrieveMemoryHandler } from "../functions/agent-memory-functions.js";
import type { BotProfileConfig, FunctionHandlerContext, GraphDriveClient } from "../types.js";

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
    enabledFunctions: ["find_ppt_slides", "find_pop_sheet_music", "save_memory", "retrieve_memory"]
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
      supportedOperations: []
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/牧者|王小明|主日服事/u);
  });

  it("returns a structured not-found result when no explicit memory matches", async () => {
    const store = new InMemoryAgentMemoryStore();
    const handler = createRetrieveMemoryHandler({ memoryStore: store });

    await expect(handler({ query: "不存在" }, context())).resolves.toMatchObject({
      agentResult: { status: "not_found", replyText: "我目前找不到符合的記憶。" }
    });
  });

  it("stores recent resources by source and requester and ignores expired records", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "奇異恩典.pptx",
      query: "奇異恩典",
      storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-1" },
      expiresAt: "2026-07-07T00:00:00.000Z"
    });
    await store.recordResource({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "恩典之路.pptx",
      query: "恩典之路",
      storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-2" },
      expiresAt: "2026-08-07T00:00:00.000Z"
    });

    await expect(
      store.findRecentResource({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1",
        resourceTypes: ["ppt_slide"]
      })
    ).resolves.toMatchObject({ title: "恩典之路.pptx" });
    await expect(
      store.findRecentResource({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U2" },
        requesterUserId: "U2",
        resourceTypes: ["ppt_slide"]
      })
    ).resolves.toBeUndefined();
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

  it("recalls the latest resource through the agent runtime without routing again", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/recalled")
    };
    const runtime = createAgentRuntime({ memoryStore: store, graph, now: () => now });

    await runtime.afterFunctionResult({
      context: context(),
      action: "find_ppt_slides",
      arguments: { query: "奇異恩典" },
      result: {
        ok: true,
        replyText: "done",
        agentResource: {
          resourceType: "ppt_slide",
          title: "奇異恩典.pptx",
          storage: { provider: "graph", driveId: "drive-id", itemId: "ppt-1" }
        }
      }
    });
    const result = await runtime.handleTextBeforeRouting({
      text: "小哈 再給我一次",
      context: context()
    });

    expect(result?.replyText).toContain("奇異恩典.pptx");
    expect(result?.replyText).toContain("https://download.invalid/recalled");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "ppt-1",
      "2026-07-09T00:00:00.000Z"
    );
  });

  it("does not save external link resources before the controlled function gate", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const runtime = createAgentRuntime({ memoryStore: store, now: () => now });

    const saved = await runtime.handleTextBeforeRouting({
      text: "小哈幫我記住這份投影片 https://example.com/youth 名稱是青年聚會投影片",
      context: context()
    });

    expect(saved).toBeUndefined();
    await expect(store.summary()).resolves.toMatchObject({ resources: 0 });
  });

  it("does not handle incomplete external link saves before routing", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const runtime = createAgentRuntime({ memoryStore: store, now: () => now });

    const result = await runtime.handleTextBeforeRouting({
      text: "小哈幫我記住 https://example.com/resource 名稱是青年聚會",
      context: context()
    });

    expect(result).toBeUndefined();
    await expect(store.summary()).resolves.toMatchObject({ resources: 0 });
  });

  it("does not save or retrieve text memory before the controlled function gate", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const store = new InMemoryAgentMemoryStore({ now: () => now });
    const runtime = createAgentRuntime({ memoryStore: store, now: () => now });

    const saved = await runtime.handleTextBeforeRouting({
      text: "小哈幫我記住這個月服事表：主日導播是知樂",
      context: context()
    });
    const retrieved = await runtime.handleTextBeforeRouting({
      text: "小哈查我記住的服事表",
      context: context()
    });

    expect(saved).toBeUndefined();
    expect(retrieved).toBeUndefined();
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
    await expect(
      runtime.handleTextBeforeRouting({ text: "小哈 再給我一次", context: context() })
    ).resolves.toBeUndefined();
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
});

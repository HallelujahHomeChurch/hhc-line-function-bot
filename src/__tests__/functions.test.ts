import { describe, expect, it, vi } from "vitest";

import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler,
  createFindPptSlidesTextMessageHandler
} from "../functions/find-ppt-slides.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { createQueryServiceScheduleHandler } from "../functions/query-service-schedule.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  GraphDriveClient,
  NotionDatabaseClient,
  PostbackContext
} from "../types.js";

function profile(): BotProfileConfig {
  return {
    name: "main",
    webhookPath: "/api/line/webhook/main",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["find_ppt_slides", "query_schedule"]
  };
}

function handlerContext(): FunctionHandlerContext {
  return {
    profile: profile(),
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇易恩點" }
    }
  };
}

function personalizedHandlerContext(): FunctionHandlerContext {
  return {
    ...handlerContext(),
    requesterDisplayName: "Ray"
  };
}

describe("find_ppt_slides", () => {
  it("uses catalog results before crawling the presentation folder", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "main",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: { driveId: "drive-id", folderItemId: "folder-id" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["main"], write: [] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "奇異恩典.pptx",
      storageRef: { provider: "graph", driveId: "catalog-drive", itemId: "catalog-ppt-1" }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([{ id: "legacy", name: "奇異恩典.pptx" }]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/catalog-ppt")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      catalog,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx"],
      defaultIncludePdf: false,
      now: () => now
    });

    const result = await handler({ query: "奇異恩典" }, handlerContext());

    expect(result.replyText).toContain("https://download.invalid/catalog-ppt");
    expect(graph.listFolderChildren).not.toHaveBeenCalled();
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "catalog-drive",
      "catalog-ppt-1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("softly personalizes missing PPT title clarification", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph: { listFolderChildren: vi.fn(), createSharingLink: vi.fn() },
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx"],
      defaultIncludePdf: false,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    const result = await handler({ query: "" }, personalizedHandlerContext());

    expect(result.replyText).toBe("Ray，要查哪一份投影片？請直接回覆名稱。");
  });

  it("does not create a pending PPT clarification session without a group requester user id", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPptSlidesHandler({
      graph: { listFolderChildren: vi.fn(), createSharingLink: vi.fn() },
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx"],
      defaultIncludePdf: false,
      sessionStore,
      now: () => now,
      requestIdFactory: () => "pending-1"
    });
    const context: FunctionHandlerContext = {
      ...handlerContext(),
      event: {
        ...handlerContext().event,
        source: { type: "group", groupId: "Cgroup" }
      }
    };

    const result = await handler({ query: "" }, context);

    expect(result.replyText).toBe("要查哪一份投影片？請直接回覆名稱。");
    await expect(sessionStore.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("does not create a PPT selection session without a group requester user id", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "ppt-1", name: "奇異恩典.pptx" },
        { id: "ppt-2", name: "奇異恩典新版.pptx" }
      ]),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx"],
      defaultIncludePdf: false,
      sessionStore,
      now: () => now,
      requestIdFactory: () => "selection-1"
    });
    const context: FunctionHandlerContext = {
      ...handlerContext(),
      event: {
        ...handlerContext().event,
        source: { type: "group", groupId: "Cgroup" }
      }
    };

    const result = await handler({ query: "奇異恩典" }, context);

    expect(result.replyText).toBe("找到多個相近的詩歌投影片，請提供更完整歌名。");
    expect(result.quickReplies).toBeUndefined();
    await expect(sessionStore.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("fuzzy matches Chinese typo queries before creating a 24 hour link", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "1", name: "奇異恩典.pptx", webUrl: "https://example.invalid/1" },
        { id: "2", name: "主日報告.pptx", webUrl: "https://example.invalid/2" }
      ]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/amazing-grace")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    const result = await handler({ query: "奇易恩點" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "已找到詩歌投影片：",
        "奇異恩典.pptx",
        "下載連結（1 天內有效）：",
        "https://download.invalid/amazing-grace"
      ].join("\n")
    );
    expect(result.agentResource).toMatchObject({
      resourceType: "ppt_slide",
      title: "奇異恩典.pptx",
      storage: { provider: "graph", driveId: "drive-id", itemId: "1" }
    });
    expect(result.agentResult).toEqual({
      status: "success",
      replyText: "投影片查詢完成。",
      entities: [{ type: "resource", key: "1", label: "投影片資源" }],
      evidence: [
        {
          kind: "catalog_item",
          reference: { resourceId: "1", driveId: "drive-id", itemId: "1" }
        }
      ],
      supportedOperations: ["continue", "refine", "view_full"]
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/奇異恩典|download\.invalid/iu);
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("returns an external remembered slide before searching Graph", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    await memoryStore.recordResource({
      profileName: "main",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "青年聚會投影片",
      query: "青年聚會",
      storage: { provider: "external_link", url: "https://example.com/youth-slides" },
      expiresAt: "2026-08-04T10:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([]),
      createSharingLink: vi.fn()
    };
    const handler = createFindPptSlidesHandler({
      graph,
      memoryStore,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      now: () => now
    });

    const result = await handler({ query: "青年聚會" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("已找到我記住的");
    expect(result.replyText).toContain("青年聚會投影片");
    expect(result.replyText).toContain("https://example.com/youth-slides");
    expect(graph.listFolderChildren).not.toHaveBeenCalled();
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("merges remembered and Graph slide candidates into one selection flow", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    const remembered = await memoryStore.recordResource({
      profileName: "main",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      createdBy: "U1",
      resourceType: "ppt_slide",
      title: "青年聚會投影片",
      query: "青年聚會",
      storage: { provider: "external_link", url: "https://example.com/youth-slides" },
      expiresAt: "2026-08-04T10:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([{ id: "ppt-1", name: "青年主日.pptx" }]),
      createSharingLink: vi.fn()
    };
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPptSlidesHandler({
      graph,
      memoryStore,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      sessionStore,
      now: () => now,
      requestIdFactory: () => "mixed-ppt"
    });

    const result = await handler({ query: "青年" }, handlerContext());

    expect(result.replyText).toContain("青年聚會投影片");
    expect(result.replyText).toContain("青年主日.pptx");
    await expect(sessionStore.get("mixed-ppt")).resolves.toMatchObject({
      type: "ppt_selection",
      items: [
        {
          id: remembered.id,
          name: "青年聚會投影片",
          memoryResource: { storage: { provider: "external_link" } }
        },
        { id: "ppt-1", name: "青年主日.pptx" }
      ]
    });

    const handlePostback = createFindPptSlidesPostbackHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const selected = await handlePostback(
      { action: "select_ppt", params: { requestId: "mixed-ppt", index: "0" } },
      {
        profile: profile(),
        event: {
          type: "postback",
          replyToken: "reply-token",
          source: { type: "group", groupId: "Cgroup", userId: "U1" },
          postback: { data: "action=select_ppt&requestId=mixed-ppt&index=0" }
        }
      }
    );

    expect(selected.replyText).toContain("https://example.com/youth-slides");
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("uses file type metadata to search PDF slide exports", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "1", name: "主日報告.pptx", webUrl: "https://example.invalid/1" },
        { id: "2", name: "主日報告.pdf", webUrl: "https://example.invalid/2" }
      ]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/report-pdf")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    const result = await handler(
      {
        query: "主日報告",
        originalQuery: "小哈 查投影片 主日報告 pdf",
        fileType: "pdf",
        matchMode: "exact"
      },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("主日報告.pdf");
    expect(result.replyText).not.toContain("主日報告.pptx");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "2",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("lets file type metadata override the default PDF setting", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "1", name: "主日報告.pptx", webUrl: "https://example.invalid/1" },
        { id: "2", name: "主日報告.pdf", webUrl: "https://example.invalid/2" }
      ]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/report-ppt")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: true,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    const result = await handler({ query: "主日報告", fileType: "ppt" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("主日報告.pptx");
    expect(result.replyText).not.toContain("主日報告.pdf");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("offers recovery quick replies when no PPT candidates match", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi
        .fn()
        .mockResolvedValue([
          { id: "1", name: "主日報告.pptx", webUrl: "https://example.invalid/1" }
        ]),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    const result = await handler({ query: "不存在的歌名" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("找不到符合的詩歌投影片，請再提供更完整歌名。");
    expect(result.quickReplies).toEqual([
      {
        label: "重新查投影片",
        action: { type: "message", label: "重新查投影片", text: "小哈 查投影片" }
      }
    ]);
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("stores multiple PPT candidates and returns postback quick replies without creating links", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        { id: "1", name: "奇異恩典.pptx", webUrl: "https://example.invalid/1" },
        { id: "2", name: "奇異恩典_青年.pptx", webUrl: "https://example.invalid/2" },
        { id: "3", name: "Amazing Grace.pptx", webUrl: "https://example.invalid/3" }
      ]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/unused")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      sessionStore,
      now: () => now,
      requestIdFactory: () => "req-1"
    });

    const result = await handler({ query: "奇異恩典" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "找到多個相近的詩歌投影片，請回覆編號：",
        "1. 奇異恩典.pptx",
        "2. 奇異恩典_青年.pptx",
        "3. Amazing Grace.pptx"
      ].join("\n")
    );
    expect(result.quickReplies).toEqual([
      {
        label: "1",
        action: {
          type: "postback",
          label: "1",
          data: "action=select_ppt&requestId=req-1&index=0",
          displayText: "1"
        }
      },
      {
        label: "2",
        action: {
          type: "postback",
          label: "2",
          data: "action=select_ppt&requestId=req-1&index=1",
          displayText: "2"
        }
      },
      {
        label: "3",
        action: {
          type: "postback",
          label: "3",
          data: "action=select_ppt&requestId=req-1&index=2",
          displayText: "3"
        }
      }
    ]);
    expect(graph.createSharingLink).not.toHaveBeenCalled();
    await expect(sessionStore.get("req-1")).resolves.toMatchObject({
      type: "ppt_selection",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cgroup" },
      items: [
        { id: "1", name: "奇異恩典.pptx" },
        { id: "2", name: "奇異恩典_青年.pptx" },
        { id: "3", name: "Amazing Grace.pptx" }
      ]
    });
  });

  it("creates a sharing link only after a valid PPT selection postback", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/selected")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    await sessionStore.set({
      id: "req-1",
      type: "ppt_selection",
      profileName: "main",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cgroup" },
      driveId: "drive-id",
      items: [
        { id: "1", name: "奇異恩典.pptx" },
        { id: "2", name: "奇異恩典_青年.pptx" }
      ],
      expiresAt: new Date("2026-07-04T10:10:00.000Z").toISOString()
    });
    const handlePostback = createFindPptSlidesPostbackHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const context: PostbackContext = {
      profile: profile(),
      event: {
        type: "postback",
        replyToken: "reply-token",
        source: { type: "group", groupId: "Cgroup", userId: "U1" },
        postback: { data: "action=select_ppt&requestId=req-1&index=1" }
      }
    };

    const result = await handlePostback(
      { action: "select_ppt", params: { requestId: "req-1", index: "1" } },
      context
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("奇異恩典_青年.pptx");
    expect(result.replyText).toContain("https://download.invalid/selected");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "2",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("does not honor PPT postback selections when the function is not enabled", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handlePostback = createFindPptSlidesPostbackHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const disabledProfile: BotProfileConfig = {
      ...profile(),
      enabledFunctions: ["query_schedule"]
    };

    const result = await handlePostback(
      { action: "select_ppt", params: { requestId: "req-1", index: "0" } },
      {
        profile: disabledProfile,
        event: {
          type: "postback",
          replyToken: "reply-token",
          source: { type: "group", groupId: "Cgroup", userId: "U1" },
          postback: { data: "action=select_ppt&requestId=req-1&index=0" }
        }
      }
    );

    expect(result.replyText).toBe("這個功能目前沒有開放。");
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("creates a sharing link when the user replies with a numeric PPT selection", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/numeric")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    await sessionStore.set({
      id: "req-1",
      type: "ppt_selection",
      profileName: "main",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cgroup" },
      driveId: "drive-id",
      items: [
        { id: "1", name: "奇異恩典.pptx" },
        { id: "2", name: "奇異恩典_青年.pptx" }
      ],
      expiresAt: new Date("2026-07-04T10:10:00.000Z").toISOString()
    });
    const handleTextMessage = createFindPptSlidesTextMessageHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const context: PostbackContext = {
      profile: profile(),
      event: {
        type: "message",
        replyToken: "reply-token",
        source: { type: "group", groupId: "Cgroup", userId: "U1" },
        message: { type: "text", text: "2" }
      }
    };

    await expect(handleTextMessage.matches({ text: "2" }, context)).resolves.toBe(true);
    const result = await handleTextMessage.handle({ text: "2" }, context);

    expect(result).toMatchObject({ ok: true });
    expect(result?.replyText).toBe(
      [
        "已找到詩歌投影片：",
        "奇異恩典_青年.pptx",
        "下載連結（1 天內有效）：",
        "https://download.invalid/numeric"
      ].join("\n")
    );
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "2",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("does not handle numeric text when there is no active PPT selection", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handleTextMessage = createFindPptSlidesTextMessageHandler({
      graph,
      sessionStore: new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 }),
      now: () => now
    });

    await expect(handleTextMessage.matches({ text: "1" }, handlerContext())).resolves.toBe(false);
    const result = await handleTextMessage.handle({ text: "1" }, handlerContext());

    expect(result).toBeUndefined();
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });
});

describe("query_schedule", () => {
  it("softly personalizes generic service schedule clarification", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createQueryServiceScheduleHandler({
      notion: { queryDatabase: vi.fn() },
      databaseId: "database-id",
      properties: {
        date: "date",
        meeting: "meeting",
        role: "role",
        person: "person"
      },
      sessionStore: new InMemorySessionStore({ now: () => now }),
      now: () => now
    });

    const result = await handler({ query: "服事表" }, personalizedHandlerContext());

    expect(result.replyText).toContain(
      "Ray，要查哪個服事表範圍？請選擇或直接回覆：下一場、本週、明天、主日。"
    );
  });

  it("maps Notion properties from env-style configuration", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "司會" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      }
    });

    const result = await handler({ query: "主日司會" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("司會：Ray");
  });

  it("maps Notion page properties by configured property id metadata", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            DateName: { id: "date-id", type: "date", date: { start: "2026-07-05" } },
            MeetingName: { id: "meeting-id", type: "select", select: { name: "Sunday" } },
            RoleName: { id: "role-id", type: "title", title: [{ plain_text: "Audio" }] },
            PersonName: { id: "person-id", type: "people", people: [{ name: "Ray" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "date-id",
        meeting: "meeting-id",
        role: "role-id",
        person: "person-id"
      }
    });

    const result = await handler(
      { query: "service schedule", dateIntent: "specific_date", specificDate: "2026-07-05" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("Sunday");
    expect(result.replyText).toContain("Audio");
    expect(result.replyText).toContain("Ray");
  });

  it("filters this-week service schedule requests", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-1",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "司會" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        },
        {
          id: "page-2",
          properties: {
            Date: { type: "date", date: { start: "2026-07-12" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "招待" }] },
            Person: { type: "people", people: [{ name: "Ann" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T12:00:00.000Z")
    });

    const result = await handler({ query: "本週服事" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月5日");
    expect(result.replyText).not.toContain("7月12日");
  });

  it("defaults generic service schedule requests to upcoming rows", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-old",
          properties: {
            Date: { type: "date", date: { start: "2026-01-04" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "司會" }] },
            Person: { type: "people", people: [{ name: "Old" }] }
          }
        },
        {
          id: "page-upcoming",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "司會" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T12:00:00.000Z")
    });

    const result = await handler({ query: "主日服事" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月5日");
    expect(result.replyText).toContain("Ray");
    expect(result.replyText).not.toContain("1月4日");
    expect(notion.queryDatabase).toHaveBeenCalledWith(
      "notion-db",
      expect.objectContaining({
        filter: expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({ date: { on_or_after: "2026-07-04" } }),
            expect.objectContaining({ date: { before: "2026-07-11" } })
          ])
        })
      })
    );
  });

  it("limits next meeting service schedule requests to the first upcoming meeting", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-next-1",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "7月5日 主日" } },
            Role: { type: "title", title: [] },
            Person: {
              type: "rich_text",
              rich_text: [{ plain_text: "導播: 知樂\n投影電腦: 育圻" }]
            }
          }
        },
        {
          id: "page-next-2",
          properties: {
            Date: { type: "date", date: { start: "2026-07-07" } },
            Meeting: { type: "select", select: { name: "7月7日(二) 晨更" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "資恆" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-05T02:00:00.000Z")
    });

    const result = await handler({ query: "下一場聚會服事表" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "下一場聚會服事表",
        "7月5日",
        "",
        "【7月5日 主日】",
        "服事同工：",
        "- 導播：知樂",
        "- 投影電腦：育圻"
      ].join("\n")
    );
    expect(result.replyText).not.toContain("7月7日");
    expect(result.replyText).not.toContain("資恆");
  });

  it("skips an inferred ended same-day meeting when selecting the next meeting", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-ended-today",
          properties: {
            Date: { type: "date", date: { start: "2026-07-09" } },
            Meeting: { type: "select", select: { name: "7月9日(四) 福音餐會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "Today" }] }
          }
        },
        {
          id: "page-next",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "Tomorrow" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-09T13:05:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事表", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月10日(五) 門訓禱告會");
    expect(result.replyText).toContain("Tomorrow");
    expect(result.replyText).not.toContain("Today");
  });

  it("skips the Thursday gospel meal after its Taipei end time", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-ended-gospel-meal",
          properties: {
            Date: { type: "date", date: { start: "2026-07-09" } },
            Meeting: { type: "select", select: { name: "7月9日(四) 福音餐會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "GospelMeal" }] }
          }
        },
        {
          id: "page-next-training-prayer",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "TrainingPrayer" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-09T06:05:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事表", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月10日(五) 門訓禱告會");
    expect(result.replyText).toContain("TrainingPrayer");
    expect(result.replyText).not.toContain("GospelMeal");
  });

  it("selects the earliest upcoming same-day meeting regardless of Notion row order", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-friday-evening",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "Evening" }] }
          }
        },
        {
          id: "page-friday-morning",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 晨更" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "Morning" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-09T06:05:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月10日(五) 晨更");
    expect(result.replyText).toContain("Morning");
    expect(result.replyText).not.toContain("Evening");
  });

  it("keeps the Thursday gospel meal as next meeting before its Taipei end time", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-current-gospel-meal",
          properties: {
            Date: { type: "date", date: { start: "2026-07-09" } },
            Meeting: { type: "select", select: { name: "7月9日(四) 福音餐會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "GospelMeal" }] }
          }
        },
        {
          id: "page-next-training-prayer",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "TrainingPrayer" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-09T05:59:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事表", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月9日(四) 福音餐會");
    expect(result.replyText).toContain("GospelMeal");
    expect(result.replyText).not.toContain("TrainingPrayer");
  });

  it("skips Sunday after noon when selecting the next meeting", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-ended-sunday",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "7月5日 主日" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "Sunday" }] }
          }
        },
        {
          id: "page-next-morning",
          properties: {
            Date: { type: "date", date: { start: "2026-07-07" } },
            Meeting: { type: "select", select: { name: "7月7日(二) 晨更" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "MorningPrayer" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-05T04:01:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事表", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月7日(二) 晨更");
    expect(result.replyText).toContain("MorningPrayer");
    expect(result.replyText).not.toContain("Sunday");
  });

  it("uses explicit Notion datetime instead of inferred meeting windows", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-explicit-current",
          properties: {
            Date: {
              type: "date",
              date: {
                start: "2026-07-09T18:30:00.000+08:00",
                end: "2026-07-09T21:00:00.000+08:00"
              }
            },
            Meeting: { type: "select", select: { name: "7月9日(四) 福音餐會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "ExplicitEvening" }] }
          }
        },
        {
          id: "page-next-day",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "7月10日(五) 門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "NextDay" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-09T12:30:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    const result = await handler(
      { query: "下一場聚會服事表", dateIntent: "next_meeting" },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月9日(四) 福音餐會");
    expect(result.replyText).toContain("ExplicitEvening");
    expect(result.replyText).not.toContain("NextDay");
  });

  it("uses structured next-meeting metadata even when the query text is generic", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-next-1",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "7月5日 主日" } },
            Role: { type: "title", title: [] },
            Person: {
              type: "rich_text",
              rich_text: [{ plain_text: "導播: 知樂\n投影電腦: 育圻" }]
            }
          }
        },
        {
          id: "page-next-2",
          properties: {
            Date: { type: "date", date: { start: "2026-07-07" } },
            Meeting: { type: "select", select: { name: "7月7日(二) 晨更" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "資恆" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-05T02:00:00.000Z")
    });

    const result = await handler(
      { query: "服事表", dateIntent: "next_meeting", limit: 1 },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "下一場聚會服事表",
        "7月5日",
        "",
        "【7月5日 主日】",
        "服事同工：",
        "- 導播：知樂",
        "- 投影電腦：育圻"
      ].join("\n")
    );
    expect(result.replyText).not.toContain("7月7日");
    expect(result.replyText).not.toContain("資恆");
  });

  it("uses structured date, meeting, and role metadata as filters", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-target",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "晨更" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "家睿" }] }
          }
        },
        {
          id: "page-wrong-role",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "晨更" } },
            Role: { type: "title", title: [{ plain_text: "投影電腦" }] },
            Person: { type: "people", people: [{ name: "Peggy" }] }
          }
        },
        {
          id: "page-wrong-meeting",
          properties: {
            Date: { type: "date", date: { start: "2026-07-10" } },
            Meeting: { type: "select", select: { name: "門訓禱告會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "資恆" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T12:00:00.000Z")
    });

    const result = await handler(
      {
        query: "服事表",
        dateIntent: "specific_date",
        specificDate: "2026-07-10",
        meeting: "晨更",
        role: "音控"
      },
      handlerContext()
    );

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("音控：家睿");
    expect(result.replyText).not.toContain("Peggy");
    expect(result.replyText).not.toContain("資恆");
    expect(notion.queryDatabase).toHaveBeenCalledWith(
      "notion-db",
      expect.objectContaining({
        filter: expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({ date: { on_or_after: "2026-07-10" } }),
            expect.objectContaining({ date: { before: "2026-07-11" } })
          ])
        })
      })
    );
  });

  it("filters tomorrow service schedule requests to the next calendar day", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-today",
          properties: {
            Date: { type: "date", date: { start: "2026-07-04" } },
            Meeting: { type: "select", select: { name: "國度禱告會" } },
            Role: { type: "title", title: [{ plain_text: "音控" }] },
            Person: { type: "people", people: [{ name: "Today" }] }
          }
        },
        {
          id: "page-tomorrow",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "主日聚會" } },
            Role: { type: "title", title: [{ plain_text: "導播" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        },
        {
          id: "page-next-week",
          properties: {
            Date: { type: "date", date: { start: "2026-07-07" } },
            Meeting: { type: "select", select: { name: "晨更" } },
            Role: { type: "title", title: [{ plain_text: "投影" }] },
            Person: { type: "people", people: [{ name: "Later" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T12:00:00.000Z")
    });

    const result = await handler({ query: "明天聚會服事人員" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      ["明天聚會服事表", "7月5日", "", "【主日聚會】", "服事同工：", "- 導播：Ray"].join("\n")
    );
    expect(result.replyText).not.toContain("2026-07-04");
    expect(result.replyText).not.toContain("2026-07-07");
    expect(notion.queryDatabase).toHaveBeenCalledWith(
      "notion-db",
      expect.objectContaining({
        filter: expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({ date: { on_or_after: "2026-07-05" } }),
            expect.objectContaining({ date: { before: "2026-07-06" } })
          ])
        })
      })
    );
  });

  it("formats multiline service roster text into LINE bullet rows", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-tomorrow",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "7月5日 主日" } },
            Role: { type: "title", title: [] },
            Person: {
              type: "rich_text",
              rich_text: [
                {
                  plain_text: "導播: 知樂\n前攝影: 昱圻\n後攝影: 家怡\n投影電腦: 育圻"
                }
              ]
            }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T12:00:00.000Z")
    });

    const result = await handler({ query: "明天聚會服事人員" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "明天聚會服事表",
        "7月5日",
        "",
        "【7月5日 主日】",
        "服事同工：",
        "- 導播：知樂",
        "- 前攝影：昱圻",
        "- 後攝影：家怡",
        "- 投影電腦：育圻"
      ].join("\n")
    );
  });

  it("uses the configured time zone when deriving tomorrow ranges", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([
        {
          id: "page-utc-tomorrow",
          properties: {
            Date: { type: "date", date: { start: "2026-07-05" } },
            Meeting: { type: "select", select: { name: "UTC meeting" } },
            Role: { type: "title", title: [{ plain_text: "Role" }] },
            Person: { type: "people", people: [{ name: "Ray" }] }
          }
        },
        {
          id: "page-taipei-tomorrow",
          properties: {
            Date: { type: "date", date: { start: "2026-07-06" } },
            Meeting: { type: "select", select: { name: "Taipei meeting" } },
            Role: { type: "title", title: [{ plain_text: "Role" }] },
            Person: { type: "people", people: [{ name: "Ann" }] }
          }
        }
      ])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      },
      now: () => new Date("2026-07-04T23:30:00.000Z"),
      timeZone: "UTC"
    });

    const result = await handler({ query: "明天聚會服事人員" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("7月5日");
    expect(result.replyText).not.toContain("7月6日");
    expect(notion.queryDatabase).toHaveBeenCalledWith(
      "notion-db",
      expect.objectContaining({
        filter: expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({ date: { on_or_after: "2026-07-05" } }),
            expect.objectContaining({ date: { before: "2026-07-06" } })
          ])
        })
      })
    );
  });

  it("returns a clear empty result with suggestions when Notion has no matching rows", async () => {
    const notion: NotionDatabaseClient = {
      queryDatabase: vi.fn().mockResolvedValue([])
    };
    const handler = createQueryServiceScheduleHandler({
      notion,
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      }
    });

    const result = await handler({ query: "不存在的服事" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("查不到符合的服事表。");
    expect(result.quickReplies).toEqual([
      {
        label: "查本週服事",
        action: { type: "message", label: "查本週服事", text: "小哈 查本週服事" }
      },
      {
        label: "查主日服事",
        action: { type: "message", label: "查主日服事", text: "小哈 查主日服事" }
      }
    ]);
  });
});

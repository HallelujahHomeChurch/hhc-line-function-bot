import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import {
  createFindPopSheetMusicHandler,
  createFindPopSheetMusicPostbackHandler,
  createFindPopSheetMusicTextMessageHandler
} from "../functions/find-pop-sheet-music.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  GraphDriveClient,
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
    enabledFunctions: ["find_sheet_music"],
    permissionRequiredFunctions: []
  };
}

function handlerContext(): FunctionHandlerContext {
  return {
    profile: profile(),
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      message: { type: "text", text: "小哈 查流行歌譜 A TIME FOR US" }
    }
  };
}

function personalizedHandlerContext(): FunctionHandlerContext {
  return {
    ...handlerContext(),
    requesterDisplayName: "Ray"
  };
}

async function currentItemById(_driveId: string, itemId: string) {
  return { id: itemId, name: "current-item" };
}

describe("find_sheet_music", () => {
  it("returns local not-found without creating external research consent", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    const sessions = new InMemorySessionStore({ now: () => now });
    const handler = createFindPopSheetMusicHandler({
      graph: { listFolderChildren: vi.fn().mockResolvedValue([]), createSharingLink: vi.fn() },
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pdf"],
      sessionStore: sessions,
      now: () => now,
      requestIdFactory: () => "consent-1"
    });

    const result = await handler({ query: "missing song", fileType: "pdf" }, handlerContext());

    expect(result.replyText).not.toContain("上網找");
    expect(result.quickReplies?.map(({ label }) => label)).not.toContain("上網找");
    await expect(sessions.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("keeps local not-found with or without requester identity", async () => {
    const sessions = new InMemorySessionStore();
    const graph = { listFolderChildren: vi.fn().mockResolvedValue([]), createSharingLink: vi.fn() };
    const disabled = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pdf"],
      sessionStore: sessions
    });
    const requesterMissing = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pdf"],
      sessionStore: sessions
    });

    const plain = await disabled({ query: "missing song" }, handlerContext());
    const noRequester = await requesterMissing(
      { query: "missing song" },
      {
        ...handlerContext(),
        event: {
          ...handlerContext().event,
          source: { type: "group", groupId: "Cgroup" }
        }
      }
    );

    expect(plain.replyText).not.toContain("上網找");
    expect(noRequester.replyText).not.toContain("上網找");
    await expect(sessions.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("reports provider failures as unavailable instead of not found", async () => {
    const handler = createFindPopSheetMusicHandler({
      graph: {
        listFolderChildren: vi.fn().mockRejectedValue(new Error("provider_down")),
        createSharingLink: vi.fn()
      },
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pdf"],
      recursive: false
    });

    await expect(handler({ query: "synthetic" }, handlerContext())).resolves.toMatchObject({
      agentResult: { status: "unavailable" }
    });
  });

  it("finds a catalog PNG when the user does not constrain the format", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "main",
      sourceKey: "hymn_sheet_music",
      adapterType: "onedrive",
      domain: "sheet_music",
      defaultItemKind: "hymn_sheet",
      rootLocation: { driveId: "drive-1", folderItemId: "hymn-root" },
      enabled: true,
      syncPolicy: { mode: "scheduled", allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"] },
      capabilities: { read: ["main"], write: ["main:hymn_sheet:write"] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "hymn_sheet",
      domain: "sheet_music",
      title: "奔跑不放棄",
      path: "奔跑不放棄.png",
      extension: ".png",
      mimeType: "image/png",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "png-1" }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/png")
    };
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-1",
      folderItemId: "hymn-root",
      allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
      catalog
    });

    const result = await handler({ query: "奔跑不放棄" }, handlerContext());

    expect(result.replyText).toContain("https://download.invalid/png");
    expect(graph.listFolderChildren).not.toHaveBeenCalled();
  });

  it("uses catalog results before crawling the sheet music folder", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "main",
      sourceKey: "pop_sheet_music",
      adapterType: "onedrive",
      domain: "sheet_music",
      defaultItemKind: "pop_sheet",
      rootLocation: { driveId: "drive-id", folderItemId: "sheet-folder-id" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["main"], write: [] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "pop_sheet",
      domain: "sheet_music",
      title: "A TIME FOR US-Andy Williams-043.pdf",
      storageRef: { provider: "graph", driveId: "catalog-drive", itemId: "catalog-sheet-1" }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([{ id: "legacy", driveId: "legacy-drive", name: "A TIME FOR US.pdf" }]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/catalog-sheet")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      catalog,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"],
      now: () => now
    });

    const result = await handler({ query: "A TIME FOR US", fileType: "pdf" }, handlerContext());

    expect(result.replyText).toContain("https://download.invalid/catalog-sheet");
    expect(result.agentResult).toMatchObject({
      status: "success",
      replyText: "歌譜查詢完成。",
      entities: [{ type: "resource", key: "catalog-sheet-1", label: "歌譜資源" }],
      supportedOperations: ["continue", "refine", "view_full"]
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/A TIME FOR US|download\.invalid/iu);
    expect(graph.listFolderFilesRecursive).not.toHaveBeenCalled();
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "catalog-drive",
      "catalog-sheet-1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("carries the actual data time for a stale catalog sheet-music success", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "main",
      sourceKey: "pop_sheet_music",
      adapterType: "onedrive",
      domain: "sheet_music",
      defaultItemKind: "pop_sheet",
      rootLocation: { driveId: "drive-id", folderItemId: "sheet-folder-id" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 10 },
      capabilities: { read: ["main"], write: [] }
    });
    await catalog.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: "0",
      publishedAt: "2026-07-04T09:00:00.000Z",
      items: [
        {
          sourceId: source.id,
          itemKind: "pop_sheet",
          domain: "sheet_music",
          title: "A TIME FOR US.pdf",
          storageRef: { provider: "graph", driveId: "catalog-drive", itemId: "stale-sheet" }
        }
      ]
    });
    const handler = createFindPopSheetMusicHandler({
      graph: {
        listFolderChildren: vi.fn(),
        getItemById: vi.fn(currentItemById),
        createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/stale-sheet")
      },
      catalog,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      now: () => new Date("2026-07-04T09:30:00.000Z")
    });

    const result = await handler({ query: "A TIME FOR US" }, handlerContext());

    expect(result.diagnostics).toMatchObject({
      executionMode: "catalog_snapshot_read",
      freshnessStatus: "stale_allowed",
      sourceRevision: "present",
      dataAsOf: "2026-07-04T09:00:00.000Z"
    });
  });

  it("falls back to a fresh provider query when the catalog has never published", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([{ id: "legacy", driveId: "legacy-drive", name: "A TIME FOR US.pdf" }]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/legacy")
    };
    const handler = createFindPopSheetMusicHandler({
      graph,
      catalog: new InMemoryCatalogStore(),
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"]
    });

    const result = await handler({ query: "A TIME FOR US", fileType: "pdf" }, handlerContext());

    expect(result.replyText).toContain("https://download.invalid/legacy");
    expect(graph.listFolderFilesRecursive).toHaveBeenCalledOnce();
    expect(graph.createSharingLink).toHaveBeenCalledOnce();
  });

  it("softly personalizes missing sheet music title clarification", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph: {
        listFolderChildren: vi.fn(),
        listFolderFilesRecursive: vi.fn(),
        createSharingLink: vi.fn()
      },
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      now: () => now
    });

    const result = await handler({ query: "" }, personalizedHandlerContext());

    expect(result.replyText).toBe("Ray，要查哪一首流行歌譜？請直接回覆歌名或歌手。");
  });

  it("finds one PDF recursively and creates a 24 hour link", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([
        {
          id: "pdf-1",
          driveId: "remote-drive",
          name: "A TIME FOR US-Andy Williams-043.pdf",
          path: "流行歌譜 (捷徑)/01大紅(分頁)"
        }
      ]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/a-time-for-us")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"],
      now: () => now
    });

    const result = await handler({ query: "A TIME FOR US", fileType: "pdf" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "已找到流行歌曲樂譜：",
        "A TIME FOR US-Andy Williams-043.pdf",
        "下載連結（1 天內有效）：",
        "https://download.invalid/a-time-for-us"
      ].join("\n")
    );
    expect(result.agentResource).toMatchObject({
      resourceType: "sheet_music",
      title: "A TIME FOR US-Andy Williams-043.pdf",
      storage: { provider: "graph", driveId: "remote-drive", itemId: "pdf-1" }
    });
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "remote-drive",
      "pdf-1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("does not let an external remembered sheet bypass current provider search", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    await memoryStore.recordResource({
      profileName: "main",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      createdBy: "U1",
      resourceType: "sheet_music",
      title: "A TIME FOR US 手抄譜",
      query: "A TIME FOR US",
      storage: { provider: "external_link", url: "https://example.com/a-time-for-us" },
      expiresAt: "2026-08-04T10:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([]),
      createSharingLink: vi.fn()
    };
    const handler = createFindPopSheetMusicHandler({
      graph,
      memoryStore,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      now: () => now
    });

    const result = await handler({ query: "A TIME FOR US" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.agentResult).toMatchObject({ status: "not_found" });
    expect(result.replyText).not.toContain("https://example.com/a-time-for-us");
    expect(graph.listFolderFilesRecursive).toHaveBeenCalledOnce();
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("uses remembered sheet metadata only to rank current Graph candidates", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    await memoryStore.recordResource({
      profileName: "main",
      source: { type: "group", groupId: "Cgroup", userId: "U1" },
      createdBy: "U1",
      resourceType: "sheet_music",
      title: "A TIME FOR US 手抄譜",
      query: "A TIME FOR US 手抄譜",
      storage: { provider: "external_link", url: "https://example.com/a-time-for-us" },
      expiresAt: "2026-08-04T10:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([{ id: "pdf-1", driveId: "drive-id", name: "A TIME FOR US.pdf" }]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/current-sheet")
    };
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPopSheetMusicHandler({
      graph,
      memoryStore,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      sessionStore,
      now: () => now,
      requestIdFactory: () => "mixed-sheet"
    });

    const result = await handler({ query: "A TIME FOR US" }, handlerContext());

    expect(result.replyText).toContain("A TIME FOR US.pdf");
    expect(result.replyText).not.toContain("https://example.com/a-time-for-us");
    await expect(sessionStore.get("mixed-sheet")).resolves.toBeUndefined();
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "pdf-1",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("refreshes the provider index so a second query can see newly added files", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "pdf-1", driveId: "drive-id", name: "YESTERDAY-The Beatles-001.pdf" }
        ])
        .mockResolvedValueOnce([
          { id: "pdf-2", driveId: "drive-id", name: "NEW SONG-The Band-001.pdf" }
        ]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi
        .fn()
        .mockResolvedValueOnce("https://download.invalid/yesterday-1")
        .mockResolvedValueOnce("https://download.invalid/yesterday-2")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      now: () => now
    });

    await handler({ query: "Yesterday" }, handlerContext());
    await handler({ query: "New Song" }, handlerContext());

    expect(graph.listFolderFilesRecursive).toHaveBeenCalledTimes(2);
    expect(graph.createSharingLink).toHaveBeenCalledTimes(2);
  });

  it("can use only the configured folder level when recursive lookup is disabled", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi
        .fn()
        .mockResolvedValue([
          { id: "pdf-1", driveId: "drive-id", name: "YESTERDAY-The Beatles-001.pdf" }
        ]),
      listFolderFilesRecursive: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/yesterday")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      recursive: false,
      now: () => now
    });

    const result = await handler({ query: "Yesterday" }, handlerContext());

    expect(result.replyText).toContain("YESTERDAY-The Beatles-001.pdf");
    expect(graph.listFolderChildren).toHaveBeenCalledWith("drive-id", "sheet-folder-id");
    expect(graph.listFolderFilesRecursive).not.toHaveBeenCalled();
  });

  it("offers recovery quick replies when no sheet music candidates match", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([{ id: "pdf-1", driveId: "drive-id", name: "YESTERDAY.pdf" }]),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"],
      now: () => now
    });

    const result = await handler({ query: "No Such Song" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("找不到符合的流行歌曲樂譜，請提供更完整歌名或歌手。");
    expect(result.quickReplies).toEqual([
      {
        label: "重新查歌譜",
        action: { type: "message", label: "重新查歌譜", text: "小哈 查流行歌譜" }
      },
      {
        label: "查圖片歌譜",
        action: { type: "message", label: "查圖片歌譜", text: "小哈 查流行歌譜 圖片" }
      }
    ]);
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("stores multiple candidates in a generic selection session", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([
        { id: "pdf-1", driveId: "drive-id", name: "ALWAYS-Atalantic starr-321.pdf" },
        { id: "pdf-2", driveId: "drive-id", name: "ALWAYS ON MY MIND-Willy Nelson-229.pdf" }
      ]),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      sessionStore,
      now: () => now,
      requestIdFactory: () => "sheet-req-1"
    });

    const result = await handler({ query: "Always" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe(
      [
        "找到多個相近的樂譜，請選擇：",
        "1. ALWAYS-Atalantic starr-321.pdf",
        "2. ALWAYS ON MY MIND-Willy Nelson-229.pdf"
      ].join("\n")
    );
    expect(result.quickReplies).toEqual([
      {
        label: "1",
        action: {
          type: "postback",
          label: "1",
          data: "action=select_sheet_music&requestId=sheet-req-1&index=0",
          displayText: "1"
        }
      },
      {
        label: "2",
        action: {
          type: "postback",
          label: "2",
          data: "action=select_sheet_music&requestId=sheet-req-1&index=1",
          displayText: "2"
        }
      }
    ]);
    await expect(sessionStore.get("sheet-req-1")).resolves.toMatchObject({
      type: "selection",
      action: "select_sheet_music",
      items: [
        { id: "pdf-1", driveId: "drive-id", name: "ALWAYS-Atalantic starr-321.pdf" },
        { id: "pdf-2", driveId: "drive-id", name: "ALWAYS ON MY MIND-Willy Nelson-229.pdf" }
      ]
    });
  });

  it("creates a sharing link after a sheet music postback selection", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/selected")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    await sessionStore.set({
      id: "sheet-req-1",
      type: "selection",
      action: "select_sheet_music",
      profileName: "main",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cgroup" },
      items: [{ id: "pdf-2", driveId: "remote-drive", name: "ALWAYS ON MY MIND.pdf" }],
      expiresAt: new Date("2026-07-04T10:10:00.000Z").toISOString()
    });
    const handlePostback = createFindPopSheetMusicPostbackHandler({
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
        postback: { data: "action=select_sheet_music&requestId=sheet-req-1&index=0" }
      }
    };

    const result = await handlePostback(
      { action: "select_sheet_music", params: { requestId: "sheet-req-1", index: "0" } },
      context
    );

    expect(result.replyText).toContain("ALWAYS ON MY MIND.pdf");
    expect(result.replyText).toContain("https://download.invalid/selected");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "remote-drive",
      "pdf-2",
      "2026-07-05T10:00:00.000Z"
    );
  });

  it("does not honor sheet music postback selections when the function is not enabled", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handlePostback = createFindPopSheetMusicPostbackHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const disabledProfile: BotProfileConfig = { ...profile(), enabledFunctions: [] };

    const result = await handlePostback(
      { action: "select_sheet_music", params: { requestId: "sheet-req-1", index: "0" } },
      {
        profile: disabledProfile,
        event: {
          type: "postback",
          replyToken: "reply-token",
          source: { type: "group", groupId: "Cgroup", userId: "U1" },
          postback: { data: "action=select_sheet_music&requestId=sheet-req-1&index=0" }
        }
      }
    );

    expect(result.replyText).toBe("這個功能目前沒有開放。");
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("handles numeric sheet music selections through the generic text flow", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/numeric")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    await sessionStore.set({
      id: "sheet-req-1",
      type: "selection",
      action: "select_sheet_music",
      profileName: "main",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cgroup" },
      items: [{ id: "pdf-1", driveId: "drive-id", name: "YESTERDAY.pdf" }],
      expiresAt: new Date("2026-07-04T10:10:00.000Z").toISOString()
    });
    const handleText = createFindPopSheetMusicTextMessageHandler({
      graph,
      sessionStore,
      now: () => now
    });

    await expect(handleText.matches({ text: "1" }, handlerContext())).resolves.toBe(true);
    const result = await handleText.handle({ text: "1" }, handlerContext());

    expect(result?.replyText).toContain("YESTERDAY.pdf");
    expect(result?.replyText).toContain("https://download.invalid/numeric");
  });
});

import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { MemoryCacheStore } from "../cache/cache-store.js";
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
    enabledFunctions: ["find_sheet_music"]
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

describe("find_sheet_music", () => {
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
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/catalog-sheet")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      catalog,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"],
      cache: new MemoryCacheStore({ now: () => now }),
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

  it("does not crawl OneDrive when the catalog has no match", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([{ id: "legacy", driveId: "legacy-drive", name: "A TIME FOR US.pdf" }]),
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

    expect(result.replyText).not.toContain("https://download.invalid/legacy");
    expect(graph.listFolderFilesRecursive).not.toHaveBeenCalled();
    expect(graph.createSharingLink).not.toHaveBeenCalled();
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
      cache: new MemoryCacheStore({ now: () => now }),
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
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/a-time-for-us")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf", ".jpg", ".jpeg"],
      cache: new MemoryCacheStore({ now: () => now }),
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

  it("returns an external remembered sheet music link before searching Graph", async () => {
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
      cache: new MemoryCacheStore({ now: () => now }),
      now: () => now
    });

    const result = await handler({ query: "A TIME FOR US" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("已找到我記住的");
    expect(result.replyText).toContain("A TIME FOR US 手抄譜");
    expect(result.replyText).toContain("https://example.com/a-time-for-us");
    expect(graph.listFolderFilesRecursive).not.toHaveBeenCalled();
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("merges remembered and Graph sheet music candidates into one selection flow", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    const remembered = await memoryStore.recordResource({
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
      createSharingLink: vi.fn()
    };
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPopSheetMusicHandler({
      graph,
      memoryStore,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      sessionStore,
      cache: new MemoryCacheStore({ now: () => now }),
      now: () => now,
      requestIdFactory: () => "mixed-sheet"
    });

    const result = await handler({ query: "A TIME FOR US" }, handlerContext());

    expect(result.replyText).toContain("A TIME FOR US 手抄譜");
    expect(result.replyText).toContain("A TIME FOR US.pdf");
    await expect(sessionStore.get("mixed-sheet")).resolves.toMatchObject({
      type: "selection",
      action: "select_sheet_music",
      items: [
        {
          id: remembered.id,
          name: "A TIME FOR US 手抄譜",
          memoryResource: { storage: { provider: "external_link" } }
        },
        { id: "pdf-1", driveId: "drive-id", name: "A TIME FOR US.pdf" }
      ]
    });

    const handlePostback = createFindPopSheetMusicPostbackHandler({
      graph,
      sessionStore,
      now: () => now
    });
    const selected = await handlePostback(
      { action: "select_sheet_music", params: { requestId: "mixed-sheet", index: "0" } },
      {
        profile: profile(),
        event: {
          type: "postback",
          replyToken: "reply-token",
          source: { type: "group", groupId: "Cgroup", userId: "U1" },
          postback: { data: "action=select_sheet_music&requestId=mixed-sheet&index=0" }
        }
      }
    );

    expect(selected.replyText).toContain("https://example.com/a-time-for-us");
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("uses the file index cache between searches", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi
        .fn()
        .mockResolvedValue([
          { id: "pdf-1", driveId: "drive-id", name: "YESTERDAY-The Beatles-001.pdf" }
        ]),
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
      cache: new MemoryCacheStore({ now: () => now }),
      now: () => now
    });

    await handler({ query: "Yesterday" }, handlerContext());
    await handler({ query: "Yesterday" }, handlerContext());

    expect(graph.listFolderFilesRecursive).toHaveBeenCalledOnce();
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
      cache: new MemoryCacheStore({ now: () => now }),
      now: () => now
    });

    const result = await handler({ query: "No Such Song" }, handlerContext());

    expect(result.ok).toBe(true);
    expect(result.replyText).toBe("找不到符合的流行歌曲樂譜，請提供更完整英文歌名或歌手。");
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

  it("asks for consent before running external sheet music web search", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([]),
      createSharingLink: vi.fn()
    };
    const webSearch = { search: vi.fn().mockResolvedValue([]) };
    const summarize = vi.fn().mockResolvedValue("unused");
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      sessionStore,
      externalSearch: { webSearch, summarize },
      now: () => now,
      requestIdFactory: () => "external-search-1"
    });

    const result = await handler({ query: "No Such Song" }, handlerContext());

    expect(result.replyText).toContain("本地歌譜資料庫找不到");
    expect(result.replyText).toContain("要不要上網找公開搜尋結果");
    expect(webSearch.search).not.toHaveBeenCalled();
    await expect(
      sessionStore.findExternalSearchConsent({
        action: "sheet_music_external_search",
        profileName: "main",
        source: handlerContext().event.source,
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      query: "No Such Song",
      action: "sheet_music_external_search"
    });
  });

  it("runs external sheet music web search only after requester consent", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([]),
      createSharingLink: vi.fn()
    };
    const webSearch = {
      search: vi.fn().mockResolvedValue([
        {
          title: "No Such Song sheet music",
          snippet: "Public search snippet",
          url: "https://example.org/no-such-song"
        }
      ])
    };
    const summarize = vi
      .fn()
      .mockResolvedValue("我在公開搜尋結果找到一個可能相關的結果：No Such Song sheet music。");
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    const handler = createFindPopSheetMusicHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "sheet-folder-id",
      allowedExtensions: [".pdf"],
      sessionStore,
      externalSearch: { webSearch, summarize },
      now: () => now,
      requestIdFactory: () => "external-search-1"
    });
    const textHandler = createFindPopSheetMusicTextMessageHandler({
      graph,
      sessionStore,
      externalSearch: { webSearch, summarize },
      now: () => now
    });
    await handler({ query: "No Such Song" }, handlerContext());

    const result = await textHandler.handle({ text: "好，上網找" }, handlerContext());

    expect(webSearch.search).toHaveBeenCalledWith({
      query: "No Such Song 歌譜",
      limit: 5,
      language: "zh-TW"
    });
    expect(summarize).toHaveBeenCalledWith({
      profileName: "main",
      query: "No Such Song",
      results: [
        {
          title: "No Such Song sheet music",
          snippet: "Public search snippet",
          url: "https://example.org/no-such-song"
        }
      ]
    });
    expect(result?.replyText).toContain("公開搜尋結果");
    expect(result?.replyText).toContain("No Such Song sheet music");
    await expect(
      sessionStore.findExternalSearchConsent({
        action: "sheet_music_external_search",
        profileName: "main",
        source: handlerContext().event.source,
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
  });

  it("imports a selected direct result only after target selection and confirmation", async () => {
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now });
    await sessionStore.set({
      id: "external-import-1",
      type: "external_sheet_music_import",
      stage: "selecting",
      profileName: "main",
      requesterUserId: "U1",
      source: handlerContext().event.source,
      query: "Amazing Grace",
      items: [{ title: "Amazing Grace.pdf", url: "https://example.org/amazing-grace.pdf" }],
      expiresAt: "2026-07-04T10:10:00.000Z"
    });
    const client = {
      download: vi.fn().mockResolvedValue({
        data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        finalUrl: "https://example.org/amazing-grace.pdf",
        fileName: "amazing-grace.pdf",
        contentType: "application/pdf"
      })
    };
    const publisher = {
      publish: vi.fn().mockResolvedValue({
        ok: true,
        replyText: "已保存：Amazing Grace",
        executedAction: "save_resource"
      })
    };
    const textHandler = createFindPopSheetMusicTextMessageHandler({
      graph: { listFolderChildren: vi.fn(), createSharingLink: vi.fn() },
      sessionStore,
      externalImport: { client, publisher, maxBytes: 1024, timeoutMs: 1000, maxRedirects: 3 },
      now: () => now
    });
    const context = handlerContext();
    context.profile.enabledFunctions = ["find_sheet_music", "save_resource"];

    await expect(textHandler.handle({ text: "1" }, context)).resolves.toMatchObject({
      replyText: expect.stringContaining("流行歌譜還是詩歌歌譜")
    });
    await expect(textHandler.handle({ text: "流行歌譜" }, context)).resolves.toMatchObject({
      replyText: expect.stringContaining("教會可以保存並使用")
    });
    const result = await textHandler.handle({ text: "保存" }, context);

    expect(result).toMatchObject({ executedAction: "save_resource" });
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    await expect(
      sessionStore.findExternalSheetMusicImport({
        profileName: "main",
        source: context.event.source,
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
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

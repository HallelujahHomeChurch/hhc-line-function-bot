import { describe, expect, it, vi } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
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
    webhookPath: "/line/main/webhook",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowedGroupIds: ["Cgroup"],
    allowedUserIds: ["Uallowed"],
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["find_pop_sheet_music"]
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

describe("find_pop_sheet_music", () => {
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
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "remote-drive",
      "pdf-1",
      "2026-07-05T10:00:00.000Z"
    );
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
    expect(sessionStore.get("sheet-req-1")).toMatchObject({
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
    sessionStore.set({
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

  it("handles numeric sheet music selections through the generic text flow", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/numeric")
    };
    const now = new Date("2026-07-04T10:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now, ttlMs: 10 * 60 * 1000 });
    sessionStore.set({
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

    expect(handleText.matches({ text: "1" }, handlerContext())).toBe(true);
    const result = await handleText.handle({ text: "1" }, handlerContext());

    expect(result?.replyText).toContain("YESTERDAY.pdf");
    expect(result?.replyText).toContain("https://download.invalid/numeric");
  });
});

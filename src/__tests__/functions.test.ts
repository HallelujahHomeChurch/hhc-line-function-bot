import { describe, expect, it, vi } from "vitest";

import {
  createFindPptSlidesHandler,
  createFindPptSlidesPostbackHandler
} from "../functions/find-ppt-slides.js";
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
    enabledFunctions: ["find_ppt_slides", "query_service_schedule"]
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

describe("find_ppt_slides", () => {
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
    expect(result.replyText).toContain("奇異恩典.pptx");
    expect(result.replyText).toContain("https://download.invalid/amazing-grace");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-id",
      "1",
      "2026-07-05T10:00:00.000Z"
    );
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
    expect(result.replyText).toContain("找到 3 個可能的投影片");
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
    expect(sessionStore.get("req-1")).toMatchObject({
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
    sessionStore.set({
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
});

describe("query_service_schedule", () => {
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
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).toContain("主日聚會");
    expect(result.replyText).toContain("司會");
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
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).not.toContain("2026-07-12");
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
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).toContain("Ray");
    expect(result.replyText).not.toContain("2026-01-04");
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
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).toContain("Ray");
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
    expect(result.replyText).toContain("2026-07-05");
    expect(result.replyText).not.toContain("2026-07-06");
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

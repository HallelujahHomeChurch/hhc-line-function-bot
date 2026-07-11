import { describe, expect, it, vi } from "vitest";

import { InMemoryCatalogStore } from "../catalog/store.js";
import { createFindResourceHandler } from "../functions/find-resource.js";
import type { FunctionHandlerContext, GraphDriveClient } from "../types.js";

function context(): FunctionHandlerContext {
  return {
    profile: {
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
      enabledFunctions: ["find_resource"]
    },
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: "小哈 下載週報音檔" }
    }
  };
}

describe("find_resource", () => {
  it("searches catalog items such as weekly report audio and creates a temporary Graph link", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "weekly_report_audio",
      adapterType: "onedrive",
      domain: "audio",
      defaultItemKind: "weekly_report_audio",
      rootLocation: { driveId: "drive-1", folderItemId: "folder-1" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: [] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "weekly_report_audio",
      domain: "audio",
      title: "2026-07-週報音檔.mp3",
      path: "2026/07/週報音檔.mp3",
      mimeType: "audio/mpeg",
      extension: ".mp3",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "audio-1" },
      externalUpdatedAt: "2026-07-11T00:00:00.000Z"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/weekly-report")
    };
    const handler = createFindResourceHandler({
      catalog,
      graph,
      allowedItemKinds: ["weekly_report_audio"],
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });

    const result = await handler({ query: "週報音檔" }, context());

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("2026-07-週報音檔.mp3");
    expect(result.replyText).toContain("https://download.invalid/weekly-report");
    expect(graph.createSharingLink).toHaveBeenCalledWith(
      "drive-1",
      "audio-1",
      "2026-07-12T00:00:00.000Z"
    );
  });

  it("asks for a query instead of listing the entire catalog", async () => {
    const handler = createFindResourceHandler({
      catalog: new InMemoryCatalogStore(),
      graph: { listFolderChildren: vi.fn(), createSharingLink: vi.fn() }
    });

    const result = await handler({ query: "" }, context());

    expect(result.replyText).toContain("請告訴我要查什麼");
  });

  it("does not return catalog items from sources without read capability", async () => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "private_audio",
      adapterType: "onedrive",
      domain: "audio",
      defaultItemKind: "weekly_report_audio",
      rootLocation: { driveId: "drive-1", folderItemId: "folder-1" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["main"], write: [] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "weekly_report_audio",
      domain: "audio",
      title: "2026-07-週報音檔.mp3",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "audio-1" }
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn()
    };
    const handler = createFindResourceHandler({
      catalog,
      graph,
      allowedItemKinds: ["weekly_report_audio"],
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });

    const result = await handler({ query: "週報音檔" }, context());

    expect(result.replyText).toBe("查不到符合的教會資料。");
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });
});

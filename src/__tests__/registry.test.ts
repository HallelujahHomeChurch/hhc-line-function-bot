import { describe, expect, it, vi } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
import { createFunctionRegistries } from "../functions/registry.js";
import type { AppConfig, BotProfileConfig, GraphDriveClient } from "../types.js";

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/line/helper/webhook",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowedGroupIds: ["Cgroup"],
    allowedUserIds: ["Uadmin"],
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"],
    adminUserIds: ["Uadmin"],
    adminDirectOnly: true
  };
}

function config(): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    maxBodyBytes: 262_144,
    profiles: [profile()],
    llm: {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keywordFallbackEnabled: true
    },
    graph: {
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      driveId: "drive-id",
      pptFolderItemId: "ppt-folder",
      sheetMusicFolderItemId: "sheet-folder",
      sheetMusicFolderPath: "文件/流行歌譜 (捷徑)",
      sheetMusicAllowedExtensions: [".pdf", ".jpg", ".jpeg"],
      sheetMusicRecursive: true,
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      linkType: "view",
      linkScope: "anonymous"
    }
  };
}

describe("function registry", () => {
  it("registers sheet music handlers and admin cache refresh when Graph is configured", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
    const cache = new MemoryCacheStore();
    await cache.set("sheet-music-index:drive-id:sheet-folder", [{ id: "1", name: "A.pdf" }], 1000);
    await cache.set("other-cache-key", "kept", 1000);

    const registries = createFunctionRegistries(config(), { graph, cache });

    expect(registries.functions.find_pop_sheet_music).toBeDefined();
    expect(registries.postbacks.select_sheet_music).toBeDefined();
    expect(registries.textMessages.sheet_music_numeric_selection).toBeDefined();
    expect(registries.adminHandlers["refresh-sheet-music-cache"]).toBeDefined();

    const result = await registries.adminHandlers["refresh-sheet-music-cache"]({
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uadmin" },
        message: { type: "text", text: "小哈 admin refresh-sheet-music-cache" }
      },
      command: "refresh-sheet-music-cache",
      args: []
    });

    expect(result.replyText).toBe("已清除流行歌譜 cache（1 筆），下次查詢會重新建立。");
    expect(await cache.get("sheet-music-index:drive-id:sheet-folder")).toBeUndefined();
    expect(await cache.get("other-cache-key")).toBe("kept");
  });
});

import { describe, expect, it, vi } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
import { createFunctionRegistries } from "../functions/registry.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { AppConfig, BotProfileConfig, GraphDriveClient } from "../types.js";

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
    enabledFunctions: ["find_ppt_slides", "query_service_schedule", "find_pop_sheet_music"],
    adminUserId: "Uadmin",
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
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,
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
        message: { type: "text", text: "/refresh-sheet-music-cache" }
      },
      command: "refresh-sheet-music-cache",
      args: []
    });

    expect(result.replyText).toBe("已清除流行歌譜 cache（1 筆），下次查詢會重新建立。");
    expect(await cache.get("sheet-music-index:drive-id:sheet-folder")).toBeUndefined();
    expect(await cache.get("other-cache-key")).toBe("kept");
  });

  it("registers debug admin handlers for functions, sessions, cache, and LLM status", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: "qwen3:4b-instruct" }] }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: '{"action":"deny"}' } }), {
          status: 200
        })
      );
    const cache = new MemoryCacheStore();
    const sessionStore = new InMemorySessionStore();
    await cache.set("sheet-music-index:drive-id:sheet-folder", [{ id: "1", name: "A.pdf" }], 1000);
    await sessionStore.set({
      id: "pending-1",
      type: "pending_function",
      action: "find_ppt_slides",
      profileName: "helper",
      requesterUserId: "Uadmin",
      source: { type: "user", userId: "Uadmin" },
      arguments: { query: "" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const registries = createFunctionRegistries(config(), {
      graph,
      cache,
      sessionStore,
      fetchImpl
    });
    const adminContext = {
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uadmin" },
        message: { type: "text", text: "/functions" }
      },
      command: "functions",
      args: []
    };

    const functionsResult = await registries.adminHandlers.functions(adminContext);
    const sessionsResult = await registries.adminHandlers.sessions({
      ...adminContext,
      command: "sessions"
    });
    const cacheResult = await registries.adminHandlers.cache({ ...adminContext, command: "cache" });
    const llmStatusResult = await registries.adminHandlers["llm-status"]({
      ...adminContext,
      command: "llm-status"
    });
    const clearResult = await registries.adminHandlers["clear-sessions"]({
      ...adminContext,
      command: "clear-sessions"
    });
    const sessionsAfterClear = await registries.adminHandlers.sessions({
      ...adminContext,
      command: "sessions"
    });

    expect(functionsResult.replyText).toContain("- find_ppt_slides: configured");
    expect(functionsResult.replyText).toContain("- query_service_schedule: not configured");
    expect(functionsResult.replyText).toContain("- find_pop_sheet_music: configured");
    expect(sessionsResult.replyText).toContain("total: 1");
    expect(sessionsResult.replyText).toContain("- pending_function: 1");
    expect(cacheResult.replyText).toBe("Cache\nentries: 1");
    expect(llmStatusResult.replyText).toContain("LLM status");
    expect(llmStatusResult.replyText).toContain("tags: ok");
    expect(llmStatusResult.replyText).toContain("chat: ok");
    expect(clearResult.replyText).toBe("已清除 session（1 筆）。");
    expect(sessionsAfterClear.replyText).toContain("total: 0");
  });
});

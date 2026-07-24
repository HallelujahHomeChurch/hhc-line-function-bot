import { describe, expect, it, vi } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryCatalogStore, type CatalogSourceInput } from "../catalog/store.js";
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
    enabledFunctions: ["find_ppt_slides", "query_schedule", "find_sheet_music"],
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
      deepseekApiKey: "test-key",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000
    },
    graph: {
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      driveId: "drive-id",
      pptFolderItemId: "ppt-folder",
      sheetMusicAllowedExtensions: [".pdf", ".jpg", ".jpeg"],
      allowedExtensions: [".ppt", ".pptx", ".pdf"],
      defaultIncludePdf: false,
      linkType: "view",
      linkScope: "anonymous"
    }
  };
}

const weeklyAudioSource: CatalogSourceInput = {
  profileName: "helper",
  sourceKey: "weekly_report_audio",
  adapterType: "onedrive",
  domain: "audio",
  defaultItemKind: "weekly_report_audio",
  rootLocation: { driveId: "drive-id", folderItemId: "weekly-folder" },
  enabled: false,
  syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
  capabilities: { read: ["helper"], write: [] }
};

describe("function registry", () => {
  it("registers catalog-backed sheet music handlers when Graph is configured", () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
    const registries = createFunctionRegistries(config(), { graph });

    expect(registries.functions.find_sheet_music).toBeDefined();
    expect(registries.postbacks.select_sheet_music).toBeDefined();
    expect(registries.textMessages.sheet_music_numeric_selection).toBeDefined();
    expect(registries.adminHandlers["refresh-sheet-music-cache"]).toBeUndefined();
  });

  it("registers debug admin handlers for functions, sessions, cache, and LLM status", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
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
    expect(functionsResult.replyText).toContain("- query_schedule: configured");
    expect(functionsResult.replyText).toContain("- find_sheet_music: configured");
    expect(sessionsResult.replyText).toContain("total: 1");
    expect(sessionsResult.replyText).toContain("- pending_function: 1");
    expect(cacheResult.replyText).toBe("Cache\nentries: 1");
    expect(llmStatusResult.replyText).toContain("LLM status");
    expect(llmStatusResult.replyText).toContain("provider: deepseek");
    expect(llmStatusResult.replyText).toContain("fallback: none");
    expect(llmStatusResult.replyText).toContain("chat: ok");
    expect(clearResult.replyText).toBe("已清除 session（1 筆）。");
    expect(sessionsAfterClear.replyText).toContain("total: 0");
  });

  it("registers catalog source admin handlers that list, enable, disable, sync, and audit", async () => {
    const catalog = new InMemoryCatalogStore();
    await catalog.upsertSource(weeklyAudioSource);
    const accessStore = new InMemoryAccessStore();
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([
        {
          id: "audio-1",
          driveId: "drive-id",
          name: "weekly-report.mp3"
        }
      ]),
      createSharingLink: vi.fn()
    };
    const registries = createFunctionRegistries(config(), {
      catalog,
      accessStore,
      graph
    });
    const adminContext = {
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uadmin" },
        message: { type: "text", text: "/catalog-sources" }
      },
      command: "catalog-sources",
      args: []
    };

    const listBefore = await registries.adminHandlers["catalog-sources"](adminContext);
    const enable = await registries.adminHandlers["catalog-source-enable"]({
      ...adminContext,
      command: "catalog-source-enable",
      args: ["weekly_report_audio"]
    });
    const status = await registries.adminHandlers["catalog-source-status"]({
      ...adminContext,
      command: "catalog-source-status",
      args: ["weekly_report_audio"]
    });
    const sync = await registries.adminHandlers["catalog-sync-now"]({
      ...adminContext,
      command: "catalog-sync-now",
      args: ["weekly_report_audio"]
    });
    expect(listBefore.replyText).toContain("Catalog sources");
    expect(listBefore.replyText).toContain("weekly_report_audio");
    expect(listBefore.replyText).toContain("enabled=false");
    expect(enable.replyText).toContain("enabled weekly_report_audio");
    expect(status.replyText).toContain("enabled=true");
    expect(sync.replyText).toContain("synced: 1");
    await expect(
      catalog.searchItems({
        profileName: "helper",
        itemKinds: ["weekly_report_audio"],
        allowedSourceKeys: ["weekly_report_audio"]
      })
    ).resolves.toHaveLength(1);
    const disable = await registries.adminHandlers["catalog-source-disable"]({
      ...adminContext,
      command: "catalog-source-disable",
      args: ["weekly_report_audio"]
    });

    expect(disable.replyText).toContain("disabled weekly_report_audio");
    expect(accessStore.audit.map((event) => event.action)).toEqual([
      "catalog.source.disable",
      "catalog.source.sync",
      "catalog.source.enable"
    ]);
  });
});

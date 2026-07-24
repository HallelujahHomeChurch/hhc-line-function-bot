import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { createFunctionRegistries } from "../functions/registry.js";
import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { ControlledAgentRouter } from "../agent/controlled-agent-router.js";
import type {
  AppConfig,
  FunctionRouterPort,
  GraphDriveClient,
  LineReplyClient,
  NotionDatabaseClient
} from "../types.js";

async function currentItemById(_driveId: string, itemId: string) {
  return { id: itemId, name: "current-item" };
}

function testConfig(): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    maxBodyBytes: 32_768,
    profiles: [
      {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "channel-secret",
        channelAccessToken: "channel-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "find_sheet_music"],
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed"
      }
    ],
    llm: {
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

async function sheetMusicCatalog(): Promise<InMemoryCatalogStore> {
  const catalog = new InMemoryCatalogStore();
  const source = await catalog.upsertSource({
    profileName: "helper",
    sourceKey: "pop_sheet_music",
    adapterType: "onedrive",
    domain: "sheet_music",
    defaultItemKind: "pop_sheet",
    rootLocation: { driveId: "drive-id", folderItemId: "sheet-folder" },
    enabled: true,
    syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
    capabilities: { read: ["helper"], write: [] }
  });
  await catalog.upsertItem({
    sourceId: source.id,
    itemKind: "pop_sheet",
    domain: "sheet_music",
    title: "YESTERDAY-The Beatles-001.pdf",
    extension: ".pdf",
    storageRef: { provider: "graph", driveId: "drive-id", itemId: "sheet-1" }
  });
  return catalog;
}

function lineBody(event: Record<string, unknown>) {
  return JSON.stringify({ destination: "bot", events: [event] });
}

function signedHeaders(body: string) {
  return {
    "content-type": "application/json",
    "x-line-signature": signLineBody(Buffer.from(body), "channel-secret")
  };
}

function accessStore(): InMemoryAccessStore {
  return new InMemoryAccessStore({
    principals: [
      {
        id: "principal-user",
        profileName: "helper",
        type: "user",
        principalId: "Uallowed",
        createdAt: "2026-07-06T00:00:00.000Z",
        createdBy: "test"
      },
      {
        id: "principal-group",
        profileName: "helper",
        type: "group",
        principalId: "Cmain",
        createdAt: "2026-07-06T00:00:00.000Z",
        createdBy: "test"
      }
    ]
  });
}

function controlledRouterFromLegacy(route: FunctionRouterPort["route"]): ControlledAgentRouter {
  return {
    async resolve(input) {
      const result = await route({
        profileName: input.profileName,
        text: input.text,
        enabledFunctions: [...input.enabledFunctions],
        source:
          input.sourceType === "group"
            ? { type: "group", groupId: "test-group", userId: "test-user" }
            : { type: "user", userId: "test-user" }
      });
      if (result.type === "deny") {
        return { disposition: "deny", reasonCode: "planner_denied" };
      }
      if (result.type === "respond") {
        return { disposition: "chat", reasonCode: "no_capability_evidence" };
      }
      return {
        disposition: "execute",
        capability: result.action,
        arguments: result.arguments,
        reasonCode: "explicit_intent"
      };
    }
  };
}

describe("clarification flow", () => {
  it("asks for a missing PPT keyword and uses the next group reply without a wake word", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        {
          id: "ppt-1",
          driveId: "drive-id",
          name: "奇異恩典.pptx"
        }
      ]),
      listFolderFilesRecursive: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/amazing-grace")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      catalog: await sheetMusicCatalog(),
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "deepseek"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      controlledAgentRouter: controlledRouterFromLegacy(route),
      accessStore: accessStore(),
      functionRegistry: registries.functions,
      postbackHandlers: registries.postbacks,
      textMessageHandlers: registries.textMessages,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片" }
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(firstBody),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "奇異恩典" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(secondBody),
      payload: secondBody
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenNthCalledWith(
      1,
      "reply-token-1",
      "要查哪一份投影片？請直接回覆名稱。",
      undefined
    );
    expect(replyText).toHaveBeenNthCalledWith(
      2,
      "reply-token-2",
      [
        "已找到詩歌投影片：",
        "奇異恩典.pptx",
        "下載連結（1 天內有效）：",
        "https://download.invalid/amazing-grace"
      ].join("\n"),
      undefined
    );
  });

  it("extracts a PPT title from a wrapped pending follow-up reply", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([
        {
          id: "ppt-1",
          driveId: "drive-id",
          name: "奇異恩典.pptx"
        }
      ]),
      listFolderFilesRecursive: vi.fn(),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/amazing-grace")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      catalog: await sheetMusicCatalog(),
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "deepseek"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      controlledAgentRouter: controlledRouterFromLegacy(route),
      accessStore: accessStore(),
      functionRegistry: registries.functions,
      postbackHandlers: registries.postbacks,
      textMessageHandlers: registries.textMessages,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈 查投影片" }
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(firstBody),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈，幫我查奇異恩典的投影片" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(secondBody),
      payload: secondBody
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText.mock.calls[1]?.[1]).toContain("奇異恩典.pptx");
    expect(replyText.mock.calls[1]?.[1]).toContain("https://download.invalid/amazing-grace");
  });

  it("asks for a missing sheet music keyword and uses the next direct reply", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([
        {
          id: "sheet-1",
          driveId: "drive-id",
          name: "YESTERDAY-The Beatles-001.pdf"
        }
      ]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/yesterday")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      catalog: await sheetMusicCatalog(),
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_sheet_music",
      arguments: { query: "" },
      provider: "deepseek"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      controlledAgentRouter: controlledRouterFromLegacy(route),
      accessStore: accessStore(),
      functionRegistry: registries.functions,
      postbackHandlers: registries.postbacks,
      textMessageHandlers: registries.textMessages,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "查流行歌譜" }
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(firstBody),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "Yesterday" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(secondBody),
      payload: secondBody
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenNthCalledWith(
      1,
      "reply-token-1",
      "要查哪一首流行歌譜？請直接回覆歌名或歌手。",
      undefined
    );
    expect(replyText.mock.calls[1]?.[1]).toContain("YESTERDAY-The Beatles-001.pdf");
    expect(replyText.mock.calls[1]?.[1]).toContain("https://download.invalid/yesterday");
  });

  it("extracts a sheet music title from a wrapped pending follow-up reply", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn().mockResolvedValue([
        {
          id: "sheet-1",
          driveId: "drive-id",
          name: "YESTERDAY-The Beatles-001.pdf"
        }
      ]),
      getItemById: vi.fn(currentItemById),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/yesterday")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      catalog: await sheetMusicCatalog(),
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_sheet_music",
      arguments: { query: "" },
      provider: "deepseek"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      controlledAgentRouter: controlledRouterFromLegacy(route),
      accessStore: accessStore(),
      functionRegistry: registries.functions,
      postbackHandlers: registries.postbacks,
      textMessageHandlers: registries.textMessages,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈 查流行歌曲樂譜" }
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(firstBody),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈，幫我找 Yesterday 的流行歌曲樂譜" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(secondBody),
      payload: secondBody
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText.mock.calls[1]?.[1]).toContain("YESTERDAY-The Beatles-001.pdf");
    expect(replyText.mock.calls[1]?.[1]).toContain("https://download.invalid/yesterday");
  });

  it("asks for a generic service schedule range and uses the next group reply", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      listFolderFilesRecursive: vi.fn(),
      createSharingLink: vi.fn()
    };
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
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    config.notion = {
      token: "notion-token",
      databaseId: "notion-db",
      properties: {
        date: "Date",
        meeting: "Meeting",
        role: "Role",
        person: "Person"
      }
    };
    const registries = createFunctionRegistries(config, {
      graph,
      notion,
      sessionStore: new InMemorySessionStore({
        now: () => new Date("2026-07-05T13:00:00.000Z")
      }),
      now: () => new Date("2026-07-05T13:00:00.000Z")
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
      arguments: { query: "服事表" },
      provider: "deepseek"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      controlledAgentRouter: controlledRouterFromLegacy(route),
      accessStore: accessStore(),
      functionRegistry: registries.functions,
      postbackHandlers: registries.postbacks,
      textMessageHandlers: registries.textMessages,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查服事表" }
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(firstBody),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "下一場" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(secondBody),
      payload: secondBody
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenNthCalledWith(
      1,
      "reply-token-1",
      "要查哪個服事表範圍？請選擇或直接回覆：下一場、本週、明天、主日。",
      {
        quickReplies: [
          { label: "下一場", action: { type: "message", label: "下一場", text: "下一場" } },
          { label: "本週", action: { type: "message", label: "本週", text: "本週" } },
          { label: "明天", action: { type: "message", label: "明天", text: "明天" } },
          { label: "主日", action: { type: "message", label: "主日", text: "主日服事" } }
        ]
      }
    );
    expect(replyText.mock.calls[1]?.[1]).toContain("下一場聚會服事表");
    expect(replyText.mock.calls[1]?.[1]).toContain("- 音控：資恆");
    expect(replyText.mock.calls[1]?.[1]).not.toContain("知樂");
  });
});

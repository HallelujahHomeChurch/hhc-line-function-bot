import { describe, expect, it, vi } from "vitest";

import { createFunctionRegistries } from "../functions/registry.js";
import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { AppConfig, FunctionRouterPort, GraphDriveClient, LineReplyClient } from "../types.js";

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
        webhookPath: "/line/helper/webhook",
        channelSecret: "channel-secret",
        channelAccessToken: "channel-token",
        allowedGroupIds: ["Cmain"],
        allowedUserIds: ["Uallowed"],
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "find_pop_sheet_music"]
      }
    ],
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

function lineBody(event: Record<string, unknown>) {
  return JSON.stringify({ destination: "bot", events: [event] });
}

function signedHeaders(body: string) {
  return {
    "content-type": "application/json",
    "x-line-signature": signLineBody(Buffer.from(body), "channel-secret")
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
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/amazing-grace")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route },
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
      url: "/line/helper/webhook",
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
      url: "/line/helper/webhook",
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
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/yesterday")
    };
    const config = testConfig();
    const registries = createFunctionRegistries(config, {
      graph,
      sessionStore: new InMemorySessionStore()
    });
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_pop_sheet_music",
      arguments: { query: "" },
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route },
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
      url: "/line/helper/webhook",
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
      url: "/line/helper/webhook",
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
});

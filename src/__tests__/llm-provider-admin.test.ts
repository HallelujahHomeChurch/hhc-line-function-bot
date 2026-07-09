import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import type { AppConfig, LineReplyClient } from "../types.js";

function config(): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    readyPath: "/readyz",
    maxBodyBytes: 32_768,
    profiles: [
      {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "helper-secret",
        channelAccessToken: "helper-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_service_schedule"],
        adminUserId: "Uroot",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        llmProvider: "deepseek",
        allowedProviders: ["ollama", "deepseek"],
        allowSubscriptionProviders: false
      }
    ],
    llm: {
      provider: "deepseek",
      fallbackProvider: "ollama",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,
      timeoutMs: 8000,
      keywordFallbackEnabled: true
    }
  };
}

function mainConfig(): AppConfig {
  const value = config();
  return {
    ...value,
    profiles: [
      {
        ...value.profiles[0],
        name: "main",
        webhookPath: "/api/line/webhook/main",
        llmProvider: "ollama",
        allowedProviders: ["ollama"]
      }
    ]
  };
}

function lineBody(event: Record<string, unknown>) {
  return JSON.stringify({ destination: "bot", events: [event] });
}

function signedHeaders(body: string, secret = "helper-secret") {
  return {
    "content-type": "application/json",
    "x-line-signature": signLineBody(Buffer.from(body), secret)
  };
}

describe("LLM provider admin commands", () => {
  it("reports the active DeepSeek provider without persisting a switch from LINE", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config(), {
      router: { route: vi.fn() },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/llm-use" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("active: deepseek");
    expect(replyText.mock.calls[0]?.[1]).toContain("available: ollama, deepseek");
  });

  it("lists only providers allowed by the current profile", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(mainConfig(), {
      router: { route: vi.fn() },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/llm-use" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("available: ollama");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("deepseek");
  });

  it("does not advertise provider login or logout commands", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config(), {
      router: { route: vi.fn() },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/help admin all" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("/llm-use");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/llm-login");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/llm-logout");
  });
});

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../server.js";
import { signLineBody } from "../line-signature.js";
import type { AppConfig, FunctionRouterPort, LineReplyClient } from "../types.js";

function testConfig(): AppConfig {
  return {
    serviceName: "hhc-line-function-bot",
    host: "127.0.0.1",
    port: 3000,
    healthPath: "/healthz",
    maxBodyBytes: 32_768,
    profiles: [
      {
        name: "main",
        webhookPath: "/line/main/webhook",
        channelSecret: "main-secret",
        channelAccessToken: "main-token",
        allowedGroupIds: ["Cmain"],
        allowedUserIds: ["Uallowed"],
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_service_schedule"]
      },
      {
        name: "slides",
        webhookPath: "/line/slides/webhook",
        channelSecret: "slides-secret",
        channelAccessToken: "slides-token",
        allowedGroupIds: ["Cslides"],
        allowedUserIds: [],
        allowDirectUser: false,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["slides"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides"]
      }
    ],
    llm: {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      timeoutMs: 8000,
      azureFallbackEnabled: true
    }
  };
}

function lineBody(event: Record<string, unknown>) {
  return JSON.stringify({ destination: "bot", events: [event] });
}

function signedHeaders(body: string, secret: string) {
  return {
    "content-type": "application/json",
    "x-line-signature": signLineBody(Buffer.from(body), secret)
  };
}

describe("LINE entrance", () => {
  it("rejects an invalid LINE signature for the selected profile", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createApp(testConfig(), { router });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: { "content-type": "application/json", "x-line-signature": "bad" },
      payload: body
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "invalid_line_signature" });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("selects the profile by webhook path and passes only enabled functions to the router", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cslides", userId: "U1" },
      message: { type: "text", text: "slides 找 主日 詩歌 ppt" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/slides/webhook",
      headers: signedHeaders(body, "slides-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]?.[0]).toMatchObject({
      profileName: "slides",
      enabledFunctions: ["find_ppt_slides"],
      text: "slides 找 主日 詩歌 ppt"
    });
    expect(replyText).toHaveBeenCalledWith("reply-token", "目前不支援這個請求。");
  });

  it("ignores a group message without wake word before calling the router", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createApp(testConfig(), { router });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "查一下服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: true, reason: "wake_word_missing" });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("allows a direct user without a wake word when the user is allowlisted", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const app = createApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
    });
    let body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "查這週服事表" }
    });

    body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "query service schedule" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]?.[0].source).toEqual({ type: "user", userId: "Uallowed" });
  });

  it("blocks non-text messages until the profile explicitly allows them", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createApp(testConfig(), { router });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "image", id: "image-1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "message_type_not_allowed"
    });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("reports profiles, enabled functions, and LLM status from healthz", async () => {
    const app = createApp(testConfig(), { router: { route: vi.fn() } });

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "hhc-line-function-bot",
      profiles: [
        { name: "main", enabledFunctions: ["find_ppt_slides", "query_service_schedule"] },
        { name: "slides", enabledFunctions: ["find_ppt_slides"] }
      ],
      llm: {
        primary: "ollama",
        model: "qwen3:4b-instruct",
        fallback: "azure_openai"
      }
    });
  });
});

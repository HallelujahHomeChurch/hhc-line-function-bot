import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import type {
  AppConfig,
  FunctionRouterPort,
  LineIdentityClient,
  LineReplyClient,
  TextMessageHandlerRegistry,
  PostbackHandlerRegistry
} from "../types.js";

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
        name: "main",
        webhookPath: "/line/main/webhook",
        channelSecret: "main-secret",
        channelAccessToken: "main-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
        adminUserId: "Uadmin",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed"
      },
      {
        name: "slides",
        webhookPath: "/line/slides/webhook",
        channelSecret: "slides-secret",
        channelAccessToken: "slides-token",
        allowDirectUser: false,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides"],
        adminDirectOnly: true,
        directAccessPolicy: "blocked",
        groupAccessPolicy: "managed"
      }
    ],
    llm: {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keywordFallbackEnabled: true
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

function defaultAccessStore(): InMemoryAccessStore {
  return new InMemoryAccessStore({
    principals: [
      {
        id: "principal-main-user",
        profileName: "main",
        type: "user",
        principalId: "Uallowed",
        createdAt: "2026-07-06T00:00:00.000Z",
        createdBy: "test"
      },
      {
        id: "principal-main-group",
        profileName: "main",
        type: "group",
        principalId: "Cmain",
        createdAt: "2026-07-06T00:00:00.000Z",
        createdBy: "test"
      },
      {
        id: "principal-slides-group",
        profileName: "slides",
        type: "group",
        principalId: "Cslides",
        createdAt: "2026-07-06T00:00:00.000Z",
        createdBy: "test"
      }
    ]
  });
}

function createTestApp(
  config: AppConfig,
  deps: Parameters<typeof createApp>[1]
): ReturnType<typeof createApp> {
  return createApp(config, {
    accessStore: defaultAccessStore(),
    ...deps
  });
}

function accessConfig(): AppConfig {
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
        channelSecret: "helper-secret",
        channelAccessToken: "helper-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
        adminUserId: "Uroot",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        registration: { enabled: true }
      },
      {
        name: "main",
        webhookPath: "/line/main-public/webhook",
        channelSecret: "main-secret",
        channelAccessToken: "main-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: ["query_service_schedule"],
        adminUserId: "Uroot",
        adminDirectOnly: true,
        directAccessPolicy: "public",
        groupAccessPolicy: "blocked",
        registration: { enabled: false }
      }
    ],
    llm: {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keywordFallbackEnabled: true
    },
    access: { registrationInviteCodeTtlMinutes: 60 }
  };
}

describe("LINE entrance", () => {
  it("rejects an invalid LINE signature for the selected profile", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createTestApp(testConfig(), { router });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
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

  it("selects the profile by webhook path and suggests only enabled quick replies on deny", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cslides", userId: "U1" },
      message: { type: "text", text: "小哈 不支援的要求" }
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
      text: "小哈 不支援的要求"
    });
    expect(replyText).toHaveBeenCalledWith("reply-token", "目前不支援這個請求，請改用下方功能。", {
      quickReplies: [
        {
          label: "查投影片",
          action: { type: "message", label: "查投影片", text: "小哈 查投影片" }
        }
      ]
    });
  });

  it("emits route and function observer events without raw message text", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "奇異恩典" },
      confidence: 0.94,
      provider: "ollama"
    });
    const findPptSlides = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "已找到詩歌投影片"
    });
    const routeObserver = vi.fn().mockResolvedValue(undefined);
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { find_ppt_slides: findPptSlides },
      routeObserver,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        profileName: "main",
        sourceType: "group",
        provider: "ollama",
        outcome: "execute",
        action: "find_ppt_slides",
        confidence: 0.94
      })
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "function_result",
        profileName: "main",
        action: "find_ppt_slides",
        ok: true
      })
    );
    const serializedEvents = JSON.stringify(routeObserver.mock.calls.map(([event]) => event));
    expect(serializedEvents).not.toContain("小哈 查投影片 奇異恩典");
  });

  it("emits fallback diagnostics when keyword routing is used after Ollama fails", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_service_schedule",
      arguments: { query: "服事表" },
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "ollama_unreachable"
    });
    const queryServiceSchedule = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "請問要查哪一場？"
    });
    const routeObserver = vi.fn().mockResolvedValue(undefined);
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { query_service_schedule: queryServiceSchedule },
      routeObserver,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈 查服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        provider: "keyword",
        outcome: "execute",
        action: "query_service_schedule",
        fallbackProvider: "ollama",
        fallbackReason: "ollama_unreachable"
      })
    );
  });

  it("ignores a group message without wake word before calling the router", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createTestApp(testConfig(), { router });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "查服事表" }
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
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
    });
    const body = lineBody({
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

  it("handles slash admin status in direct chat without calling the router", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/status" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Admin status");
    expect(replyText.mock.calls[0]?.[1]).toContain("profile: main");
    expect(replyText.mock.calls[0]?.[1]).toContain(
      "functions: find_ppt_slides, query_service_schedule"
    );
  });

  it("lists public commands and effective functions through help", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/help" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("小哈可以協助");
    expect(replyText.mock.calls[0]?.[1]).toContain("/registry <code>");
    expect(replyText.mock.calls[0]?.[1]).toContain("/whoami");
    expect(replyText.mock.calls[0]?.[1]).toContain("/help admin");
    expect(replyText.mock.calls[0]?.[1]).toContain("查投影片");
    expect(replyText.mock.calls[0]?.[1]).toContain("查服事表");
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.any(String),
      expect.objectContaining({
        quickReplies: expect.arrayContaining([
          expect.objectContaining({ label: "查投影片" }),
          expect.objectContaining({ label: "查服事表" })
        ])
      })
    );
  });

  it("lists common grouped admin commands through help admin", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      adminHandlers: {
        "refresh-sheet-music-cache": vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/help admin" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Admin commands");
    expect(replyText.mock.calls[0]?.[1]).toContain("/access-list [user|group|admin]");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/access-requests");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/access-approve");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/access-deny");
    expect(replyText.mock.calls[0]?.[1]).toContain("成員與群組");
    expect(replyText.mock.calls[0]?.[1]).toContain("/group-remove [groupId]");
    expect(replyText.mock.calls[0]?.[1]).toContain("查詢");
    expect(replyText.mock.calls[0]?.[1]).toContain("/audit-list [limit]");
    expect(replyText.mock.calls[0]?.[1]).toContain("/help admin all");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/status");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/route-test <text>");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/refresh-sheet-music-cache");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/remove-group");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/allow-group-remove");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/remove-this-group");
  });

  it("lists advanced grouped admin commands through help admin all", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      adminHandlers: {
        "refresh-sheet-music-cache": vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/help admin all" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("/invite-code-create");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/invite-code-list");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/invite-code-disable");
    expect(replyText.mock.calls[0]?.[1]).toContain("Superadmin");
    expect(replyText.mock.calls[0]?.[1]).toContain("/admin-add <userId>");
    expect(replyText.mock.calls[0]?.[1]).toContain("診斷");
    expect(replyText.mock.calls[0]?.[1]).toContain("/route-test <text>");
    expect(replyText.mock.calls[0]?.[1]).toContain("功能模組");
    expect(replyText.mock.calls[0]?.[1]).toContain("/refresh-sheet-music-cache");
    expect(replyText.mock.calls[0]?.[1]).toContain("/group-add <groupId> [name]");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/allow-group-add");
  });

  it("blocks help admin from non-admin users", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/help admin" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("reply-token", "你沒有權限使用 admin 指令。", undefined);
  });

  it("does not keep the old help-admin command", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/help-admin" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("目前不支援");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("Admin commands");
  });

  it("lets an admin remove a group by id through group-remove", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    const app = createTestApp(testConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/group-remove Cmain" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("已停用 group Cmain");
    await expect(accessStore.hasActivePrincipal("main", "group", "Cmain")).resolves.toBe(false);
  });

  it("lets an admin remove the current group from inside the group", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    const app = createTestApp(testConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "/group-remove" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("已停用此群組");
    await expect(accessStore.hasActivePrincipal("main", "group", "Cmain")).resolves.toBe(false);
  });

  it("lets an admin grant a function to the current group for the current profile", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_service_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    const app = createTestApp(config, {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    const grantBody = lineBody({
      type: "message",
      replyToken: "grant-reply",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "/function-grant find_ppt_slides" }
    });
    const routeBody = lineBody({
      type: "message",
      replyToken: "route-reply",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(grantBody, "main-secret"),
      payload: grantBody
    });
    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(routeBody, "main-secret"),
      payload: routeBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("已開放");
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_service_schedule", "find_ppt_slides"]
      })
    );
  });

  it("does not apply group function grants to direct users", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_service_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "function_disabled",
      provider: "router"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    await accessStore.addGroupFunctionGrant({
      profileName: "main",
      groupId: "Cmain",
      functionName: "find_ppt_slides",
      createdBy: "Uadmin"
    });
    const app = createTestApp(config, {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_service_schedule"]
      })
    );
  });

  it("keeps group function grants isolated by profile", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = [];
    config.profiles[1].enabledFunctions = [];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore({
      principals: [
        {
          id: "main-same-group",
          profileName: "main",
          type: "group",
          principalId: "Csame",
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "test"
        },
        {
          id: "slides-same-group",
          profileName: "slides",
          type: "group",
          principalId: "Csame",
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "test"
        }
      ]
    });
    await accessStore.addGroupFunctionGrant({
      profileName: "main",
      groupId: "Csame",
      functionName: "find_ppt_slides",
      createdBy: "Uadmin"
    });
    const app = createTestApp(config, {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Csame", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/slides/webhook",
      headers: signedHeaders(body, "slides-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "slides",
        enabledFunctions: []
      })
    );
  });

  it("does not keep the old group registration command", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const app = createTestApp(testConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Uadmin" },
      message: { type: "text", text: "/register-this-group 影音同工群" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("目前不支援");
    await expect(accessStore.listPrincipals("main")).resolves.toEqual([]);
  });

  it("introduces available functions when a group user only calls the bot name", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我是小哈");
    expect(replyText.mock.calls[0]?.[1]).toContain("教會同工小幫手");
    expect(replyText.mock.calls[0]?.[1]).toContain("聚會或詩歌需要的投影片");
    expect(replyText.mock.calls[0]?.[1]).toContain("近期聚會的服事安排");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("OneDrive");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("Notion");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("下載連結");
    expect(replyText.mock.calls[0]?.[1]).toContain("查投影片");
    expect(replyText.mock.calls[0]?.[1]).toContain("查服事表");
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.any(String),
      expect.objectContaining({
        quickReplies: expect.arrayContaining([
          expect.objectContaining({ label: "查投影片" }),
          expect.objectContaining({ label: "查服事表" })
        ])
      })
    );
  });

  it("introduces available functions in direct chat when the user asks for help", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "help" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我是小哈");
  });

  it("uses the router intro intent for direct greetings without falling through to deny", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "introduce_bot",
      provider: "ollama",
      confidence: 0.92,
      arguments: { greeting: "你好" }
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "你好" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "你好",
        enabledFunctions: ["find_ppt_slides", "query_service_schedule"]
      })
    );
    expect(replyText.mock.calls[0]?.[1]).toMatch(/^你好。\n我是小哈/);
    expect(replyText.mock.calls[0]?.[1]).toContain("教會同工小幫手");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("目前不支援");
  });

  it("introduces sheet music lookup without exposing storage details", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = [
      "find_ppt_slides",
      "query_service_schedule",
      "find_pop_sheet_music"
    ];
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("流行歌曲樂譜");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("OneDrive");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("下載連結");
  });

  it("denies slash admin commands from groups when direct-only admin is enabled", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "/status" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("reply-token", "你沒有權限使用 admin 指令。", undefined);
  });

  it("dispatches direct slash admin maintenance commands to configured handlers", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const refreshSheetMusicCache = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "已重新整理流行歌譜 cache。"
    });
    const app = createTestApp(testConfig(), {
      router: { route },
      adminHandlers: {
        "refresh-sheet-music-cache": refreshSheetMusicCache
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/refresh-sheet-music-cache" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(refreshSheetMusicCache).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ name: "main" }) })
    );
    expect(replyText).toHaveBeenCalledWith("reply-token", "已重新整理流行歌譜 cache。", undefined);
  });

  it("reports profile diagnostics through slash admin profile", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/profile" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Profile");
    expect(replyText.mock.calls[0]?.[1]).toContain("name: main");
    expect(replyText.mock.calls[0]?.[1]).toContain("source: user");
  });

  it("route-tests admin text without executing the selected function", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_service_schedule",
      arguments: { query: "服事表" },
      provider: "keyword"
    });
    const queryServiceSchedule = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "should not run"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { query_service_schedule: queryServiceSchedule },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/route-test 小哈 查服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        text: "小哈 查服事表"
      })
    );
    expect(queryServiceSchedule).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Route test");
    expect(replyText.mock.calls[0]?.[1]).toContain("action: query_service_schedule");
    expect(replyText.mock.calls[0]?.[1]).toContain("provider: keyword");
  });

  it("records function errors with request ids and exposes them to slash admin last-errors", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "奇異恩典" },
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: {
        find_ppt_slides: vi.fn().mockRejectedValue(new Error("graph unavailable"))
      },
      requestIdFactory: () => "req-test-1",
      createLineReplyClient: () => ({ replyText })
    });

    const userBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });
    await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(userBody, "main-secret"),
      payload: userBody
    });

    const adminBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/last-errors" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(adminBody, "main-secret"),
      payload: adminBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[1]?.[1]).toContain("Last errors");
    expect(replyText.mock.calls[1]?.[1]).toContain("req-test-1");
    expect(replyText.mock.calls[1]?.[1]).toContain("find_ppt_slides");
    expect(replyText.mock.calls[1]?.[1]).toContain("graph unavailable");
  });

  it("records route outcomes without raw query text and exposes them to slash admin last-routes", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "Amazing Grace", fileType: "ppt" },
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: {
        find_ppt_slides: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "done"
        })
      },
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("req-route-1")
        .mockReturnValueOnce("req-route-2"),
      createLineReplyClient: () => ({ replyText })
    });

    const userBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查 Amazing Grace 投影片" }
    });
    await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(userBody, "main-secret"),
      payload: userBody
    });

    const adminBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/last-routes" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(adminBody, "main-secret"),
      payload: adminBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[1]?.[1]).toContain("Last routes");
    expect(replyText.mock.calls[1]?.[1]).toContain("req-route-1");
    expect(replyText.mock.calls[1]?.[1]).toContain("find_ppt_slides");
    expect(replyText.mock.calls[1]?.[1]).toContain("provider=ollama");
    expect(replyText.mock.calls[1]?.[1]).toContain("query=present");
    expect(replyText.mock.calls[1]?.[1]).toContain("ok=true");
    expect(replyText.mock.calls[1]?.[1]).not.toContain("Amazing Grace");
  });

  it("rate limits repeated events for the same profile and source before routing", async () => {
    const config = testConfig();
    config.rateLimit = { enabled: true, windowMs: 60_000, maxRequests: 1 };
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const event = {
      type: "message",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 不支援" }
    };

    const firstBody = lineBody({ ...event, replyToken: "reply-token-1" });
    const secondBody = lineBody({ ...event, replyToken: "reply-token-2" });
    await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(firstBody, "main-secret"),
      payload: firstBody
    });
    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(secondBody, "main-secret"),
      payload: secondBody
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(replyText.mock.calls[1]?.[1]).toBe("你傳得太快了，請稍後再試。");
  });

  it("denies slash admin commands from non-admin direct users without routing", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Ustranger" },
      message: { type: "text", text: "/status" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("reply-token", "你沒有權限使用 admin 指令。", undefined);
  });

  it("prompts managed direct users to register before routing", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "小哈 查服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "你尚未開通小哈，請先找管理員協助註冊。",
      undefined
    );
  });

  it("prompts unregistered groups to ask an admin to register when the bot is addressed", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "小哈 查服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "這個群組還沒有開通小哈，請先找管理員協助註冊。",
      undefined
    );
  });

  it("keeps quiet in unregistered groups when the bot is not addressed", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "查服事表" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: true, reason: "group_not_allowed" });
    expect(route).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("registers direct users immediately with a one-time invite code", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "HHCTEST",
      now: () => new Date("2026-07-07T00:30:00.000Z")
    });
    await registrationInviteCodeStore.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 60,
      now: new Date("2026-07-07T00:00:00.000Z")
    });
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn().mockResolvedValue("Ray from LINE"),
      getGroupDisplayName: vi.fn()
    };
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/registry HHCTEST Manual Ray" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(identityClient.getUserDisplayName).toHaveBeenCalledWith("Unew");
    await expect(accessStore.hasActivePrincipal("helper", "user", "Unew")).resolves.toBe(true);
    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      {
        type: "user",
        principalId: "Unew",
        displayName: "Ray from LINE"
      }
    ]);
    await expect(registrationInviteCodeStore.consume("helper", "HHCTEST")).resolves.toBe(false);
  });

  it("registers groups immediately with a one-time invite code and LINE group name", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "HHCGROUP",
      now: () => new Date("2026-07-07T00:30:00.000Z")
    });
    await registrationInviteCodeStore.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 60,
      now: new Date("2026-07-07T00:00:00.000Z")
    });
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn(),
      getGroupDisplayName: vi.fn().mockResolvedValue("LINE 影音同工群")
    };
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "/registry HHCGROUP Manual Group Name" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(identityClient.getGroupDisplayName).toHaveBeenCalledWith("Cnew");
    await expect(accessStore.hasActivePrincipal("helper", "group", "Cnew")).resolves.toBe(true);
    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      {
        type: "group",
        principalId: "Cnew",
        displayName: "LINE 影音同工群"
      }
    ]);
    expect(accessStore.audit).toMatchObject([
      { action: "access.group.registry", targetType: "group", targetId: "Cnew" }
    ]);
  });

  it("does not let admins register the current group without an invite code", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cadmin", userId: "Uroot" },
      message: { type: "text", text: "/register 影音同工群" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    await expect(accessStore.hasActivePrincipal("helper", "group", "Cadmin")).resolves.toBe(false);
    expect(accessStore.audit).toEqual([]);
  });

  it("lets admins create a copyable invite code that can be consumed once", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINCODE"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText })
    });

    const createBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/invite-code-create" }
    });
    const createRes = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(createBody, "helper-secret"),
      payload: createBody
    });

    expect(createRes.statusCode).toBe(200);
    const createReply = String(replyText.mock.calls[0]?.[1]);
    expect(createReply).toContain("/registry ADMINCODE");
    expect(createReply.split("\n")).toContain("/registry ADMINCODE");

    const registerBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/registry ADMINCODE" }
    });
    const registerRes = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(registerBody, "helper-secret"),
      payload: registerBody
    });

    expect(registerRes.statusCode).toBe(200);
    await expect(accessStore.hasActivePrincipal("helper", "user", "Unew")).resolves.toBe(true);
    await expect(registrationInviteCodeStore.consume("helper", "ADMINCODE")).resolves.toBe(false);
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "invite_code.create",
          metadata: { ttlMinutes: 60 }
        })
      ])
    );
  });

  it("rejects legacy registration and approval commands", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    for (const [index, command] of [
      "/register CODE Ray",
      "/access-requests",
      "/access-approve req-1",
      "/access-deny req-1",
      "/invite-code-list",
      "/invite-code-disable code-1"
    ].entries()) {
      const body = lineBody({
        type: "message",
        replyToken: `reply-token-${index}`,
        source: { type: "user", userId: "Uroot" },
        message: { type: "text", text: command }
      });
      const res = await app.inject({
        method: "POST",
        url: "/line/helper/webhook",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });
      expect(res.statusCode).toBe(200);
    }

    expect(route).not.toHaveBeenCalled();
    await expect(accessStore.listPrincipals("helper")).resolves.toEqual([]);
  });

  it("does not process legacy access review postbacks", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      postback: { data: "action=access_approve&requestId=req-1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith("reply-token", expect.any(String), undefined);
    await expect(accessStore.listPrincipals("helper")).resolves.toEqual([]);
  });
  it("filters the access list by principal type", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "user",
      principalId: "Uallowed",
      displayName: "Ray",
      createdBy: "Uroot"
    });
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Callowed",
      displayName: "影音同工群",
      createdBy: "Uroot"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/access-list group" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("group: Callowed");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("user: Uallowed");
  });

  it("lists recent access audit events with a capped limit", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    await accessStore.recordAudit({
      profileName: "helper",
      actorUserId: "Uroot",
      action: "access.group.registry",
      targetType: "group",
      targetId: "Cnew"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/audit-list 50" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("Audit events");
    expect(replyText.mock.calls[0]?.[1]).toContain("access.group.registry");
    expect(replyText.mock.calls[0]?.[1]).toContain("target=group:Cnew");
  });

  it("allows public direct profiles without static allowlists and blocks their groups", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore: new InMemoryAccessStore(),
      createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
    });

    const directBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uany" },
      message: { type: "text", text: "查服事表" }
    });
    const directRes = await app.inject({
      method: "POST",
      url: "/line/main-public/webhook",
      headers: signedHeaders(directBody, "main-secret"),
      payload: directBody
    });

    const groupBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cblocked", userId: "Uany" },
      message: { type: "text", text: "查服事表" }
    });
    const groupRes = await app.inject({
      method: "POST",
      url: "/line/main-public/webhook",
      headers: signedHeaders(groupBody, "main-secret"),
      payload: groupBody
    });

    expect(directRes.statusCode).toBe(200);
    expect(groupRes.statusCode).toBe(200);
    expect(groupRes.json()).toMatchObject({ ok: true, ignored: true, reason: "group_blocked" });
    expect(route).toHaveBeenCalledOnce();
  });

  it("limits admin management to the single bootstrap superadmin", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "admin",
      principalId: "Uadmin2",
      createdBy: "Uroot"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    const deniedBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uadmin2" },
      message: { type: "text", text: "/admin-add Unewadmin" }
    });
    await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(deniedBody, "helper-secret"),
      payload: deniedBody
    });

    const allowedBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/admin-add Unewadmin" }
    });
    await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(allowedBody, "helper-secret"),
      payload: allowedBody
    });

    expect(replyText.mock.calls[0]?.[1]).toContain("只有 superadmin");
    expect(replyText.mock.calls[1]?.[1]).toContain("已加入 admin");
    await expect(accessStore.hasActivePrincipal("helper", "admin", "Unewadmin")).resolves.toBe(
      true
    );
  });

  it("blocks non-text messages until the profile explicitly allows them", async () => {
    const router: FunctionRouterPort = { route: vi.fn() };
    const app = createTestApp(testConfig(), { router });
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

  it("allows postback events for allowlisted groups and dispatches by action", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const handleSelect = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "已選擇第 1 個投影片"
    });
    const postbackHandlers: PostbackHandlerRegistry = {
      select_ppt: handleSelect
    };
    const app = createTestApp(testConfig(), {
      router: { route: vi.fn() },
      postbackHandlers,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      postback: { data: "action=select_ppt&requestId=req-1&index=0" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(handleSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "select_ppt",
        params: expect.objectContaining({ requestId: "req-1", index: "0" })
      }),
      expect.objectContaining({
        profile: expect.objectContaining({ name: "main" }),
        event: expect.objectContaining({ replyToken: "reply-token" })
      })
    );
    expect(replyText).toHaveBeenCalledWith("reply-token", "已選擇第 1 個投影片", undefined);
  });

  it("handles numeric PPT selections in groups without routing them", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const matchesNumericSelection = vi.fn().mockReturnValue(true);
    const handleNumericSelection = vi.fn().mockResolvedValue({
      ok: true,
      replyText:
        "已找到詩歌投影片：\n奇異恩典.pptx\n下載連結（1 天內有效）：\nhttps://download.invalid/1"
    });
    const textMessageHandlers: TextMessageHandlerRegistry = {
      ppt_numeric_selection: {
        matches: matchesNumericSelection,
        handle: handleNumericSelection
      }
    };
    const app = createTestApp(testConfig(), {
      router: { route },
      textMessageHandlers,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(matchesNumericSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "1"
      }),
      expect.objectContaining({
        profile: expect.objectContaining({ name: "main" }),
        event: expect.objectContaining({ replyToken: "reply-token" })
      })
    );
    expect(handleNumericSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "1"
      }),
      expect.objectContaining({
        profile: expect.objectContaining({ name: "main" }),
        event: expect.objectContaining({ replyToken: "reply-token" })
      })
    );
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "已找到詩歌投影片：\n奇異恩典.pptx\n下載連結（1 天內有效）：\nhttps://download.invalid/1",
      undefined
    );
  });

  it("ignores numeric group messages without an active text-message handler result", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const matchesNumericSelection = vi.fn().mockReturnValue(true);
    const handleNumericSelection = vi.fn().mockResolvedValue(undefined);
    const textMessageHandlers: TextMessageHandlerRegistry = {
      ppt_numeric_selection: {
        matches: matchesNumericSelection,
        handle: handleNumericSelection
      }
    };
    const app = createTestApp(testConfig(), {
      router: { route },
      textMessageHandlers,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(handleNumericSelection).toHaveBeenCalledOnce();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("reports profiles, enabled functions, and LLM status from healthz", async () => {
    const app = createTestApp(testConfig(), { router: { route: vi.fn() } });

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "hhc-line-function-bot",
      timeZone: "Asia/Taipei",
      profiles: [
        { name: "main", enabledFunctions: ["find_ppt_slides", "query_service_schedule"] },
        { name: "slides", enabledFunctions: ["find_ppt_slides"] }
      ],
      llm: {
        primary: "ollama",
        model: "qwen3:4b-instruct",
        fallback: "keyword"
      }
    });
  });
});

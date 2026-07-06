import { describe, expect, it, vi } from "vitest";

import { hashInviteCode } from "../access/invite-code.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
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
        registration: { enabled: true, inviteCodeRequired: true }
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
        registration: { enabled: false, inviteCodeRequired: true }
      }
    ],
    llm: {
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keywordFallbackEnabled: true
    },
    access: { inviteCodeSecret: "invite-secret" }
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

  it("lists common grouped admin commands through help-admin", async () => {
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
    expect(replyText.mock.calls[0]?.[1]).toContain("Admin commands");
    expect(replyText.mock.calls[0]?.[1]).toContain("申請審核");
    expect(replyText.mock.calls[0]?.[1]).toContain("/access-requests [user|group]");
    expect(replyText.mock.calls[0]?.[1]).toContain("成員與群組");
    expect(replyText.mock.calls[0]?.[1]).toContain("/group-remove [groupId]");
    expect(replyText.mock.calls[0]?.[1]).toContain("查詢");
    expect(replyText.mock.calls[0]?.[1]).toContain("/audit-list [limit]");
    expect(replyText.mock.calls[0]?.[1]).toContain("/help-admin all");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/status");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/route-test <text>");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/refresh-sheet-music-cache");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/remove-group");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/allow-group-remove");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/remove-this-group");
  });

  it("lists advanced grouped admin commands through help-admin all", async () => {
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
      message: { type: "text", text: "/help-admin all" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/main/webhook",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("邀請碼");
    expect(replyText.mock.calls[0]?.[1]).toContain(
      "/invite-code-create <code> [maxUses] [expiresDays]"
    );
    expect(replyText.mock.calls[0]?.[1]).toContain("Superadmin");
    expect(replyText.mock.calls[0]?.[1]).toContain("/admin-add <userId>");
    expect(replyText.mock.calls[0]?.[1]).toContain("診斷");
    expect(replyText.mock.calls[0]?.[1]).toContain("/route-test <text>");
    expect(replyText.mock.calls[0]?.[1]).toContain("功能模組");
    expect(replyText.mock.calls[0]?.[1]).toContain("/refresh-sheet-music-cache");
    expect(replyText.mock.calls[0]?.[1]).toContain("/group-add <groupId> [name]");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/allow-group-add");
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
    expect(replyText.mock.calls[0]?.[1]).toContain("尚未開通");
    expect(replyText.mock.calls[0]?.[1]).toContain("/register");
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
    expect(replyText.mock.calls[0]?.[1]).toContain("管理員");
    expect(replyText.mock.calls[0]?.[1]).toContain("/register");
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

  it("creates a pending registration request through an invite code", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore({
      inviteCodes: [
        {
          id: "invite-1",
          profileName: "helper",
          codeHash: hashInviteCode("HHCTEST", "invite-secret"),
          maxUses: 10,
          usedCount: 0,
          expiresAt: undefined,
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "Uroot",
          disabledAt: undefined
        }
      ]
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/register HHCTEST Ray" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("已送出申請");
    await expect(accessStore.countPendingRequests("helper")).resolves.toBe(1);
  });

  it("uses the LINE profile display name for direct registration when no name is provided", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn().mockResolvedValue("Ray from LINE"),
      getGroupDisplayName: vi.fn()
    };
    const accessStore = new InMemoryAccessStore({
      inviteCodes: [
        {
          id: "invite-1",
          profileName: "helper",
          codeHash: hashInviteCode("HHCTEST", "invite-secret"),
          maxUses: 10,
          usedCount: 0,
          expiresAt: undefined,
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "Uroot",
          disabledAt: undefined
        }
      ]
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/register HHCTEST" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(identityClient.getUserDisplayName).toHaveBeenCalledWith("Unew");
    await expect(accessStore.listPendingRequests("helper")).resolves.toMatchObject([
      {
        sourceType: "user",
        sourceId: "Unew",
        displayName: "Ray from LINE"
      }
    ]);
  });

  it("keeps an explicitly provided direct registration name before the LINE profile name", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn().mockResolvedValue("Ray from LINE"),
      getGroupDisplayName: vi.fn()
    };
    const accessStore = new InMemoryAccessStore({
      inviteCodes: [
        {
          id: "invite-1",
          profileName: "helper",
          codeHash: hashInviteCode("HHCTEST", "invite-secret"),
          maxUses: 10,
          usedCount: 0,
          expiresAt: undefined,
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "Uroot",
          disabledAt: undefined
        }
      ]
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/register HHCTEST Manual Ray" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(identityClient.getUserDisplayName).not.toHaveBeenCalled();
    await expect(accessStore.listPendingRequests("helper")).resolves.toMatchObject([
      {
        sourceType: "user",
        sourceId: "Unew",
        displayName: "Manual Ray"
      }
    ]);
  });

  it("creates a pending group registration request from an unregistered group", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore({
      inviteCodes: [
        {
          id: "invite-1",
          profileName: "helper",
          codeHash: hashInviteCode("HHCGROUP", "invite-secret"),
          maxUses: 10,
          usedCount: 0,
          expiresAt: undefined,
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "Uroot",
          disabledAt: undefined
        }
      ]
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "/register HHCGROUP 影音同工群" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("已送出申請");
    await expect(accessStore.listPendingRequests("helper")).resolves.toMatchObject([
      {
        sourceType: "group",
        sourceId: "Cnew",
        displayName: "影音同工群",
        requestedBy: "Unew"
      }
    ]);
  });

  it("uses the LINE group summary name for group registration when no name is provided", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn(),
      getGroupDisplayName: vi.fn().mockResolvedValue("LINE 影音同工群")
    };
    const accessStore = new InMemoryAccessStore({
      inviteCodes: [
        {
          id: "invite-1",
          profileName: "helper",
          codeHash: hashInviteCode("HHCGROUP", "invite-secret"),
          maxUses: 10,
          usedCount: 0,
          expiresAt: undefined,
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "Uroot",
          disabledAt: undefined
        }
      ]
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "/register HHCGROUP" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(identityClient.getGroupDisplayName).toHaveBeenCalledWith("Cnew");
    await expect(accessStore.listPendingRequests("helper")).resolves.toMatchObject([
      {
        sourceType: "group",
        sourceId: "Cnew",
        displayName: "LINE 影音同工群"
      }
    ]);
  });

  it("uses the LINE group summary name when an admin registers a group without a name", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn(),
      getGroupDisplayName: vi.fn().mockResolvedValue("LINE Admin Group")
    };
    const accessStore = new InMemoryAccessStore();
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cadmin", userId: "Uroot" },
      message: { type: "text", text: "/register" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(identityClient.getGroupDisplayName).toHaveBeenCalledWith("Cadmin");
    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      {
        type: "group",
        principalId: "Cadmin",
        displayName: "LINE Admin Group"
      }
    ]);
  });

  it("lets an admin register the current group directly without an invite code", async () => {
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
    expect(replyText.mock.calls[0]?.[1]).toContain("已開通此群組");
    await expect(accessStore.hasActivePrincipal("helper", "group", "Cadmin")).resolves.toBe(true);
    await expect(accessStore.countPendingRequests("helper")).resolves.toBe(0);
    expect(accessStore.audit).toMatchObject([
      { action: "access.group.register_admin", targetType: "group", targetId: "Cadmin" }
    ]);
  });

  it("lets admins create invite codes without storing the plain code", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    const createBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/invite-code-create HELLO 3 7" }
    });
    await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(createBody, "helper-secret"),
      payload: createBody
    });

    const registerBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/register HELLO Ray" }
    });
    const registerRes = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(registerBody, "helper-secret"),
      payload: registerBody
    });

    expect(registerRes.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("Invite code created");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("HELLO");
    expect(replyText.mock.calls[1]?.[1]).toContain("已送出申請");
    await expect(accessStore.countPendingRequests("helper")).resolves.toBe(1);
  });

  it("lets an admin review and approve pending registration requests", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const { request } = await accessStore.createAccessRequest({
      profileName: "helper",
      sourceType: "user",
      sourceId: "Unew",
      displayName: "Ray",
      requestedBy: "Unew"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    const listBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/access-requests" }
    });
    await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(listBody, "helper-secret"),
      payload: listBody
    });

    const approveBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: `/access-approve ${request.id}` }
    });
    const approveRes = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(approveBody, "helper-secret"),
      payload: approveBody
    });

    expect(approveRes.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain(request.id);
    expect(replyText.mock.calls[1]?.[1]).toContain("已核准");
    await expect(accessStore.hasActivePrincipal("helper", "user", "Unew")).resolves.toBe(true);
  });

  it("filters pending access requests and attaches approve/deny postbacks", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    await accessStore.createAccessRequest({
      profileName: "helper",
      sourceType: "user",
      sourceId: "Unew",
      displayName: "Ray",
      requestedBy: "Unew"
    });
    const { request } = await accessStore.createAccessRequest({
      profileName: "helper",
      sourceType: "group",
      sourceId: "Cnew",
      displayName: "影音同工群",
      requestedBy: "Unew"
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
      message: { type: "text", text: "/access-requests group" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("group:Cnew");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("user:Unew");
    expect(replyText.mock.calls[0]?.[2]).toMatchObject({
      quickReplies: expect.arrayContaining([
        expect.objectContaining({
          label: "核准 1",
          action: expect.objectContaining({
            type: "postback",
            data: `action=access_approve&requestId=${request.id}`
          })
        }),
        expect.objectContaining({
          label: "拒絕 1",
          action: expect.objectContaining({
            type: "postback",
            data: `action=access_deny&requestId=${request.id}`
          })
        })
      ])
    });
  });

  it("approves access requests from admin postbacks", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const { request } = await accessStore.createAccessRequest({
      profileName: "helper",
      sourceType: "group",
      sourceId: "Cnew",
      displayName: "影音同工群",
      requestedBy: "Unew"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      postback: { data: `action=access_approve&requestId=${request.id}` }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("已核准 group:Cnew");
    await expect(accessStore.hasActivePrincipal("helper", "group", "Cnew")).resolves.toBe(true);
  });

  it("denies access requests from admin postbacks", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const { request } = await accessStore.createAccessRequest({
      profileName: "helper",
      sourceType: "user",
      sourceId: "Unew",
      displayName: "Ray",
      requestedBy: "Unew"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      postback: { data: `action=access_deny&requestId=${request.id}` }
    });

    const res = await app.inject({
      method: "POST",
      url: "/line/helper/webhook",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("已拒絕 user:Unew");
    await expect(accessStore.countPendingRequests("helper")).resolves.toBe(0);
    await expect(accessStore.hasActivePrincipal("helper", "user", "Unew")).resolves.toBe(false);
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
      action: "access.group.register_admin",
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
    expect(replyText.mock.calls[0]?.[1]).toContain("access.group.register_admin");
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

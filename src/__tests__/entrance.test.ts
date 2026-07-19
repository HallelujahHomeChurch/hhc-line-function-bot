import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import type { ControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createFindPptSlidesHandler } from "../functions/find-ppt-slides.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { signLineBody } from "../line-signature.js";
import { createApp } from "../server.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  AppConfig,
  FunctionExecutionResult,
  FunctionRouterPort,
  GraphDriveClient,
  LineIdentityClient,
  LineReplyClient,
  TextMessageHandlerRegistry,
  PostbackHandlerRegistry,
  TextGenerationProvider
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
        webhookPath: "/api/line/webhook/main",
        channelSecret: "main-secret",
        channelAccessToken: "main-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_schedule"],
        adminUserId: "Uadmin",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed"
      },
      {
        name: "slides",
        webhookPath: "/api/line/webhook/slides",
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
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,
      timeoutMs: 8000
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
  const legacyRouter = (deps as Parameters<typeof createApp>[1] & { router?: FunctionRouterPort })
    .router;
  return createApp(config, {
    accessStore: defaultAccessStore(),
    ...deps,
    controlledAgentRouter:
      deps.controlledAgentRouter ??
      (legacyRouter
        ? {
            async resolve(input) {
              const route = await legacyRouter.route({
                profileName: input.profileName,
                text: input.text,
                enabledFunctions: [...input.enabledFunctions],
                source:
                  input.sourceType === "group"
                    ? { type: "group", groupId: "test-group", userId: "test-user" }
                    : { type: "user", userId: "test-user" }
              });
              if (route.type === "deny") {
                return { disposition: "deny", reasonCode: "planner_denied" } as const;
              }
              if (route.type === "respond") {
                return { disposition: "chat", reasonCode: "no_capability_evidence" } as const;
              }
              return {
                disposition: "execute",
                capability: route.action,
                arguments: route.arguments,
                reasonCode: "explicit_intent"
              } as const;
            }
          }
        : undefined)
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
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "helper-secret",
        channelAccessToken: "helper-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["find_ppt_slides", "query_schedule"],
        adminUserId: "Uroot",
        adminDirectOnly: true,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        registration: { enabled: true }
      },
      {
        name: "main",
        webhookPath: "/api/line/webhook/main-public",
        channelSecret: "main-secret",
        channelAccessToken: "main-token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: ["query_schedule"],
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
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000,
      timeoutMs: 8000
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
      url: "/api/line/webhook/main",
      headers: { "content-type": "application/json", "x-line-signature": "bad" },
      payload: body
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "invalid_line_signature" });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("selects the profile by webhook path without exposing functions on deny", async () => {
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
      url: "/api/line/webhook/slides",
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
    expect(replyText).toHaveBeenCalledWith("reply-token", "目前不支援這個請求。", undefined);
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
      replyText: "已找到詩歌投影片",
      diagnostics: {
        executionMode: "catalog_snapshot_read",
        stateAgeBucket: "under_10m",
        freshnessStatus: "fresh"
      }
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        profileName: "configured",
        sourceType: "group",
        provider: "router",
        outcome: "execute",
        action: "find_ppt_slides"
      })
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "function_result",
        profileName: "configured",
        action: "find_ppt_slides",
        ok: true,
        executionMode: "catalog_snapshot_read",
        stateAgeBucket: "under_10m",
        freshnessStatus: "fresh"
      })
    );
    const serializedEvents = JSON.stringify(routeObserver.mock.calls.map(([event]) => event));
    expect(serializedEvents).not.toContain("小哈 查投影片 奇異恩典");
  });

  it("does not execute a duplicate function request while the same query is in flight", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "奇異恩典" },
      provider: "ollama"
    });
    let resolveFirst: (result: FunctionExecutionResult) => void = () => undefined;
    const firstResult = new Promise<FunctionExecutionResult>((resolve) => {
      resolveFirst = resolve;
    });
    const findPptSlides = vi.fn().mockImplementation(() => {
      if (findPptSlides.mock.calls.length === 1) {
        return firstResult;
      }
      return Promise.resolve({ ok: true, replyText: "second result" });
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identity: LineIdentityClient = {
      getUserDisplayName: vi
        .fn()
        .mockImplementation(async (userId: string) => (userId === "U1" ? "Ray" : undefined)),
      getGroupDisplayName: vi.fn()
    };
    const routeObserver = vi.fn().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { find_ppt_slides: findPptSlides },
      routeObserver,
      createLineIdentityClient: () => identity,
      createLineReplyClient: () => ({ replyText })
    });
    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });
    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-2",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const firstRequest = app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(firstBody, "main-secret"),
      payload: firstBody
    });
    await vi.waitFor(() => expect(findPptSlides).toHaveBeenCalledTimes(1));
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(secondBody, "main-secret"),
      payload: secondBody
    });
    resolveFirst({ ok: true, replyText: "first result" });
    await firstRequest;

    expect(secondResponse.statusCode).toBe(200);
    expect(findPptSlides).toHaveBeenCalledTimes(1);
    expect(replyText).toHaveBeenCalledWith(
      "reply-2",
      "Ray，我還在找這個，等我一下就好。",
      undefined
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "function_result",
        action: "find_ppt_slides",
        ok: false,
        dedup: "busy"
      })
    );
  });

  it("softly personalizes group clarification replies with the requester display name", async () => {
    const sessionStore = new InMemorySessionStore();
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "ollama"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn()
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identity: LineIdentityClient = {
      getUserDisplayName: vi.fn().mockResolvedValue("Ray"),
      getGroupDisplayName: vi.fn()
    };
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: {
        find_ppt_slides: createFindPptSlidesHandler({
          graph,
          driveId: "drive-id",
          folderItemId: "folder-id",
          allowedExtensions: [".pptx"],
          defaultIncludePdf: false,
          sessionStore,
          requestIdFactory: () => "pending-1"
        })
      },
      createLineIdentityClient: () => identity,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "Ray，要查哪一份投影片？請直接回覆名稱。",
      undefined
    );
    await expect(sessionStore.get("pending-1")).resolves.toMatchObject({
      requesterUserId: "U1"
    });
  });

  it("does not execute a redelivered LINE webhook event twice", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "奇異恩典" },
      provider: "ollama"
    });
    const findPptSlides = vi.fn().mockResolvedValue({ ok: true, replyText: "result" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { find_ppt_slides: findPptSlides },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "evt-duplicate-1",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(findPptSlides).toHaveBeenCalledTimes(1);
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(second.json()).toMatchObject({
      ok: true,
      ignored: "duplicate_webhook_event"
    });
  });

  it("does not let another group member answer someone else's pending clarification", async () => {
    const sessionStore = new InMemorySessionStore();
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "find_ppt_slides",
      arguments: { query: "" },
      provider: "ollama"
    });
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn().mockResolvedValue([{ id: "1", name: "奇異恩典.pptx" }]),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/1")
    };
    const handler = createFindPptSlidesHandler({
      graph,
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pptx"],
      defaultIncludePdf: false,
      sessionStore,
      requestIdFactory: () => "pending-1"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      functionRegistry: { find_ppt_slides: handler },
      textMessageHandlers: {
        pending_function_answer: createPendingFunctionTextMessageHandler({
          sessionStore,
          functions: { find_ppt_slides: handler }
        })
      },
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(firstBody, "main-secret"),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-2",
      source: { type: "group", groupId: "Cmain", userId: "U2" },
      message: { type: "text", text: "奇異恩典" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(secondBody, "main-secret"),
      payload: secondBody
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "wake_word_missing"
    });
    expect(graph.listFolderChildren).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledTimes(1);
  });

  it("emits controlled routing diagnostics for a function execution", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "execute",
      action: "query_schedule",
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
      functionRegistry: { query_schedule: queryServiceSchedule },
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        provider: "router",
        outcome: "execute",
        action: "query_schedule"
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: true, reason: "wake_word_missing" });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("ignores third-person group mentions of the bot before calling the router", async () => {
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
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "因為以前高雄淑芬姐待的教會叫小哈。" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: true, reason: "group_not_addressed" });
    expect(route).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("answers addressed group small talk with a controlled reply before routing", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const routeObserver = vi.fn().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      routeObserver,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈，你會覺得我們這樣很難為你嗎" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("不會啦");
    expect(replyText.mock.calls[0]?.[1]).toContain("安靜");
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "route",
        outcome: "respond",
        action: "small_talk",
        engagement: "small_talk",
        smallTalkCategory: "reassurance"
      })
    );
  });

  it("uses controlled LLM small talk for addressed group chat when enabled by profile", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      smallTalk: { mode: "llm", maxChars: 80 }
    };
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("我在，謝謝你關心，需要查資料再叫我就好。");
    const app = createTestApp(config, {
      router: { route },
      textGenerator: { completeText },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈你好嗎" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        text: "小哈你好嗎",
        category: "wellbeing",
        maxChars: 80
      })
    );
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "我在，謝謝你關心，需要查資料再叫我就好。",
      undefined
    );
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]?.[0]).toMatchObject({ text: "query service schedule" });
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Admin status");
    expect(replyText.mock.calls[0]?.[1]).toContain("profile: main");
    expect(replyText.mock.calls[0]?.[1]).toContain("functions: find_ppt_slides, query_schedule");
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我可以協助");
    expect(replyText.mock.calls[0]?.[1]).toContain("/registry <code>");
    expect(replyText.mock.calls[0]?.[1]).toContain("/whoami");
    expect(replyText.mock.calls[0]?.[1]).toContain("/help admin");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("查投影片");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("查服事表");
    expect(replyText).toHaveBeenCalledWith("reply-token", expect.any(String), undefined);
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("/invite-code-create");
    expect(replyText.mock.calls[0]?.[1]).toContain("/confirm <code>");
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

  it("confirms admin actions through slash command", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const adminActionRegistry = {
      execute: vi.fn(),
      confirm: vi.fn().mockResolvedValue({
        ok: true,
        replyText: "confirmed"
      })
    };
    const app = createTestApp(testConfig(), {
      router: { route },
      adminActionRegistry,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/confirm CONFIRM1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(adminActionRegistry.confirm).toHaveBeenCalledWith({
      code: "CONFIRM1",
      profile: expect.objectContaining({ name: "main" }),
      event: expect.objectContaining({ replyToken: "reply-token" })
    });
    expect(replyText).toHaveBeenCalledWith("reply-token", "confirmed", undefined);
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
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
    config.profiles[0].enabledFunctions = ["query_schedule"];
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(grantBody, "main-secret"),
      payload: grantBody
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(routeBody, "main-secret"),
      payload: routeBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("已開放");
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule", "find_ppt_slides"]
      })
    );
  });

  it.each(["save_schedule", "save_memory"])(
    "rejects slash-command group grants for user-scoped write function %s",
    async (functionName) => {
      const config = testConfig();
      config.profiles[0].enabledFunctions = ["query_schedule", functionName] as never;
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const accessStore = defaultAccessStore();
      const app = createTestApp(config, {
        router: { route: vi.fn() },
        accessStore,
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "message",
        replyToken: "grant-reply",
        source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
        message: { type: "text", text: `/function-grant ${functionName}` }
      });

      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(replyText.mock.calls[0]?.[1]).toContain("只能開放給指定使用者");
      await expect(accessStore.listGroupFunctionGrants("main", "Cmain")).resolves.toEqual([]);
    }
  );

  it.each([
    ["save_memory", ["retrieve_memory", "save_memory"]],
    ["save_schedule", ["query_schedule", "save_schedule"]]
  ] as const)(
    "applies a %s user grant when the requester uses a registered group",
    async (functionName, profileFunctions) => {
      const config = testConfig();
      config.profiles[0].enabledFunctions = [...profileFunctions];
      const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
        type: "deny",
        reason: "not_matched",
        provider: "ollama"
      });
      const accessStore = defaultAccessStore();
      await accessStore.addUserFunctionGrant({
        profileName: "main",
        userId: "Uallowed",
        functionName,
        createdBy: "Uadmin"
      });
      const app = createTestApp(config, {
        router: { route },
        accessStore,
        createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
      });
      const body = lineBody({
        type: "message",
        replyToken: "route-reply",
        source: { type: "group", groupId: "Cmain", userId: "Uallowed" },
        message: { type: "text", text: "小哈幫我記住服事表" }
      });

      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(route).toHaveBeenCalledWith(
        expect.objectContaining({ enabledFunctions: [...profileFunctions] })
      );
    }
  );

  it("passes only the effective requester grants and source to enabled controlled routing", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      enabledFunctions: ["query_schedule"],
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    };
    const legacyRoute = vi.fn<FunctionRouterPort["route"]>();
    const resolve = vi.fn<ControlledAgentRouter["resolve"]>().mockResolvedValue({
      disposition: "deny",
      reasonCode: "planner_denied"
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
      router: { route: legacyRoute },
      controlledAgentRouter: { resolve },
      accessStore,
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule", "find_ppt_slides"],
        sourceType: "group"
      }),
      expect.any(Function)
    );
    expect(legacyRoute).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("reply-token", "目前不支援這個請求。", undefined);
  });

  it("does not apply group function grants to direct users", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule"]
      })
    );
  });

  it("hides profile-global write functions from non-admin users by default", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule"];
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
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "save this schedule" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule"]
      })
    );
  });

  it("keeps profile-global write functions available to admins", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule"];
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
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "save this schedule" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule", "save_schedule"]
      })
    );
  });

  it("lets a direct user use a write function through an explicit user grant", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    await accessStore.addUserFunctionGrant({
      profileName: "main",
      userId: "Uallowed",
      functionName: "save_schedule",
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
      message: { type: "text", text: "save this schedule" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule", "save_schedule"]
      })
    );
  });

  it("lets an admin grant a function to a direct user for the current profile", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
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
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/function-user-grant save_schedule Uallowed" }
    });
    const routeBody = lineBody({
      type: "message",
      replyToken: "route-reply",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "save this schedule" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(grantBody, "main-secret"),
      payload: grantBody
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(routeBody, "main-secret"),
      payload: routeBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toContain("save_schedule");
    await expect(accessStore.listUserFunctionGrants("main", "Uallowed")).resolves.toEqual([
      "save_schedule"
    ]);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule", "save_schedule"]
      })
    );
  });

  it("shows write functions as profile-global but not default effective group scope", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule"];
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
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "/function-scopes" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    const reply = String(replyText.mock.calls[0]?.[1] ?? "");
    expect(res.statusCode).toBe(200);
    expect(reply).toContain("profile-global: query_schedule, save_schedule");
    expect(reply).toContain("profile-default: query_schedule");
    expect(reply).toContain("effective: query_schedule");
    expect(reply).not.toContain("effective: query_schedule, save_schedule");
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
      url: "/api/line/webhook/slides",
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我是小哈");
    expect(replyText.mock.calls[0]?.[1]).toContain("家教會的小幫手");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("我可以：查投影片、查服事表");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("OneDrive");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("Notion");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("下載連結");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("查投影片");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("查服事表");
    expect(replyText).toHaveBeenCalledWith("reply-token", expect.any(String), undefined);
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我可以幫你查資料");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("我是小哈");
  });

  it("uses controlled LLM small talk for direct greetings when enabled by profile", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      smallTalk: { mode: "llm", maxChars: 80 }
    };
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "respond",
      action: "small_talk",
      provider: "ollama",
      confidence: 0.92,
      arguments: { category: "greeting" }
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("你好，我在。");
    const app = createTestApp(config, {
      router: { route },
      textGenerator: { completeText },
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "你好",
        enabledFunctions: ["find_ppt_slides", "query_schedule"]
      })
    );
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "你好",
        category: "greeting",
        maxChars: 80
      })
    );
    expect(replyText.mock.calls[0]?.[1]).toBe("你好，我在。");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("我是小哈");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("目前不支援");
  });

  it("answers addressed group greetings with small talk before routing", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      smallTalk: { mode: "llm", maxChars: 80 }
    };
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const completeText = vi
      .fn<TextGenerationProvider["completeText"]>()
      .mockResolvedValue("你好，我在。");
    const app = createTestApp(config, {
      router: { route },
      textGenerator: { completeText },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈你好" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "小哈你好",
        category: "greeting"
      })
    );
    expect(replyText).toHaveBeenCalledWith("reply-token", "你好，我在。", undefined);
  });

  it("answers capabilities questions without repeating the identity sentence", async () => {
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
      message: { type: "text", text: "小哈你能做什麼" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("我可以幫你查資料");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("我是小哈");
    expect(replyText.mock.calls[0]?.[1]).toContain("你可以試試：");
  });

  it("does not disclose profile write functions in a regular user's capability reply", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule", "save_resource"];
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
      message: { type: "text", text: "小哈你能做什麼" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("我可以幫你查資料");
    expect(reply).not.toContain("記服事表");
    expect(reply).not.toContain("保存連結資源");
  });

  it("introduces sheet music lookup without exposing storage details", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["find_ppt_slides", "query_schedule", "find_sheet_music"];
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("家教會的小幫手");
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
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

  it("keeps catalog admin handlers admin-direct only", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const catalogSources = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "Catalog sources"
    });
    const app = createTestApp(testConfig(), {
      router: { route },
      adminHandlers: {
        "catalog-sources": catalogSources
      },
      createLineReplyClient: () => ({ replyText })
    });

    const nonAdminBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/catalog-sources" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(nonAdminBody, "main-secret"),
      payload: nonAdminBody
    });

    const groupAdminBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "小哈 /catalog-sources" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(groupAdminBody, "main-secret"),
      payload: groupAdminBody
    });

    const directAdminBody = lineBody({
      type: "message",
      replyToken: "reply-token-3",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/catalog-sources" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(directAdminBody, "main-secret"),
      payload: directAdminBody
    });

    expect(catalogSources).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0]?.[1]).not.toBe("Catalog sources");
    expect(replyText.mock.calls[1]?.[1]).not.toBe("Catalog sources");
    expect(replyText.mock.calls[2]?.[1]).toBe("Catalog sources");
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
      url: "/api/line/webhook/main",
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
      action: "query_schedule",
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
      functionRegistry: { query_schedule: queryServiceSchedule },
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
      url: "/api/line/webhook/main",
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
    expect(replyText.mock.calls[0]?.[1]).toContain("action: query_schedule");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("provider: keyword");
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(userBody, "main-secret"),
      payload: userBody
    });
    expect(replyText.mock.calls[0]?.[1]).toContain("支援碼：");

    const adminBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/last-errors" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(adminBody, "main-secret"),
      payload: adminBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[1]?.[1]).toContain("Last errors");
    expect(replyText.mock.calls[1]?.[1]).toMatch(/supportId=[a-f0-9]{16}/u);
    expect(replyText.mock.calls[1]?.[1]).toContain("find_ppt_slides");
    expect(replyText.mock.calls[1]?.[1]).toContain("message=redacted");
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(adminBody, "main-secret"),
      payload: adminBody
    });

    expect(res.statusCode).toBe(200);
    expect(replyText.mock.calls[1]?.[1]).toContain("Last routes");
    expect(replyText.mock.calls[1]?.[1]).toMatch(/supportId=[a-f0-9]{16}/u);
    expect(replyText.mock.calls[1]?.[1]).toContain("find_ppt_slides");
    expect(replyText.mock.calls[1]?.[1]).toContain("provider=router");
    expect(replyText.mock.calls[1]?.[1]).toContain("query=present");
    expect(replyText.mock.calls[1]?.[1]).toContain("ok=true");
    expect(replyText.mock.calls[1]?.[1]).not.toContain("Amazing Grace");
  });

  it("exposes sanitized agent turn traces to slash admin last-agent-turns", async () => {
    const agentTraceStore = new InMemoryAgentTraceStore(10);
    await agentTraceStore.record({
      requestId: "req-agent-1",
      occurredAt: "2026-07-08T00:00:00.000Z",
      profileName: "main",
      sourceType: "group",
      steps: [
        {
          phase: "route",
          outcome: "execute",
          provider: "ollama",
          action: "find_ppt_slides",
          query: "present"
        },
        {
          phase: "function",
          outcome: "executed",
          action: "find_ppt_slides",
          ok: true
        }
      ]
    });
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      agentTraceStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "text", text: "/last-agent-turns" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("Agent turns");
    expect(replyText.mock.calls[0]?.[1]).toMatch(/supportId=[a-f0-9]{16}/u);
    expect(replyText.mock.calls[0]?.[1]).toContain("route:execute");
    expect(replyText.mock.calls[0]?.[1]).toContain("query:present");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("Amazing Grace");
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(firstBody, "main-secret"),
      payload: firstBody
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
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
    const app = createTestApp(accessConfig(), {
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
      url: "/api/line/webhook/helper",
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
    const app = createTestApp(accessConfig(), {
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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

  it("lets admins create an invite code through direct natural language", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const adminRoute = vi.fn().mockResolvedValue({
      type: "execute",
      action: "invite_code_create",
      arguments: {},
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINNL"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      adminActionRouter: { route: adminRoute },
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "please create an invite code" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(adminRoute).toHaveBeenCalledOnce();
    expect(route).not.toHaveBeenCalled();
    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("/registry ADMINNL");
    expect(reply.split("\n")).toContain("/registry ADMINNL");
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "invite_code.create",
          metadata: { ttlMinutes: 60 }
        })
      ])
    );
  });

  it("lets admins manage current-group function scope through natural language", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    config.profiles[0].groupRequireWakeWord = false;
    const route = vi.fn<FunctionRouterPort["route"]>();
    const adminRoute = vi.fn().mockResolvedValue({
      type: "execute",
      action: "function_scope_grant",
      arguments: { functionName: "find_ppt_slides" },
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = defaultAccessStore();
    const app = createTestApp(config, {
      router: { route },
      adminActionRouter: { route: adminRoute },
      accessStore,
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "撠? enable function find_ppt_slides for this group" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(adminRoute).toHaveBeenCalledOnce();
    await expect(accessStore.listGroupFunctionGrants("main", "Cmain")).resolves.toEqual([
      "find_ppt_slides"
    ]);
    expect(replyText.mock.calls[0]?.[1]).toContain("find_ppt_slides");
  });

  it("records admin natural-language routes and action results without raw text or invite codes", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const adminRoute = vi.fn().mockResolvedValue({
      type: "execute",
      action: "invite_code_create",
      arguments: {},
      confidence: 0.93,
      provider: "ollama"
    });
    const routeObserver = vi.fn().mockResolvedValue(undefined);
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINOBS"
    });
    const app = createApp(accessConfig(), {
      router: { route },
      adminActionRouter: { route: adminRoute },
      accessStore: new InMemoryAccessStore(),
      registrationInviteCodeStore,
      routeObserver,
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("req-admin-action-1")
        .mockReturnValueOnce("req-admin-action-2"),
      createLineReplyClient: () => ({ replyText })
    });

    const createBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "please create an invite code for Ray" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(createBody, "helper-secret"),
      payload: createBody
    });

    const adminBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/last-routes" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(adminBody, "helper-secret"),
      payload: adminBody
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin_action_route",
        provider: "ollama",
        outcome: "execute",
        action: "invite_code_create"
      })
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "admin_action_result",
        action: "invite_code_create",
        ok: true
      })
    );
    const lastRoutes = String(replyText.mock.calls[1]?.[1]);
    expect(lastRoutes).toContain("Last routes");
    expect(lastRoutes).toContain("phase=admin_route");
    expect(lastRoutes).toContain("phase=admin_action");
    expect(lastRoutes).toContain("invite_code_create");
    expect(lastRoutes).toContain("provider=ollama");
    expect(lastRoutes).toContain("ok=true");
    expect(lastRoutes).not.toContain("please create an invite code for Ray");
    expect(lastRoutes).not.toContain("ADMINOBS");
  });

  it("keeps admin natural-language actions direct-only even when sent by an admin in a group", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const adminRoute = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const config = testConfig();
    config.profiles[0].groupRequireWakeWord = false;
    const app = createTestApp(config, {
      router: { route },
      adminActionRouter: { route: adminRoute },
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "text", text: "撠? please create an invite code" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(adminRoute).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("個人對話");
  });

  it("does not route admin natural-language actions for non-admin direct users", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const adminRoute = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      adminActionRouter: { route: adminRoute },
      createLineReplyClient: () => ({ replyText })
    });

    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "please create an invite code" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(adminRoute).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledOnce();
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
        url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
    const app = createTestApp(accessConfig(), {
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
      url: "/api/line/webhook/main-public",
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
      url: "/api/line/webhook/main-public",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/helper",
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
      url: "/api/line/webhook/main",
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

  it("stores an allowed direct attachment as a requester-scoped pending save-resource request", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const router: FunctionRouterPort = { route: vi.fn() };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const sessionStore = new InMemorySessionStore();
    const app = createTestApp(config, {
      router,
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "image", id: "image-1" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("要我幫忙保存這個檔案嗎？"),
      expect.objectContaining({
        quickReplies: expect.arrayContaining([
          expect.objectContaining({ label: "是" }),
          expect.objectContaining({ label: "否" })
        ])
      })
    );
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "user", userId: "Uadmin" },
        requesterUserId: "Uadmin"
      })
    ).resolves.toMatchObject({
      action: "save_resource",
      stage: "awaiting_opt_in",
      attachment: { messageId: "image-1", messageType: "image" }
    });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("silently ignores a group attachment without a requester upload intent", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const sessionStore = new InMemorySessionStore();
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "image", id: "image-unrelated" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(replyText).not.toHaveBeenCalled();
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
        requesterUserId: "Uadmin"
      })
    ).resolves.toBeUndefined();
  });

  it("silently ignores a group attachment from a requester without save permission", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route: vi.fn() },
      accessStore: defaultAccessStore(),
      sessionStore: new InMemorySessionStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uungranted" },
      message: { type: "image", id: "image-unrelated" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(replyText).not.toHaveBeenCalled();
  });

  it("accepts only the same requester's next group attachment after upload activation", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "upload-intent-1",
      type: "upload_intent",
      profileName: "main",
      requesterUserId: "Uadmin",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      message: { type: "file", id: "file-1", fileName: "週報.pdf", fileSize: 2048 }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.json()).toEqual({ ok: true, allowedEvents: 1 });
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("要我幫忙保存這個檔案嗎？"),
      expect.any(Object)
    );
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
        requesterUserId: "Uadmin"
      })
    ).resolves.toMatchObject({ attachment: { messageId: "file-1", fileName: "週報.pdf" } });
  });

  it("rejects a declared attachment above the configured maximum before creating a session", async () => {
    const config = testConfig();
    config.attachments = { maxBytes: 4, lineDownloadTimeoutMs: 30_000 };
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "file"],
      enabledFunctions: ["save_resource"]
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const sessionStore = new InMemorySessionStore();
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uadmin" },
      message: { type: "file", id: "file-large", fileName: "large.pdf", fileSize: 5 }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(replyText).toHaveBeenCalledWith("reply-token", "檔案太大，無法保存。", undefined);
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "user", userId: "Uadmin" },
        requesterUserId: "Uadmin"
      })
    ).resolves.toBeUndefined();
  });

  it("allows a non-admin attachment when save_resource is granted through a role", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const accessStore = defaultAccessStore();
    const role = await accessStore.upsertRole({
      profileName: "main",
      roleKey: "media_writer",
      displayName: "Media writer"
    });
    await accessStore.bindRoleCapability(role.id, "function:save_resource:execute");
    await accessStore.bindRoleToPrincipal({
      profileName: "main",
      principalType: "user",
      principalId: "Uallowed",
      roleId: role.id
    });
    const sessionStore = new InMemorySessionStore();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route: vi.fn() },
      accessStore,
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "image", id: "image-role-1" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "user", userId: "Uallowed" },
        requesterUserId: "Uallowed"
      })
    ).resolves.toMatchObject({
      action: "save_resource",
      attachment: { messageId: "image-role-1" }
    });
  });

  it("does not let another group requester continue a pending attachment", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "file"],
      groupRequireWakeWord: false,
      enabledFunctions: ["save_resource"]
    };
    const accessStore = defaultAccessStore();
    await accessStore.addGroupFunctionGrant({
      profileName: "main",
      groupId: "Cmain",
      functionName: "save_resource",
      grantedBy: "Uadmin"
    });
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "upload-intent-existing-test",
      type: "upload_intent",
      profileName: "main",
      requesterUserId: "U1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route: vi.fn() },
      accessStore,
      sessionStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "file", id: "file-1", fileName: "主日投影片.pptx", fileSize: 1234 }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "group", groupId: "Cmain", userId: "U2" },
        requesterUserId: "U2"
      })
    ).resolves.toBeUndefined();
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "main",
        source: { type: "group", groupId: "Cmain", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      attachment: { messageId: "file-1", messageType: "file", fileName: "主日投影片.pptx" }
    });
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
      url: "/api/line/webhook/main",
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

  it("keeps selection-session reads out of requester-scoped active tasks", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0]!,
      generalAgent: { enabled: true, conversationWindowSeconds: 60 },
      controlledAgent: {
        enabled: true,
        shadow: false,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      }
    };
    const conversationWindowStore = new InMemoryConversationWindowStore();
    const recordActiveTask = vi.spyOn(conversationWindowStore, "recordActiveTask");
    const handleSelect = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        replyText: "已選擇奇異恩典",
        agentResource: {
          resourceType: "ppt_slide",
          driveId: "drive-1",
          itemId: "item-1",
          displayName: "奇異恩典.pptx"
        },
        agentResult: {
          status: "success",
          replyText: "已選擇奇異恩典",
          anchors: { query: "奇異恩典" },
          entities: [{ type: "selection", key: "item-1", label: "奇異恩典.pptx" }],
          supportedOperations: ["select"]
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "請選一份",
        agentResource: {
          resourceType: "ppt_slide",
          driveId: "drive-1",
          itemId: "item-1",
          displayName: "奇異恩典.pptx"
        },
        agentResult: { status: "ambiguous", replyText: "請選一份" }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "完成",
        executedAction: "query_schedule",
        agentResult: { status: "success", replyText: "完成", supportedOperations: [] }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "無 requester 不儲存",
        agentResource: {
          resourceType: "ppt_slide",
          driveId: "drive-1",
          itemId: "item-2",
          displayName: "主日.pptx"
        },
        agentResult: {
          status: "success",
          replyText: "無 requester 不儲存",
          supportedOperations: ["select"]
        }
      });
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      postbackHandlers: { select_ppt: handleSelect },
      conversationWindowStore,
      createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
    });
    const scope = { profileName: "main", sourceKey: "group:Cmain", requesterUserId: "U1" };
    const sendSelection = async (requestId: string, userId?: string) => {
      const body = lineBody({
        type: "postback",
        replyToken: `reply-${requestId}`,
        source: { type: "group", groupId: "Cmain", ...(userId ? { userId } : {}) },
        postback: { data: `action=select_ppt&requestId=${requestId}&index=0` }
      });
      return app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });
    };

    expect((await sendSelection("success", "U1")).statusCode).toBe(200);
    await expect(conversationWindowStore.activeTask(scope)).resolves.toBeUndefined();

    expect((await sendSelection("ambiguous", "U1")).statusCode).toBe(200);
    await expect(conversationWindowStore.activeTask(scope)).resolves.toBeUndefined();

    expect((await sendSelection("clear", "U1")).statusCode).toBe(200);
    await expect(conversationWindowStore.activeTask(scope)).resolves.toBeUndefined();

    expect((await sendSelection("missing-requester")).statusCode).toBe(200);
    expect(recordActiveTask).not.toHaveBeenCalled();
  });

  it("stores slow agent turns and lets the same requester retrieve the result by postback", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1, resultTtlMinutes: 10 }
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const deferred = createDeferred<FunctionExecutionResult | undefined>();
    const agentTurnRuntime = {
      handleTextTurn: vi.fn().mockReturnValue(deferred.promise)
    };
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      agentTurnRuntime,
      agentJobStore: new InMemoryAgentJobStore(),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "lookup" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    const quickReplies = replyText.mock.calls[0]?.[2]?.quickReplies ?? [];
    expect(String(replyText.mock.calls[0]?.[1])).toContain("處理");
    expect(quickReplies[0]?.action.type).toBe("postback");
    const data =
      quickReplies[0]?.action.type === "postback" ? quickReplies[0].action.data : undefined;

    deferred.resolve({ ok: true, replyText: "finished result" });
    await deferred.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const postbackBody = lineBody({
      type: "postback",
      replyToken: "reply-token-2",
      source: { type: "user", userId: "Uallowed" },
      postback: { data }
    });
    const postbackRes = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(postbackBody, "main-secret"),
      payload: postbackBody
    });

    expect(postbackRes.statusCode).toBe(200);
    expect(replyText).toHaveBeenLastCalledWith("reply-token-2", "finished result", undefined);
  });

  it("keeps group follow-up routing scoped to the same requester conversation window", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      wakeKeywords: ["bot"],
      smallTalk: { mode: "template", maxChars: 80 },
      generalAgent: { enabled: true, conversationWindowSeconds: 90 }
    };
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "ollama"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const conversationWindowStore = new InMemoryConversationWindowStore({
      now: () => new Date("2026-07-08T10:00:00.000Z")
    });
    const app = createTestApp(config, {
      router: { route },
      conversationWindowStore,
      createLineReplyClient: () => ({ replyText })
    });

    const firstBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "bot hello" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(firstBody, "main-secret"),
      payload: firstBody
    });

    const secondBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "I want to look up data" }
    });
    const secondRes = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(secondBody, "main-secret"),
      payload: secondBody
    });

    expect(secondRes.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ text: "I want to look up data" }));
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
      url: "/api/line/webhook/main",
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
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(handleNumericSelection).toHaveBeenCalledOnce();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("keeps healthz minimal", async () => {
    const app = createTestApp(testConfig(), { router: { route: vi.fn() } });

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "hhc-line-function-bot"
    });
    expect(res.json()).toHaveProperty("timestamp");
    expect(res.json()).not.toHaveProperty("timeZone");
    expect(res.json()).not.toHaveProperty("profiles");
    expect(res.json()).not.toHaveProperty("llm");
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

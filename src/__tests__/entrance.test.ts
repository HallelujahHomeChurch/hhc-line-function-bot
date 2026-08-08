import { describe, expect, it, vi } from "vitest";

import { AccountApiError } from "../account/account-admin-client.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import type { ControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { createControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { createAgentPlanner, type AgentPlanner } from "../agent/planner.js";
import type { ControlledCompletionObserver } from "../application/turn/completion-observer.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createFindPptSlidesHandler } from "../functions/find-ppt-slides.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";
import { signLineBody } from "../line-signature.js";
import { createTestApp as createApp } from "../testing/create-test-app.js";
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
        permissionRequiredFunctions: [],
        accountLink: { displayName: "小哈", lineId: "@hhc-helper", providerId: "provider-1" },
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
        permissionRequiredFunctions: [],
        adminDirectOnly: true,
        directAccessPolicy: "blocked",
        groupAccessPolicy: "managed"
      }
    ],
    llm: {
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000
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

class PostCommitProjectionFailureAccessStore extends InMemoryAccessStore {
  private committed = false;

  override async addPrincipal(
    input: Parameters<InMemoryAccessStore["addPrincipal"]>[0]
  ): ReturnType<InMemoryAccessStore["addPrincipal"]> {
    const principal = await super.addPrincipal(input);
    this.committed = true;
    return principal;
  }

  override async hasActivePrincipal(
    ...args: Parameters<InMemoryAccessStore["hasActivePrincipal"]>
  ): ReturnType<InMemoryAccessStore["hasActivePrincipal"]> {
    if (this.committed) {
      throw new Error("post_commit_projection_failed");
    }
    return super.hasActivePrincipal(...args);
  }
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
        permissionRequiredFunctions: [],
        accountLink: { displayName: "小哈", lineId: "@hhc-helper", providerId: "provider-1" },
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
        permissionRequiredFunctions: [],
        adminUserId: "Uroot",
        adminDirectOnly: true,
        directAccessPolicy: "public",
        groupAccessPolicy: "blocked",
        registration: { enabled: false }
      }
    ],
    llm: {
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8000
    },
    access: { registrationInviteCodeTtlMinutes: 60 }
  };
}

function providerFreeMainConfig(): AppConfig {
  const config = accessConfig();
  config.profiles = [
    {
      name: "main",
      identityLine: "我是 HHC 家教會小幫手。",
      webhookPath: "/api/line/webhook/main",
      channelSecret: "main-secret",
      channelAccessToken: "main-token",
      allowDirectUser: true,
      allowRooms: false,
      allowedMessageTypes: ["text"],
      groupRequireWakeWord: false,
      wakeKeywords: [],
      acceptMention: false,
      enabledFunctions: ["download_weekly_paper"],
      permissionRequiredFunctions: [],
      accountLink: {
        displayName: "哈利路亞家教會官方 LINE",
        lineId: "@hhc-main",
        providerId: "provider-1"
      },
      adminDirectOnly: true,
      directAccessPolicy: "public",
      groupAccessPolicy: "blocked",
      registration: { enabled: false },
      smallTalk: { mode: "template", maxChars: 80 },
      allowedProviders: [],
      allowSubscriptionProviders: false,
      providerPolicy: {},
      controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
      schedulePolicy: { meetingWindows: [], domains: [] },
      generalAgent: { enabled: false, conversationWindowSeconds: 60 }
    }
  ];
  return config;
}

describe("LINE entrance", () => {
  it("acknowledges a signed empty event batch without creating a reply client or entering turn execution", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const completeText = vi.fn<TextGenerationProvider["completeText"]>();
    const executeFunction = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>();
    const createLineReplyClient = vi.fn(() => ({ replyText }));
    const app = createTestApp(testConfig(), {
      router: { route },
      textGenerator: { completeText },
      functionRegistry: { find_ppt_slides: executeFunction },
      createLineReplyClient
    });
    const body = '{"events":[]}';

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, ignored: true });
    expect(createLineReplyClient).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(completeText).not.toHaveBeenCalled();
    expect(executeFunction).not.toHaveBeenCalled();
  });

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
      provider: "deepseek"
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
      provider: "deepseek"
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
      provider: "deepseek"
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
      provider: "deepseek"
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
      provider: "deepseek"
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
      provider: "deepseek"
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
      fallbackProvider: "deepseek",
      fallbackReason: "provider_unavailable"
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

  it("records only successful controlled group function metadata", async () => {
    const route = vi
      .fn<FunctionRouterPort["route"]>()
      .mockResolvedValueOnce({
        type: "execute",
        action: "find_ppt_slides",
        arguments: { query: "private-query" },
        provider: "deepseek"
      })
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "服事表" },
        provider: "deepseek"
      })
      .mockResolvedValueOnce({
        type: "execute",
        action: "query_schedule",
        arguments: { query: "服事表" },
        provider: "deepseek"
      });
    const accessStore = defaultAccessStore();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      accessStore,
      functionRegistry: {
        find_ppt_slides: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "private-result",
          agentResult: {
            status: "success",
            replyText: "private-result",
            supportedOperations: []
          }
        }),
        query_schedule: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            replyText: "找不到",
            agentResult: { status: "not_found", replyText: "找不到" }
          })
          .mockResolvedValueOnce({
            ok: true,
            replyText: "direct success",
            agentResult: {
              status: "success",
              replyText: "direct success",
              supportedOperations: []
            }
          })
      },
      createLineReplyClient: () => ({ replyText })
    });
    const send = async (
      replyToken: string,
      source: { type: "group"; groupId: string; userId: string } | { type: "user"; userId: string },
      text: string
    ) => {
      const body = lineBody({
        type: "message",
        replyToken,
        source,
        message: { type: "text", text }
      });
      return app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });
    };

    expect(
      (
        await send(
          "reply-success",
          { type: "group", groupId: "Cmain", userId: "Uprivate" },
          "小哈 查投影片 private-query"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await send(
          "reply-not-found",
          { type: "group", groupId: "Cmain", userId: "Uprivate" },
          "小哈 查不存在的服事表"
        )
      ).statusCode
    ).toBe(200);
    expect(
      (await send("reply-direct", { type: "user", userId: "Uallowed" }, "小哈 查服事表")).statusCode
    ).toBe(200);

    const principals = await accessStore.listPrincipals("main");
    expect(principals.find((principal) => principal.principalId === "Cmain")).toMatchObject({
      lastSuccessFunctionName: "find_ppt_slides",
      lastSuccessAt: expect.any(String)
    });
    expect(principals.find((principal) => principal.principalId === "Uallowed")).not.toHaveProperty(
      "lastSuccessFunctionName"
    );
    expect(JSON.stringify(principals)).not.toContain("Uprivate");
    expect(JSON.stringify(principals)).not.toContain("private-query");
    expect(JSON.stringify(principals)).not.toContain("private-result");
  });

  it("keeps a successful group reply when success-summary persistence fails", async () => {
    const accessStore = defaultAccessStore();
    vi.spyOn(accessStore, "recordPrincipalSuccess").mockRejectedValue(
      new Error("summary unavailable")
    );
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: {
        route: vi.fn().mockResolvedValue({
          type: "execute",
          action: "find_ppt_slides",
          arguments: { query: "奇異恩典" },
          provider: "deepseek"
        })
      },
      accessStore,
      functionRegistry: {
        find_ppt_slides: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "已找到投影片",
          agentResult: {
            status: "success",
            replyText: "已找到投影片",
            supportedOperations: []
          }
        })
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "小哈 查投影片 奇異恩典" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(replyText.mock.calls[0]?.[1]).toBe("已找到投影片");
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

  it("rejects unrelated managed helper group chatter after common dedupe and rate gates", async () => {
    const rateCheck = vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: "2026-08-08T12:00:00Z"
    });
    const authorizeAdministrator = vi.fn();
    const getUserDisplayName = vi.fn();
    const getGroupDisplayName = vi.fn();
    const createLineIdentityClient = vi.fn(() => ({ getUserDisplayName, getGroupDisplayName }));
    const dedupe = vi.fn().mockResolvedValue("started");
    const app = createTestApp(testConfig(), {
      rateLimiter: { check: rateCheck },
      webhookEventStore: { tryStart: dedupe },
      accountAdminClient: {
        authorizeAdministrator,
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineIdentityClient,
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "unrelated-managed-group",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "晚安" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "wake_word_missing"
    });
    expect(dedupe).toHaveBeenCalledOnce();
    expect(rateCheck).toHaveBeenCalledOnce();
    expect(authorizeAdministrator).not.toHaveBeenCalled();
    expect(createLineIdentityClient).not.toHaveBeenCalled();
    expect(getUserDisplayName).not.toHaveBeenCalled();
    expect(getGroupDisplayName).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", "duplicate", true],
    ["rate limited", "started", false]
  ] as const)(
    "gates a %s helper group continuation before stateful admission",
    async (_label, dedupeResult, rateAllowed) => {
      const config = testConfig();
      config.profiles[0] = {
        ...config.profiles[0]!,
        generalAgent: { enabled: true, conversationWindowSeconds: 60 }
      };
      const accessStore = defaultAccessStore();
      const accessRead = vi.spyOn(accessStore, "hasActivePrincipal");
      const sessionStore = new InMemorySessionStore();
      const sessionRead = vi.spyOn(sessionStore, "findPendingCapabilityResolution");
      const conversationWindowStore = new InMemoryConversationWindowStore();
      const conversationRead = vi.spyOn(conversationWindowStore, "isActive");
      const dedupe = vi.fn().mockResolvedValue(dedupeResult);
      const rateCheck = vi.fn().mockResolvedValue({
        allowed: rateAllowed,
        remaining: rateAllowed ? 19 : 0,
        resetAt: "2026-08-08T12:00:00Z"
      });
      const authorizeAdministrator = vi.fn();
      const app = createTestApp(config, {
        accessStore,
        sessionStore,
        conversationWindowStore,
        webhookEventStore: { tryStart: dedupe },
        rateLimiter: { check: rateCheck },
        accountAdminClient: {
          authorizeAdministrator,
          createBinding: vi.fn(),
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
      });
      const body = lineBody({
        type: "message",
        webhookEventId: `helper-${_label}`,
        replyToken: "reply-token",
        source: { type: "group", groupId: "Cmain", userId: "U1" },
        message: { type: "text", text: "奇異恩典" }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(dedupe).toHaveBeenCalledOnce();
      expect(rateCheck).toHaveBeenCalledTimes(dedupeResult === "duplicate" ? 0 : 1);
      expect(accessRead).not.toHaveBeenCalled();
      expect(sessionRead).not.toHaveBeenCalled();
      expect(conversationRead).not.toHaveBeenCalled();
      expect(authorizeAdministrator).not.toHaveBeenCalled();
    }
  );

  it("preserves unaddressed small talk for an active helper group conversation", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0]!,
      wakeKeywords: ["bot"],
      generalAgent: { enabled: true, conversationWindowSeconds: 90 }
    };
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
    });
    const conversationWindowStore = new InMemoryConversationWindowStore();
    await conversationWindowStore.recordTurn({
      scope: { profileName: "main", sourceKey: "group:Cmain", requesterUserId: "U1" },
      role: "assistant",
      text: "active",
      ttlMs: 90_000
    });
    const app = createTestApp(config, {
      router: { route },
      conversationWindowStore,
      createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "active-group-small-talk",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      message: { type: "text", text: "晚安" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ text: "晚安" }));
  });

  it("ignores third-person group mentions of the bot before calling the router", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
      provider: "deepseek"
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
      provider: "deepseek"
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

  it("lists the exact effective functions through help", async () => {
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
    expect(replyText.mock.calls[0]?.[1]).toContain("可以查詢");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查投影片：");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查服事表：");
    expect(replyText.mock.calls[0]?.[1]).toContain("/registry <code>");
    expect(replyText.mock.calls[0]?.[1]).toContain("/whoami");
    expect(replyText.mock.calls[0]?.[1]).toContain("/memories");
    expect(replyText.mock.calls[0]?.[1]).toContain("/forget-memory <id>");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("owner:");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("freshness:");
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.any(String),
      expect.objectContaining({
        quickReplies: expect.arrayContaining([
          expect.objectContaining({ label: "查服事表" }),
          expect.objectContaining({ label: "查投影片" })
        ])
      })
    );
  });

  it("returns registration guidance without capabilities for unregistered help", async () => {
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
      message: { type: "text", text: "/help" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(String(replyText.mock.calls[0]?.[1])).toContain(
      "你尚未開通小哈，請先找管理員協助註冊。"
    );
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("可以查詢");
    expect(String(replyText.mock.calls[0]?.[1])).toContain("登入 HHC 帳戶");
  });

  it("ignores legacy grants while preserving profile reads and Account-authorized admin writes in help", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule"];
    const accessStore = new InMemoryAccessStore({
      principals: [
        {
          id: "principal-direct",
          profileName: "main",
          type: "user",
          principalId: "Udirect",
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "test"
        },
        {
          id: "principal-granted",
          profileName: "main",
          type: "user",
          principalId: "Ugranted",
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "test"
        },
        {
          id: "principal-help-group",
          profileName: "main",
          type: "group",
          principalId: "Chelp",
          createdAt: "2026-07-06T00:00:00.000Z",
          createdBy: "test"
        }
      ]
    });
    await accessStore.addGroupFunctionGrant({
      profileName: "main",
      groupId: "Chelp",
      functionName: "find_ppt_slides",
      createdBy: "Uadmin"
    });
    await accessStore.addUserFunctionGrant({
      profileName: "main",
      userId: "Ugranted",
      functionName: "save_schedule",
      createdBy: "Uadmin"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const authorizeFunctions = vi.fn(async ({ lineUserId }: { lineUserId: string }) =>
      lineUserId === "Uadmin"
        ? {
            bound: true,
            active: true,
            administrator: true,
            allowedFunctions: [],
            account: {
              displayName: "Admin",
              maskedEmail: "a***@example.com",
              roles: ["admin"] as const
            }
          }
        : { bound: false, active: false, administrator: false, allowedFunctions: [] }
    );
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      accessStore,
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions,
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const sources = [
      { type: "user" as const, userId: "Udirect" },
      { type: "group" as const, groupId: "Chelp", userId: "Ugroup" },
      { type: "user" as const, userId: "Ugranted" },
      { type: "user" as const, userId: "Uadmin" }
    ];

    for (const [index, source] of sources.entries()) {
      const body = lineBody({
        type: "message",
        replyToken: `reply-token-${index}`,
        source,
        message: { type: "text", text: "/help" }
      });
      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });
    }

    const directHelp = String(replyText.mock.calls[0]?.[1]);
    const groupHelp = String(replyText.mock.calls[1]?.[1]);
    const grantedHelp = String(replyText.mock.calls[2]?.[1]);
    const adminHelp = String(replyText.mock.calls[3]?.[1]);
    expect(directHelp).toContain("- 查服事表：");
    expect(directHelp).not.toContain("查投影片");
    expect(directHelp).not.toContain("記服事表");
    expect(groupHelp).toContain("- 查服事表：");
    expect(groupHelp).not.toContain("查投影片");
    expect(groupHelp).not.toContain("記服事表");
    expect(grantedHelp).toContain("- 查服事表：");
    expect(grantedHelp).not.toContain("記服事表");
    expect(grantedHelp).not.toContain("查投影片");
    expect(adminHelp).toContain("- 查服事表：");
    expect(adminHelp).toContain("- 記服事表：");
    expect(adminHelp).not.toContain("查投影片");
    expect(adminHelp).not.toContain("Admin commands");
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
    expect(replyText.mock.calls[0]?.[1]).toContain("/access-list [user|group]");
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
    expect(replyText.mock.calls[0]?.[1]).not.toContain("Superadmin");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/admin-add");
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
      event: expect.objectContaining({ replyToken: "reply-token" }),
      requesterIsAdmin: true
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
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("登入 HHC 帳戶"),
      undefined
    );
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

  it("rejects retired group function grants without expanding effective functions", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
    expect(replyText.mock.calls[0]?.[1]).toContain("HHC 帳戶統一管理");
    await expect(accessStore.listGroupFunctionGrants("main", "Cmain")).resolves.toEqual([]);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule"]
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

      expect(replyText.mock.calls[0]?.[1]).toContain("HHC 帳戶統一管理");
      await expect(accessStore.listGroupFunctionGrants("main", "Cmain")).resolves.toEqual([]);
    }
  );

  it.each([
    ["save_memory", ["retrieve_memory", "save_memory"]],
    ["save_schedule", ["query_schedule", "save_schedule"]]
  ] as const)(
    "ignores a stored %s user grant for a registered group requester",
    async (functionName, profileFunctions) => {
      const config = testConfig();
      config.profiles[0].enabledFunctions = [...profileFunctions];
      const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
        type: "deny",
        reason: "not_matched",
        provider: "deepseek"
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
        expect.objectContaining({ enabledFunctions: [profileFunctions[0]] })
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
        enabledFunctions: ["query_schedule"],
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
      provider: "deepseek"
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
      provider: "deepseek"
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

  it("does not let a stored user grant expand direct-user functions", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
        enabledFunctions: ["query_schedule"]
      })
    );
  });

  it("rejects retired direct-user grants without writing or expanding access", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
    expect(replyText.mock.calls[0]?.[1]).toContain("HHC 帳戶統一管理");
    await expect(accessStore.listUserFunctionGrants("main", "Uallowed")).resolves.toEqual([]);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "main",
        enabledFunctions: ["query_schedule"]
      })
    );
  });

  it("rejects the retired function scope listing command", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule", "save_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
    expect(reply).toContain("HHC 帳戶統一管理");
  });

  it("keeps group function grants isolated by profile", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = [];
    config.profiles[1].enabledFunctions = [];
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
    expect(replyText.mock.calls[0]?.[1]).toContain("我目前可以協助：");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查投影片：");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查服事表：");
    expect(replyText.mock.calls[0]?.[2]?.quickReplies).toHaveLength(3);
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
      provider: "deepseek",
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

  it("answers capabilities questions from the effective capability projection", async () => {
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
    expect(replyText.mock.calls[0]?.[1]).toContain("我目前可以協助：");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查投影片：");
    expect(replyText.mock.calls[0]?.[1]).toContain("- 查服事表：");
    expect(replyText.mock.calls[0]?.[2]?.quickReplies).toHaveLength(3);
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
    expect(reply).toContain("- 查服事表：");
    expect(reply).not.toContain("記服事表");
    expect(reply).not.toContain("保存連結資源");
  });

  it("uses the same effective capability projection for help and natural-language introduction", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      router: { route },
      createLineReplyClient: () => ({ replyText })
    });
    const body = JSON.stringify({
      destination: "bot",
      events: [
        {
          type: "message",
          replyToken: "help-reply",
          source: { type: "user", userId: "Uallowed" },
          message: { type: "text", text: "/help" }
        },
        {
          type: "message",
          replyToken: "intro-reply",
          source: { type: "user", userId: "Uallowed" },
          message: { type: "text", text: "小哈你能做什麼" }
        }
      ]
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    const helpText = String(replyText.mock.calls[0]?.[1]);
    const introText = String(replyText.mock.calls[1]?.[1]);
    expect(helpText).toContain("- 查投影片：");
    expect(helpText).toContain("- 查服事表：");
    expect(introText).toContain("- 查投影片：");
    expect(introText).toContain("- 查服事表：");
    for (const command of ["/registry", "/whoami", "/memories", "/forget-memory"]) {
      expect(helpText).toContain(command);
      expect(introText).not.toContain(command);
    }
    expect(replyText.mock.calls[1]?.[2]?.quickReplies).toEqual(
      replyText.mock.calls[0]?.[2]?.quickReplies
    );
    expect(replyText.mock.calls[0]?.[2]?.quickReplies).toHaveLength(3);
  });

  it("filters natural capability introductions through the memoized Account permission lookup", async () => {
    const config = testConfig();
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: [],
      account: {
        displayName: "王小明",
        maskedEmail: "w***@example.com",
        roles: ["user"]
      }
    });
    const app = createTestApp(config, {
      router: { route },
      accountAdminClient: { authorizeFunctions },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "小哈你能做什麼" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(authorizeFunctions).toHaveBeenCalledOnce();
    expect(authorizeFunctions).toHaveBeenCalledWith({
      lineUserId: "Uallowed",
      profileName: "main",
      functionNames: ["query_schedule"]
    });
    expect(route).not.toHaveBeenCalled();
    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("- 查投影片：");
    expect(reply).not.toContain("- 查服事表：");
    expect(reply).toContain("已連結 王小明（w***@example.com）");
    expect(reply).not.toContain("登入 HHC 帳戶");
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
      replyText: [
        "Catalog sources",
        "- weekly_report_audio",
        "  owner: 週報同工",
        "  freshness: 每週一前確認音檔"
      ].join("\n")
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
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("owner:");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("freshness:");
    expect(String(replyText.mock.calls[1]?.[1])).not.toContain("owner:");
    expect(String(replyText.mock.calls[1]?.[1])).not.toContain("freshness:");
    expect(String(replyText.mock.calls[2]?.[1])).toContain("owner: 週報同工");
    expect(String(replyText.mock.calls[2]?.[1])).toContain("freshness: 每週一前確認音檔");
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
      provider: "deepseek"
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
      provider: "deepseek"
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
          provider: "deepseek",
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
      provider: "deepseek"
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
    const createBinding = vi.fn();
    const app = createTestApp(testConfig(), {
      router: { route },
      accountAdminClient: {
        authorizeAdministrator: vi.fn().mockResolvedValue({ bound: false, allowed: false }),
        createBinding,
        finalizeBinding: vi.fn()
      },
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
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("登入 HHC 帳戶"),
      undefined
    );
    expect(createBinding).not.toHaveBeenCalled();
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
    const config = accessConfig();
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
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
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: false,
      active: false,
      administrator: false,
      allowedFunctions: []
    });
    const app = createApp(config, {
      router: { route },
      accessStore,
      registrationInviteCodeStore,
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions,
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
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
    expect(authorizeFunctions).toHaveBeenCalledOnce();
    expect(authorizeFunctions).toHaveBeenCalledWith({
      lineUserId: "Unew",
      profileName: "helper",
      functionNames: ["query_schedule"]
    });
    expect(identityClient.getUserDisplayName).toHaveBeenCalledWith("Unew");
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("已開通，你現在可以使用小哈。"),
      expect.objectContaining({
        quickReplies: [expect.objectContaining({ label: "查投影片" })]
      })
    );
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("查服事表");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("Unew");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("目前還沒有開放");
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
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("已開通，你現在可以使用小哈。"),
      expect.objectContaining({
        quickReplies: [
          expect.objectContaining({ label: "查服事表" }),
          expect.objectContaining({ label: "查投影片" })
        ]
      })
    );
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("Cnew");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("LINE 影音同工群");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("目前還沒有開放");
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

  it("returns a truthful direct-registration success when post-commit capability projection fails", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new PostCommitProjectionFailureAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "HHCDIRECT",
      now: () => new Date("2026-07-07T00:30:00.000Z")
    });
    await registrationInviteCodeStore.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 60,
      now: new Date("2026-07-07T00:00:00.000Z")
    });
    const app = createApp(accessConfig(), {
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Unew" },
      message: { type: "text", text: "/registry HHCDIRECT" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "已開通，你現在可以使用小哈。",
      undefined
    );
    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      { type: "user", principalId: "Unew" }
    ]);
    await expect(registrationInviteCodeStore.consume("helper", "HHCDIRECT")).resolves.toBe(false);
  });

  it("returns a truthful group-registration success when post-commit capability projection fails", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new PostCommitProjectionFailureAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "HHCGROUPFAIL",
      now: () => new Date("2026-07-07T00:30:00.000Z")
    });
    await registrationInviteCodeStore.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 60,
      now: new Date("2026-07-07T00:00:00.000Z")
    });
    const app = createApp(accessConfig(), {
      accessStore,
      registrationInviteCodeStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cnew", userId: "Unew" },
      message: { type: "text", text: "/registry HHCGROUPFAIL" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "已開通，你現在可以使用小哈。",
      undefined
    );
    await expect(accessStore.listPrincipals("helper")).resolves.toMatchObject([
      { type: "group", principalId: "Cnew" }
    ]);
    await expect(registrationInviteCodeStore.consume("helper", "HHCGROUPFAIL")).resolves.toBe(
      false
    );
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
      provider: "deepseek"
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

  it("does not route retired natural-language function management as an admin action", async () => {
    const config = testConfig();
    config.profiles[0].enabledFunctions = ["query_schedule"];
    config.profiles[0].groupRequireWakeWord = false;
    const route = vi.fn<FunctionRouterPort["route"]>();
    const adminRoute = vi.fn().mockResolvedValue({
      type: "execute",
      action: "function_scope_grant",
      arguments: { functionName: "find_ppt_slides" },
      provider: "deepseek"
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
    expect(route).toHaveBeenCalledOnce();
    expect(adminRoute).not.toHaveBeenCalled();
    await expect(accessStore.listGroupFunctionGrants("main", "Cmain")).resolves.toEqual([]);
  });

  it("records admin natural-language routes and action results without raw text or invite codes", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const adminRoute = vi.fn().mockResolvedValue({
      type: "execute",
      action: "invite_code_create",
      arguments: {},
      confidence: 0.93,
      provider: "deepseek"
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
        provider: "deepseek",
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
    expect(lastRoutes).toContain("provider=deepseek");
    expect(lastRoutes).toContain("ok=true");
    expect(lastRoutes).not.toContain("please create an invite code for Ray");
    expect(lastRoutes).not.toContain("ADMINOBS");
  });

  it("keeps admin natural-language actions direct-only even when sent by an admin in a group", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>().mockResolvedValue({
      type: "deny",
      reason: "not_matched",
      provider: "deepseek"
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
      provider: "deepseek"
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
    expect(route).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0]?.[1]).toContain("登入 HHC 帳戶");
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

  it("summarizes active and disabled groups with effective display names and last success", async () => {
    const route = vi.fn<FunctionRouterPort["route"]>();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cactive",
      displayName: "影音同工群",
      createdBy: "Uroot"
    });
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cdisabled",
      displayName: "舊服事群",
      createdBy: "Uroot"
    });
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "user",
      principalId: "Udisabled",
      displayName: "舊使用者",
      createdBy: "Uroot"
    });
    await accessStore.addGroupFunctionGrant({
      profileName: "helper",
      groupId: "Cactive",
      functionName: "find_resource",
      createdBy: "Uroot"
    });
    await accessStore.addGroupFunctionGrant({
      profileName: "helper",
      groupId: "Cdisabled",
      functionName: "find_resource",
      createdBy: "Uroot"
    });
    await accessStore.addUserFunctionGrant({
      profileName: "helper",
      userId: "Uroot",
      functionName: "query_wikipedia",
      createdBy: "Uroot"
    });
    const groupRole = await accessStore.upsertRole({
      profileName: "helper",
      roleKey: "music_reader",
      displayName: "Music reader"
    });
    await accessStore.bindRoleCapability(groupRole.id, "function:find_sheet_music:execute");
    await accessStore.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "group",
      principalId: "Cactive",
      roleId: groupRole.id
    });
    await accessStore.bindRoleToPrincipal({
      profileName: "helper",
      principalType: "group",
      principalId: "Cdisabled",
      roleId: groupRole.id
    });
    await accessStore.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "Cactive",
      functionName: "find_ppt_slides",
      occurredAt: "2026-07-26T10:00:00.000Z"
    });
    await accessStore.disablePrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cdisabled",
      disabledBy: "Uroot"
    });
    await accessStore.disablePrincipal({
      profileName: "helper",
      type: "user",
      principalId: "Udisabled",
      disabledBy: "Uroot"
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
      message: { type: "text", text: "/access-list" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("group: Cactive (影音同工群)");
    expect(reply).toContain("state: active");
    expect(reply).toContain("effective: 查投影片, 查服事表");
    expect(reply).not.toContain("查維基百科");
    expect(reply).toContain("last-success: 查投影片 @ 2026-07-26T10:00:00.000Z");
    expect(reply).toContain("group: Cdisabled (舊服事群)");
    expect(reply).toContain("state: disabled");
    expect(reply).toMatch(
      /group: Cdisabled \(舊服事群\)\n {2}state: disabled\n {2}effective: \(none\)/u
    );
    expect(reply).not.toContain("user: Udisabled");
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
      provider: "deepseek"
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

  it.each([
    ["latest", "下載最新週報", "user", "success"],
    ["specified", "第1733期週報", "user", "success"],
    ["not found", "第9999期週報", "user", "not_found"],
    ["help", "/help", "user", "help"],
    ["account login", "登入 HHC 帳戶", "user", "login"],
    ["unknown", "我想知道這是什麼", "user", "local"],
    ["blocked group", "下載最新週報", "group", "blocked"],
    ["admin-looking", "幫我建立邀請碼", "user", "local"],
    ["route test", "/route-test 查服事表", "user", "local"],
    ["typo", "下戴最新週包", "user", "local"],
    ["cross function", "查下一場服事表", "user", "local"],
    ["write intent", "幫我保存這份週報", "user", "local"],
    ["numeric only", "1733", "user", "local"]
  ] as const)(
    "keeps provider-free main entrance local and gate-ordered: %s",
    async (_label, text, sourceType, expected) => {
      const order: string[] = [];
      const authorizeAdministrator = vi.fn();
      const authorizeFunctions = vi.fn().mockResolvedValue({
        bound: false,
        active: false,
        administrator: false,
        allowedFunctions: []
      });
      const providerCompleteJson = vi.fn();
      const providerCompleteText = vi.fn<TextGenerationProvider["completeText"]>();
      const embeddingRequest = vi.fn();
      const planner = createAgentPlanner({
        primary: { providerName: "deepseek", completeJson: providerCompleteJson },
        providersEnabledForProfile: () => false
      });
      const controlledAgentRouter = createControlledAgentRouter({ planner });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/by-number/9999")) {
          return new Response("{}", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            data: {
              issueNumber: 1733,
              issueDate: "2026-08-09",
              locale: "zh-Hant",
              title: "第 1733 期週報",
              subtitle: "HHC Weekly Paper",
              downloadUrl: "/assets/0123456789abcdef0123456789abcdef?filename=1733-weekly.pdf",
              downloadFileName: "1733-weekly.pdf",
              publishedAt: "2026-08-09T02:00:00.000Z",
              version: 1
            },
            meta: {},
            error: null
          }),
          { status: 200 }
        );
      });
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const createBinding = vi.fn().mockResolvedValue({
        bindingUrl: "https://account.alive.org.tw/line/bind#token=opaque",
        expiresAt: "2026-08-08T12:00:00Z"
      });
      const app = createApp(providerFreeMainConfig(), {
        controlledAgentRouter,
        functionRegistry: {
          download_weekly_paper: (args) => downloadWeeklyPaper(args, fetchImpl),
          query_knowledge: async () => {
            embeddingRequest();
            return { ok: true, replyText: "unexpected embedding path" };
          }
        },
        textGenerator: { completeText: providerCompleteText },
        textFallbackGenerator: { completeText: providerCompleteText },
        accountAdminClient: {
          authorizeAdministrator,
          authorizeFunctions,
          createBinding,
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText }),
        createLineIdentityClient: () => ({
          getUserDisplayName: vi.fn(async () => {
            order.push("display");
            return "Ray";
          }),
          getGroupDisplayName: vi.fn(async () => {
            order.push("display");
            return "Group";
          })
        }),
        webhookEventStore: {
          tryStart: vi.fn(async () => {
            order.push("dedupe");
            return "started" as const;
          })
        },
        rateLimiter: {
          check: vi.fn(async () => {
            order.push("rate");
            return { allowed: true, remaining: 19, resetAt: "2026-08-08T12:00:00Z" };
          })
        }
      });
      const source =
        sourceType === "group"
          ? { type: "group", groupId: "Cblocked", userId: "U1" }
          : { type: "user", userId: "U1" };
      const body = JSON.stringify({
        destination: "channel-destination",
        events: [
          {
            type: "message",
            webhookEventId: `main-${_label}`,
            replyToken: "reply-token",
            source,
            message: { type: "text", text }
          }
        ]
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeAdministrator).not.toHaveBeenCalled();
      expect(providerCompleteJson).not.toHaveBeenCalled();
      expect(providerCompleteText).not.toHaveBeenCalled();
      expect(embeddingRequest).not.toHaveBeenCalled();
      if (expected === "blocked") {
        expect(response.json()).toMatchObject({ ignored: true, reason: "group_blocked" });
        expect(order).toEqual([]);
        expect(replyText).not.toHaveBeenCalled();
        return;
      }
      expect(order.slice(0, 2)).toEqual(["dedupe", "rate"]);
      if (expected === "login") {
        expect(order).toEqual(["dedupe", "rate"]);
        expect(authorizeFunctions).toHaveBeenCalledOnce();
        expect(createBinding).toHaveBeenCalledOnce();
      } else {
        const displayIndex = order.indexOf("display");
        if (displayIndex !== -1) {
          expect(displayIndex).toBeGreaterThan(order.indexOf("rate"));
        }
      }
      const reply = String(replyText.mock.calls[0]?.[1]);
      if (expected === "success") expect(reply).toContain("第 1733 期週報");
      if (expected === "not_found") expect(reply).toContain("沒有找到");
      if (expected === "help") {
        expect(authorizeFunctions).toHaveBeenCalledOnce();
        expect(reply).toContain("下載週報");
        expect(reply).toContain("登入 HHC 帳戶");
        expect(reply).not.toMatch(/registry|memories|route-test/iu);
      }
      if (expected === "local") expect(reply).not.toContain("管理權限");
    }
  );

  it.each([
    [
      "unbound",
      { bound: false, active: false, administrator: false, allowedFunctions: [] },
      ["下載週報", "登入 HHC 帳戶"],
      ["查服事表"]
    ],
    [
      "active",
      {
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: ["query_schedule"],
        account: { displayName: "Ray", maskedEmail: "r***@example.com", roles: ["user"] }
      },
      ["下載週報", "查服事表", "Ray", "r***@example.com"],
      ["登入 HHC 帳戶"]
    ],
    [
      "inactive",
      { bound: true, active: false, administrator: false, allowedFunctions: [] },
      ["下載週報", "聯絡管理同工"],
      ["查服事表", "登入 HHC 帳戶"]
    ]
  ] as const)(
    "renders Account-aware help from the allowed function intersection: %s",
    async (_label, authorization, included, excluded) => {
      const config = providerFreeMainConfig();
      config.profiles[0]!.enabledFunctions = ["download_weekly_paper", "query_schedule"];
      config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
      const authorizeFunctions = vi.fn().mockResolvedValue(authorization);
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createApp(config, {
        accountAdminClient: {
          authorizeAdministrator: vi.fn(),
          authorizeFunctions,
          createBinding: vi.fn(),
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText }),
        createLineIdentityClient: () => ({
          getUserDisplayName: vi.fn(),
          getGroupDisplayName: vi.fn()
        })
      });
      const body = lineBody({
        type: "message",
        webhookEventId: `help-${_label}`,
        replyToken: "reply-token",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text: "幫助！" }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeFunctions).toHaveBeenCalledOnce();
      expect(authorizeFunctions).toHaveBeenCalledWith({
        lineUserId: "U1",
        profileName: "main",
        functionNames: ["query_schedule"]
      });
      const reply = String(replyText.mock.calls[0]?.[1]);
      for (const value of included) expect(reply).toContain(value);
      for (const value of excluded) expect(reply).not.toContain(value);
    }
  );

  it("keeps public help available when Account authorization is unavailable", async () => {
    const config = providerFreeMainConfig();
    config.profiles[0]!.enabledFunctions = ["download_weekly_paper", "query_schedule"];
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn().mockRejectedValue(new Error("offline")),
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "help-unavailable",
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: "/help" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("下載週報");
    expect(reply).toContain("目前無法確認帳戶狀態");
    expect(reply).not.toContain("查服事表");
    expect(reply).not.toContain("登入 HHC 帳戶");
  });

  it.each([
    [
      "unbound",
      { bound: false, active: false, administrator: false, allowedFunctions: [] },
      true,
      "登入／綁定 HHC 帳戶"
    ],
    [
      "active",
      {
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: [],
        account: { displayName: "Ray", maskedEmail: "r***@example.com", roles: ["user"] }
      },
      false,
      "已連結"
    ],
    [
      "inactive",
      { bound: true, active: false, administrator: false, allowedFunctions: [] },
      false,
      "聯絡管理同工"
    ]
  ] as const)(
    "starts login only for an unbound direct user: %s",
    async (_label, authorization, creates, copy) => {
      const authorizeFunctions = vi.fn().mockResolvedValue(authorization);
      const createBinding = vi.fn().mockResolvedValue({
        bindingUrl: "https://account.alive.org.tw/line/bind#token=opaque",
        expiresAt: "2026-08-08T12:00:00Z"
      });
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createApp(providerFreeMainConfig(), {
        accountAdminClient: {
          authorizeAdministrator: vi.fn(),
          authorizeFunctions,
          createBinding,
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText }),
        createLineIdentityClient: () => ({
          getUserDisplayName: vi.fn(),
          getGroupDisplayName: vi.fn()
        })
      });
      const body = lineBody({
        type: "message",
        webhookEventId: `login-${_label}`,
        replyToken: "reply-token",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text: "登入！" }
      });

      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(authorizeFunctions).toHaveBeenCalledOnce();
      expect(authorizeFunctions).toHaveBeenCalledWith({
        lineUserId: "U1",
        profileName: "main",
        functionNames: []
      });
      expect(createBinding).toHaveBeenCalledTimes(creates ? 1 : 0);
      expect(String(replyText.mock.calls[0]?.[1])).toContain(copy);
    }
  );

  it("returns only safe linked-account fields and human function names from whoami", async () => {
    const config = providerFreeMainConfig();
    config.profiles[0]!.enabledFunctions = ["download_weekly_paper", "query_schedule"];
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: ["query_schedule"],
      account: {
        displayName: "Ray",
        maskedEmail: "r***@example.com",
        roles: ["admin", "user"]
      }
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions,
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "whoami-active",
      replyToken: "reply-token",
      source: { type: "user", userId: "U-secret" },
      message: { type: "text", text: "我的帳戶？" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(authorizeFunctions).toHaveBeenCalledOnce();
    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("Ray");
    expect(reply).toContain("r***@example.com");
    expect(reply).toContain("admin");
    expect(reply).toContain("user");
    expect(reply).toContain("查服事表");
    expect(reply).not.toContain("query_schedule");
    expect(reply).not.toContain("U-secret");
    expect(reply).not.toMatch(/profile:|source:|groupId:|directPolicy:|permission:/u);
  });

  it("does not offer a second binding to an inactive account in whoami", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(providerFreeMainConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: true,
          active: false,
          administrator: false,
          allowedFunctions: []
        }),
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "whoami-inactive",
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: "我是誰" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    const reply = String(replyText.mock.calls[0]?.[1]);
    expect(reply).toContain("聯絡管理同工");
    expect(reply).not.toContain("登入 HHC 帳戶");
  });

  it.each([
    ["allowed", ["query_schedule"], 1],
    ["denied", [], 0]
  ] as const)(
    "%s Account authorization filters a restricted candidate before planner execution",
    async (_label, allowedFunctions, executions) => {
      const config = providerFreeMainConfig();
      config.profiles[0]!.enabledFunctions = ["download_weekly_paper", "query_schedule"];
      config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
      const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
        status: "proposed",
        version: 1,
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "查主日服事" },
        confidence: 0.98,
        provider: "deepseek",
        attempts: []
      });
      const querySchedule = vi.fn().mockResolvedValue({
        ok: true,
        replyText: "主日服事表",
        agentResult: { status: "success", replyText: "主日服事表" }
      });
      const authorizeFunctions = vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: [...allowedFunctions]
      });
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createApp(config, {
        controlledAgentRouter: createControlledAgentRouter({ planner: { propose } }),
        functionRegistry: { query_schedule: querySchedule },
        accountAdminClient: {
          authorizeAdministrator: vi.fn(),
          authorizeFunctions,
          createBinding: vi.fn(),
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "message",
        webhookEventId: `restricted-${_label}`,
        replyToken: "reply-token",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text: "查主日服事" }
      });

      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(authorizeFunctions).toHaveBeenCalledOnce();
      expect(authorizeFunctions).toHaveBeenCalledWith({
        lineUserId: "U1",
        profileName: "main",
        functionNames: ["query_schedule"]
      });
      expect(propose).toHaveBeenCalledTimes(executions);
      expect(querySchedule).toHaveBeenCalledTimes(executions);
    }
  );

  it.each(["下載第 1733 期週報", "今天天氣如何"])(
    "does not look up Account authorization for an unrelated public turn: %s",
    async (text) => {
      const config = providerFreeMainConfig();
      config.profiles[0]!.enabledFunctions = ["download_weekly_paper", "query_schedule"];
      config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
      const authorizeFunctions = vi.fn();
      const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
        status: "no_plan",
        reasonCode: "providers_disabled",
        attempts: []
      });
      const app = createApp(config, {
        controlledAgentRouter: createControlledAgentRouter({ planner: { propose } }),
        accountAdminClient: {
          authorizeAdministrator: vi.fn(),
          authorizeFunctions,
          createBinding: vi.fn(),
          finalizeBinding: vi.fn()
        },
        createLineReplyClient: () => ({ replyText: vi.fn().mockResolvedValue(undefined) })
      });
      const body = lineBody({
        type: "message",
        webhookEventId: `public-${text.length}`,
        replyToken: "reply-token",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text }
      });

      await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(authorizeFunctions).not.toHaveBeenCalled();
    }
  );

  it("ignores legacy local admin rows and trusts Account authorization", async () => {
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
      accountAdminClient: {
        authorizeAdministrator: vi.fn(async (lineUserId: string) => ({
          bound: true,
          allowed: lineUserId === "Uaccountadmin"
        })),
        createBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });

    for (const [index, userId] of ["Uadmin2", "Uaccountadmin"].entries()) {
      const body = lineBody({
        type: "message",
        replyToken: `reply-token-${index}`,
        source: { type: "user", userId },
        message: { type: "text", text: "/status" }
      });
      await app.inject({
        method: "POST",
        url: "/api/line/webhook/helper",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });
    }

    expect(replyText.mock.calls[0]?.[1]).toContain("你沒有權限");
    expect(replyText.mock.calls[1]?.[1]).toContain("Admin status");
  });

  it("fails closed when Account authorization is unavailable", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn().mockRejectedValue(new Error("offline")),
        createBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "/status" }
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(replyText.mock.calls[0]?.[1]).toContain("目前無法確認管理權限");
  });

  it("starts native account linking for an unmanaged direct user without authorization or routing", async () => {
    const authorizeAdministrator = vi.fn();
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: false,
      active: false,
      administrator: false,
      allowedFunctions: []
    });
    const createBinding = vi.fn().mockResolvedValue({
      bindingUrl: "https://account.alive.org.tw/line/bind#token=opaque",
      expiresAt: "2026-08-08T12:00:00Z"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const route = vi.fn<FunctionRouterPort["route"]>();
    const createLineIdentityClient = vi.fn();
    const routeObserver = vi.fn();
    const app = createApp(accessConfig(), {
      router: { route },
      routeObserver,
      accountAdminClient: {
        authorizeAdministrator,
        authorizeFunctions,
        createBinding,
        finalizeBinding: vi.fn()
      },
      createLineIdentityClient,
      createLineReplyClient: () => ({ replyText })
    });
    const body = JSON.stringify({
      destination: "channel-destination",
      events: [
        {
          type: "message",
          webhookEventId: "login-event",
          replyToken: "reply-token",
          source: { type: "user", userId: "Uunmanaged" },
          message: { type: "text", text: "登入 HHC 帳戶" }
        }
      ]
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(createBinding).toHaveBeenCalledWith({
      expectedLineUserId: "Uunmanaged",
      profileName: "helper",
      channelId: "channel-destination",
      presentation: {
        displayName: "小哈",
        lineId: "@hhc-helper",
        providerId: "provider-1"
      }
    });
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("https://account.alive.org.tw/line/bind#token=opaque"),
      undefined
    );
    expect(authorizeAdministrator).not.toHaveBeenCalled();
    expect(createLineIdentityClient).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product_event",
        eventName: "account_link_started",
        action: "account_login",
        resultClass: "success"
      })
    );
    expect(JSON.stringify(routeObserver.mock.calls)).not.toMatch(
      /Uunmanaged|channel-destination|#token=opaque/u
    );
  });

  it.each([
    ["loose text", { type: "user", userId: "U1" }, "我想登入帳戶看看", "reply", "dest"],
    ["group", { type: "group", groupId: "C1", userId: "U1" }, "登入帳戶", "reply", "dest"],
    ["room", { type: "room", roomId: "R1", userId: "U1" }, "登入帳戶", "reply", "dest"],
    ["missing uid", { type: "user" }, "登入帳戶", "reply", "dest"],
    ["missing reply", { type: "user", userId: "U1" }, "登入帳戶", undefined, "dest"],
    ["missing destination", { type: "user", userId: "U1" }, "登入帳戶", "reply", undefined]
  ])("does not create a binding for %s", async (_label, source, text, replyToken, destination) => {
    const createBinding = vi.fn();
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn(),
        createBinding,
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = JSON.stringify({
      ...(destination ? { destination } : {}),
      events: [
        {
          type: "message",
          webhookEventId: "login-invalid",
          ...(replyToken ? { replyToken } : {}),
          source,
          message: { type: "text", text }
        }
      ]
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(createBinding).not.toHaveBeenCalled();
  });

  it("deduplicates and rate-limits explicit login before creating a binding", async () => {
    const createBinding = vi.fn();
    const duplicateApp = createApp(accessConfig(), {
      webhookEventStore: { tryStart: vi.fn().mockResolvedValue("duplicate") },
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn(),
        createBinding,
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = JSON.stringify({
      destination: "dest",
      events: [
        {
          type: "message",
          webhookEventId: "login-duplicate",
          replyToken: "reply",
          source: { type: "user", userId: "U1" },
          message: { type: "text", text: "login" }
        }
      ]
    });
    await duplicateApp.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    const rateLimitedApp = createApp(accessConfig(), {
      rateLimiter: {
        check: vi.fn().mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt: "2026-08-08T12:00:00Z"
        })
      },
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn(),
        createBinding,
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    await rateLimitedApp.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(createBinding).not.toHaveBeenCalled();
  });

  it("finalizes a byte-exact account challenge before ordinary dedupe and retries the same event after a transient failure", async () => {
    const nonce = "A".repeat(43);
    const finalizeBinding = vi
      .fn()
      .mockRejectedValueOnce(new AccountApiError("account_api_http_503", true))
      .mockResolvedValueOnce({ status: "completed" });
    const authorizeFunctions = vi.fn();
    const createBinding = vi.fn();
    const tryStart = vi.fn();
    const check = vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: "2026-08-08T12:00:00Z"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const routeObserver = vi.fn();
    const app = createApp(providerFreeMainConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions,
        createBinding,
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      }),
      webhookEventStore: { tryStart },
      rateLimiter: { check },
      routeObserver
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "challenge-event",
      deliveryContext: { isRedelivery: true },
      replyToken: "reply-token",
      source: { type: "user", userId: "Uchallenge" },
      message: { type: "text", text: `HHC_ACCOUNT_LINK_V1:${nonce}` }
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

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(200);
    expect(finalizeBinding).toHaveBeenCalledTimes(2);
    expect(finalizeBinding).toHaveBeenLastCalledWith({
      nonce,
      result: "ok",
      actualLineUserId: "Uchallenge",
      profileName: "main",
      channelId: "bot",
      webhookEventId: "challenge-event"
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(tryStart).not.toHaveBeenCalled();
    expect(authorizeFunctions).not.toHaveBeenCalled();
    expect(createBinding).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledOnce();
    const observed = JSON.stringify(routeObserver.mock.calls);
    expect(observed).not.toContain(nonce);
    expect(observed).not.toContain("HHC_ACCOUNT_LINK_V1");
  });

  it.each([
    [
      "unsupported version",
      `HHC_ACCOUNT_LINK_V2:${"A".repeat(43)}`,
      { type: "user", userId: "U1" }
    ],
    ["edited prefix", `hhc-account-link-v1:${"A".repeat(43)}`, { type: "user", userId: "U1" }],
    ["padded nonce", `HHC_ACCOUNT_LINK_V1:${"A".repeat(42)}=`, { type: "user", userId: "U1" }],
    ["overlong nonce", `HHC_ACCOUNT_LINK_V1:${"A".repeat(44)}`, { type: "user", userId: "U1" }],
    [
      "group source",
      `HHC_ACCOUNT_LINK_V1:${"A".repeat(43)}`,
      { type: "group", groupId: "C1", userId: "U1" }
    ],
    ["missing user", `HHC_ACCOUNT_LINK_V1:${"A".repeat(43)}`, { type: "user" }]
  ])("consumes malformed reserved account challenge locally: %s", async (_label, text, source) => {
    const finalizeBinding = vi.fn();
    const authorizeFunctions = vi.fn();
    const tryStart = vi.fn();
    const check = vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: "2026-08-08T12:00:00Z"
    });
    const routeObserver = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(providerFreeMainConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions,
        createBinding: vi.fn(),
        finalizeBinding
      },
      webhookEventStore: { tryStart },
      rateLimiter: { check },
      routeObserver,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "reserved-invalid",
      replyToken: "reply-token",
      source,
      message: { type: "text", text }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    expect(finalizeBinding).not.toHaveBeenCalled();
    expect(authorizeFunctions).not.toHaveBeenCalled();
    expect(tryStart).not.toHaveBeenCalled();
    expect(JSON.stringify(routeObserver.mock.calls)).not.toContain(String(text));
  });

  it("throttles valid-shaped reserved challenges before Account API finalization", async () => {
    const finalizeBinding = vi.fn();
    const tryStart = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(providerFreeMainConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      webhookEventStore: { tryStart },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn()
      }),
      rateLimiter: {
        check: vi.fn().mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt: "2026-08-08T12:00:00Z"
        })
      }
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "challenge-flood",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uflood" },
      message: { type: "text", text: `HHC_ACCOUNT_LINK_V1:${"B".repeat(43)}` }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(finalizeBinding).not.toHaveBeenCalled();
    expect(tryStart).not.toHaveBeenCalled();
  });

  it("finalizes a completed accountLink before every ordinary entrance dependency", async () => {
    const finalizeBinding = vi.fn().mockResolvedValue({ status: "completed" });
    const authorizeAdministrator = vi.fn();
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const identity = vi.fn();
    const rateCheck = vi.fn();
    const dedupe = vi.fn();
    const route = vi.fn();
    const routeObserver = vi.fn();
    const app = createApp(accessConfig(), {
      router: { route },
      routeObserver,
      accountAdminClient: {
        authorizeAdministrator,
        createBinding: vi.fn(),
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: identity,
      rateLimiter: { check: rateCheck },
      webhookEventStore: { tryStart: dedupe }
    });
    const body = accountLinkBody({
      replyToken: "reply-token",
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(finalizeBinding).toHaveBeenCalledWith({
      nonce: "native-nonce",
      result: "ok",
      actualLineUserId: "Uactual",
      profileName: "helper",
      channelId: "channel-destination",
      webhookEventId: "account-link-event"
    });
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      expect.stringContaining("已完成"),
      undefined
    );
    expect(authorizeAdministrator).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(rateCheck).not.toHaveBeenCalled();
    expect(dedupe).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product_event",
        eventName: "account_link_finalized",
        action: "account_login",
        resultClass: "success"
      })
    );
    expect(JSON.stringify(routeObserver.mock.calls)).not.toMatch(
      /Uactual|native-nonce|channel-destination/u
    );
  });

  it.each(["conflict", "expired"])(
    "acknowledges terminal accountLink %s with a generic failure reply",
    async (status) => {
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createApp(accessConfig(), {
        accountAdminClient: {
          authorizeAdministrator: vi.fn(),
          createBinding: vi.fn(),
          finalizeBinding: vi.fn().mockResolvedValue({ status })
        },
        createLineReplyClient: () => ({ replyText })
      });
      const body = accountLinkBody({
        replyToken: "reply-token",
        source: { type: "user", userId: "Uactual" },
        link: { result: "ok", nonce: "native-nonce" }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/helper",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(replyText).toHaveBeenCalledWith(
        "reply-token",
        expect.stringContaining("無法完成"),
        undefined
      );
    }
  );

  it("finalizes failed accountLink events without a source, actual UID, or reply", async () => {
    const finalizeBinding = vi.fn().mockResolvedValue({ status: "failed" });
    const replyText = vi.fn();
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = accountLinkBody({ link: { result: "failed", nonce: "native-nonce" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(finalizeBinding).toHaveBeenCalledWith({
      nonce: "native-nonce",
      result: "failed",
      profileName: "helper",
      channelId: "channel-destination",
      webhookEventId: "account-link-event"
    });
    expect(replyText).not.toHaveBeenCalled();
  });

  it.each([
    ["missing nonce", { link: { result: "ok" }, source: { type: "user", userId: "U1" } }],
    ["bad result", { link: { result: "pending", nonce: "nonce" } }],
    ["ok without direct source", { link: { result: "ok", nonce: "nonce" } }],
    [
      "ok with group source",
      { link: { result: "ok", nonce: "nonce" }, source: { type: "group", groupId: "C1" } }
    ]
  ])("ignores malformed signed accountLink: %s", async (_label, event) => {
    const finalizeBinding = vi.fn();
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = accountLinkBody(event);

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(finalizeBinding).not.toHaveBeenCalled();
  });

  it("returns retryable non-2xx and retries transient finalize redelivery without ordinary dedupe", async () => {
    const finalizeBinding = vi
      .fn()
      .mockRejectedValue(new AccountApiError("account_api_http_503", true));
    const dedupe = vi.fn();
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      webhookEventStore: { tryStart: dedupe },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = accountLinkBody({
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/helper",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });
      expect(response.statusCode).toBe(503);
    }
    expect(finalizeBinding).toHaveBeenCalledTimes(2);
    expect(dedupe).not.toHaveBeenCalled();
  });

  it("stops a mixed payload before ordinary events when accountLink finalize is transient", async () => {
    const finalizeBinding = vi
      .fn()
      .mockRejectedValue(new AccountApiError("account_api_http_503", true));
    const authorizeAdministrator = vi.fn();
    const route = vi.fn();
    const app = createApp(accessConfig(), {
      router: { route },
      accountAdminClient: {
        authorizeAdministrator,
        createBinding: vi.fn(),
        finalizeBinding
      }
    });
    const body = JSON.stringify({
      destination: "channel-destination",
      events: [
        {
          type: "message",
          webhookEventId: "ordinary-event",
          replyToken: "ordinary-reply",
          source: { type: "user", userId: "Uunmanaged" },
          message: { type: "text", text: "查服事表" }
        },
        {
          type: "accountLink",
          webhookEventId: "account-link-event",
          source: { type: "user", userId: "Uactual" },
          link: { result: "ok", nonce: "native-nonce" }
        }
      ]
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(503);
    expect(finalizeBinding).toHaveBeenCalledOnce();
    expect(authorizeAdministrator).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("emits one terminal outcome for a permanent finalize protocol error", async () => {
    const routeObserver = vi.fn();
    const app = createApp(accessConfig(), {
      routeObserver,
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding: vi
          .fn()
          .mockRejectedValue(new AccountApiError("account_api_invalid_finalize", false))
      },
      createLineReplyClient: () => ({ replyText: vi.fn() })
    });
    const body = accountLinkBody({
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    const observed = routeObserver.mock.calls.map(([event]) => event);
    expect(observed.filter((event) => event.kind === "route")).toHaveLength(1);
    expect(observed.filter((event) => event.eventName === "account_link_finalized")).toHaveLength(
      1
    );
  });

  it("reaches terminal finalize again on redelivery and replies only with a usable token", async () => {
    const finalizeBinding = vi.fn().mockResolvedValue({ status: "completed" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText })
    });
    const first = accountLinkBody({
      replyToken: "reply-token",
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });
    const second = accountLinkBody({
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    for (const body of [first, second]) {
      await app.inject({
        method: "POST",
        url: "/api/line/webhook/helper",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });
    }

    expect(finalizeBinding).toHaveBeenCalledTimes(2);
    expect(replyText).toHaveBeenCalledTimes(1);
  });

  it("acknowledges terminal finalize when the optional LINE reply fails", async () => {
    const finalizeBinding = vi.fn().mockResolvedValue({ status: "completed" });
    const replyText = vi.fn().mockRejectedValue(new Error("spent reply token"));
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = accountLinkBody({
      replyToken: "spent-reply-token",
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(finalizeBinding).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledOnce();
  });

  it("does not retry the same LINE reply token when a login-link reply fails", async () => {
    const createBinding = vi.fn().mockResolvedValue({
      bindingUrl: "https://account.alive.org.tw/line/bind#token=opaque",
      expiresAt: "2026-08-08T12:00:00Z"
    });
    const replyText = vi.fn().mockRejectedValue(new Error("spent reply token"));
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: false,
          active: false,
          administrator: false,
          allowedFunctions: []
        }),
        createBinding,
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = JSON.stringify({
      destination: "channel-destination",
      events: [
        {
          type: "message",
          webhookEventId: "login-reply-failure",
          replyToken: "spent-reply-token",
          source: { type: "user", userId: "U1" },
          message: { type: "text", text: "登入帳戶" }
        }
      ]
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(createBinding).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledOnce();
  });

  it("rejects accountLink signed for another profile before finalize", async () => {
    const finalizeBinding = vi.fn();
    const app = createApp(accessConfig(), {
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        createBinding: vi.fn(),
        finalizeBinding
      }
    });
    const body = accountLinkBody({
      source: { type: "user", userId: "Uactual" },
      link: { result: "ok", nonce: "native-nonce" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main-public",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(401);
    expect(finalizeBinding).not.toHaveBeenCalled();
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
      enabledFunctions: ["save_resource"],
      permissionRequiredFunctions: ["save_resource"]
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
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: true,
          active: true,
          administrator: false,
          allowedFunctions: ["save_resource"]
        }),
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
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

  it("ignores a stored save_resource role capability for a non-admin attachment", async () => {
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
    ).resolves.toBeUndefined();
  });

  it("does not let another group requester continue a pending attachment", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "file"],
      groupRequireWakeWord: false,
      enabledFunctions: ["save_resource"],
      permissionRequiredFunctions: ["save_resource"]
    };
    const accessStore = defaultAccessStore();
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "upload-intent-existing-test",
      type: "upload_intent",
      profileName: "main",
      requesterUserId: "Uadmin",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      router: { route: vi.fn() },
      accessStore,
      sessionStore,
      accountAdminClient: {
        authorizeAdministrator: vi.fn(),
        authorizeFunctions: vi.fn().mockResolvedValue({
          bound: true,
          active: true,
          administrator: false,
          allowedFunctions: ["save_resource"]
        }),
        createBinding: vi.fn(),
        finalizeBinding: vi.fn()
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
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
        source: { type: "group", groupId: "Cmain", userId: "Uadmin" },
        requesterUserId: "Uadmin"
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

  it("invokes the shared completion boundary exactly once for an executed postback", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const complete = vi.fn<ControlledCompletionObserver["complete"]>(async ({ result }) => ({
      ...result,
      replyText: "沒有找到符合條件的結果。請換一個關鍵字再試。"
    }));
    const app = createTestApp(testConfig(), {
      router: { route: vi.fn() },
      completionObserver: { complete },
      postbackHandlers: {
        select_schedule: vi.fn().mockResolvedValue({
          ok: true,
          replyText: "原始未找到",
          executedAction: "query_schedule",
          agentResult: { status: "not_found", replyText: "原始未找到" }
        })
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "group", groupId: "Cmain", userId: "U1" },
      postback: { data: "action=select_schedule&requestId=req-1&index=0" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(res.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ action: "query_schedule", durationMs: expect.any(Number) })
    );
    expect(replyText).toHaveBeenCalledWith(
      "reply-token",
      "沒有找到符合條件的結果。請換一個關鍵字再試。",
      undefined
    );
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

  it("retrieves an already-observed slow agent result without observing it again", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1, resultTtlMinutes: 10 }
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const deferred = createDeferred<FunctionExecutionResult | undefined>();
    const completionObserver: ControlledCompletionObserver = {
      complete: vi.fn(async ({ result }) => result)
    };
    const agentTurnRuntime = {
      handleTextTurn: vi.fn().mockReturnValue(deferred.promise)
    };
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      agentTurnRuntime,
      agentJobStore: new InMemoryAgentJobStore(),
      completionObserver,
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

    const finishedResult = {
      ok: true,
      replyText: "finished result",
      executedAction: "query_schedule" as const
    };
    await completionObserver.complete({
      context: {
        profile: config.profiles[0]!,
        event: {
          type: "message",
          source: { type: "user", userId: "Uallowed" },
          message: { type: "text", text: "lookup" }
        },
        requestId: "slow-runtime"
      },
      action: "query_schedule",
      result: finishedResult
    });
    deferred.resolve(finishedResult);
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
    expect(completionObserver.complete).toHaveBeenCalledTimes(1);
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
      provider: "deepseek"
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

function accountLinkBody(event: Record<string, unknown>): string {
  return JSON.stringify({
    destination: "channel-destination",
    events: [{ type: "accountLink", webhookEventId: "account-link-event", ...event }]
  });
}

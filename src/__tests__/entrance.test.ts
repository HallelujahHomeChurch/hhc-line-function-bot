import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AccountApiError } from "../account/account-admin-client.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import {
  InMemoryRegistrationInviteCodeStore,
  RedisRegistrationInviteCodeStore
} from "../access/registration-invite-code-store.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { createResourceMemoryObserver } from "../agent/resource-memory.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import {
  createFunctionCompletionObserver,
  type FunctionCompletionObserver
} from "../observability/function-completion.js";
import { buildAgentJobScope, InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createDownloadWeeklyPaperTextMessageHandler } from "../capabilities/download-weekly-paper.js";
import { createFindPptSlidesHandler } from "../functions/find-ppt-slides.js";
import { createQueryKnowledgeHandler } from "../functions/query-knowledge.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { signLineBody } from "../line-signature.js";
import { runMediaSyncMigrations } from "../media-sync/migrations.js";
import { PostgresMediaSyncStore } from "../media-sync/store.js";
import { InMemoryFirstSuccessStore } from "../observability/first-success-store.js";
import { createProfileRuntimeDispatcher } from "../runtime/profile-runtime.js";
import { createMainRuntime } from "../runtime/main-runtime.js";
import { createTestApp as createApp } from "../testing/create-test-app.js";
import { createTestFunctionRegistries } from "../testing/create-test-function-registries.js";
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
import { Pool } from "pg";
import { createClient } from "redis";

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
      schedulePolicy: { meetingReferences: [], domains: [] },
      generalAgent: { enabled: false, conversationWindowSeconds: 60 }
    }
  ];
  return config;
}

describe("LINE entrance", () => {
  it("lets the production-composed main runtime exclusively own Weekly Paper interruption", async () => {
    const config = providerFreeMainConfig();
    const main = config.profiles[0]!;
    main.enabledFunctions = ["download_weekly_paper", "update_own_profile"];
    main.permissionRequiredFunctions = ["update_own_profile"];
    const sessions = new InMemorySessionStore();
    const jobs = new InMemoryAgentJobStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          issueNumber: 1733,
          locale: "zh-Hant",
          issueDate: "2026-09-01",
          title: "週報",
          subtitle: "",
          downloadUrl: "/assets/0123456789abcdef0123456789abcdef?filename=1733-weekly.pdf",
          downloadFileName: "1733-weekly.pdf",
          publishedAt: "2026-09-01T00:00:00.000Z",
          version: 1
        },
        error: null,
        meta: {}
      })
    );
    const registries = createTestFunctionRegistries(config, {
      sessionStore: sessions,
      agentJobStore: jobs,
      fetchImpl
    });
    registries.functions.update_own_profile = vi.fn(async (args) => ({
      ok: true,
      replyText: args.confirm === true ? "updated" : "preview",
      writePhase: args.confirm === true ? "commit" : "preview"
    }));
    const ids = ["owner-review", "other-review"];
    const mainRuntime = createMainRuntime({
      handlers: registries.functions,
      sessions,
      jobs,
      idFactory: () => ids.shift() ?? "unexpected-review"
    });
    const owner = { type: "user" as const, userId: "Uadmin" };
    const other = { type: "user" as const, userId: "Uother" };
    const runtimeInput = (text: string, source: typeof owner) => ({
      profile: main,
      event: { type: "message" as const, source, message: { type: "text" as const, text } },
      requestId: `setup-${source.userId}-${text}`,
      configuredFunctions: [...main.enabledFunctions],
      authorizeFunctions: async (names: typeof main.enabledFunctions) => names
    });
    for (const source of [owner, other]) {
      await mainRuntime.handleTextTurn(runtimeInput("修改姓名", source));
      await mainRuntime.handleTextTurn(runtimeInput("家睿", source));
      await mainRuntime.handleTextTurn(runtimeInput("王", source));
    }
    const ownerReview = await sessions.findActionReview({
      profileName: "main",
      source: owner,
      requesterUserId: owner.userId
    });
    const otherReview = await sessions.findActionReview({
      profileName: "main",
      source: other,
      requesterUserId: other.userId
    });
    if (!ownerReview?.threadId || !otherReview?.threadId) throw new Error("missing review setup");
    const ownerScope = buildAgentJobScope("main", owner);
    const otherScope = buildAgentJobScope("main", other);
    if (!ownerScope || !otherScope) throw new Error("missing job scope");
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      sessionStore: sessions,
      agentJobStore: jobs,
      textMessageHandlers: registries.textMessages,
      profileRuntime: createProfileRuntimeDispatcher({ main: mainRuntime }),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: owner,
      message: { type: "text", text: "下載最新週報" }
    });

    await app.inject({
      method: "POST",
      url: main.webhookPath,
      headers: signedHeaders(body, main.channelSecret),
      payload: body
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(
      sessions.findActionReview({
        profileName: "main",
        source: owner,
        requesterUserId: owner.userId
      })
    ).resolves.toBeUndefined();
    await expect(sessions.get(ownerReview.threadId)).resolves.toBeUndefined();
    await expect(jobs.get(ownerReview.resultJobId, ownerScope)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(
      sessions.findActionReview({
        profileName: "main",
        source: other,
        requesterUserId: other.userId
      })
    ).resolves.toEqual(otherReview);
    await expect(sessions.get(otherReview.threadId)).resolves.toBeDefined();
    await expect(jobs.get(otherReview.resultJobId, otherScope)).resolves.toMatchObject({
      status: "pending"
    });
  });

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
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/registry <code>");
    expect(replyText.mock.calls[0]?.[1]).toContain("/whoami");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/memories");
    expect(replyText.mock.calls[0]?.[1]).not.toContain("/forget-memory <id>");
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
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("/memories");
    expect(String(replyText.mock.calls[0]?.[1])).not.toContain("/forget-memory");
  });

  it("omits direct-only and unavailable protected commands from group help", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-group-help",
      source: { type: "group", groupId: "Cmain", userId: "Uallowed" },
      message: { type: "text", text: "/help" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    const help = String(replyText.mock.calls.at(-1)?.[1]);
    expect(help).not.toContain("/whoami");
    expect(help).not.toContain("/memories");
    expect(help).not.toContain("/forget-memory");
  });

  it("hides an Account-denied memory command from otherwise authorized help", async () => {
    const config = testConfig();
    config.profiles[0]!.enabledFunctions.push("retrieve_memory");
    config.profiles[0]!.permissionRequiredFunctions = ["retrieve_memory"];
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: []
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-denied-memory-help",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/help" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(authorizeFunctions).toHaveBeenCalledOnce();
    expect(String(replyText.mock.calls.at(-1)?.[1])).not.toContain("/memories");
  });

  it("refreshes protected function authorization for each runtime callback in one event", async () => {
    const config = providerFreeMainConfig();
    config.profiles[0]!.enabledFunctions = ["query_schedule"];
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
    const authorizeFunctions = vi
      .fn()
      .mockResolvedValueOnce({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: ["query_schedule"]
      })
      .mockResolvedValueOnce({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      });
    const callbackResults: Array<readonly string[]> = [];
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(config, {
      accountAdminClient: { authorizeFunctions },
      profileRuntime: {
        async handleTextTurn(input) {
          callbackResults.push(await input.authorizeFunctions!(["query_schedule"]));
          callbackResults.push(await input.authorizeFunctions!(["query_schedule"]));
          return { ok: true, replyText: "done" };
        }
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-live-function-authorization",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "查詢測試" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(callbackResults).toEqual([["query_schedule"], []]);
    expect(authorizeFunctions).toHaveBeenCalledTimes(2);
    expect(authorizeFunctions).toHaveBeenNthCalledWith(1, {
      lineUserId: "Uallowed",
      profileName: "main",
      functionNames: ["query_schedule"]
    });
    expect(authorizeFunctions).toHaveBeenNthCalledWith(2, {
      lineUserId: "Uallowed",
      profileName: "main",
      functionNames: ["query_schedule"]
    });
  });

  it.each([
    {
      label: "denied",
      authorize: vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      })
    },
    { label: "Account unavailable", authorize: vi.fn().mockRejectedValue(new Error("offline")) }
  ])("blocks $label /memories before the legacy runtime", async ({ authorize }) => {
    const config = testConfig();
    config.profiles[0]!.enabledFunctions.push("retrieve_memory");
    config.profiles[0]!.permissionRequiredFunctions = ["retrieve_memory"];
    const handleCommand = vi.fn().mockResolvedValue({ ok: true, replyText: "unsafe memories" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions: authorize },
      memoryCommands: { handleCommand },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-protected-memories",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/memories" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(handleCommand).not.toHaveBeenCalled();
    expect(String(replyText.mock.calls.at(-1)?.[1])).toContain("權限");
  });

  it("blocks /memories when retrieve_memory is not configured after resolving Account role", async () => {
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: []
    });
    const handleCommand = vi.fn().mockResolvedValue({ ok: true, replyText: "unsafe memories" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      accountAdminClient: { authorizeFunctions },
      memoryCommands: { handleCommand },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-disabled-memories",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/memories" }
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
      functionNames: []
    });
    expect(handleCommand).not.toHaveBeenCalled();
    expect(String(replyText.mock.calls.at(-1)?.[1])).toContain("權限");
  });

  it("runs public /memories locally after resolving Account role", async () => {
    const config = testConfig();
    config.profiles[0]!.enabledFunctions.push("retrieve_memory");
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: []
    });
    const handleCommand = vi.fn().mockResolvedValue({ ok: true, replyText: "stored memories" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions },
      memoryCommands: { handleCommand },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-public-memories",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/memories" }
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
      functionNames: []
    });
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(String(replyText.mock.calls.at(-1)?.[1])).toContain("stored memories");
  });

  it.each([
    {
      label: "Account admin",
      authorization: {
        bound: true,
        active: true,
        administrator: true,
        allowedFunctions: []
      },
      expectedCalls: 1,
      expectedReply: "removed"
    },
    {
      label: "non-admin",
      authorization: {
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      },
      expectedCalls: 0,
      expectedReply: "權限"
    },
    {
      label: "Account unavailable",
      authorization: new Error("offline"),
      expectedCalls: 0,
      expectedReply: "權限"
    }
  ])(
    "applies save_memory write authority to /forget-memory for an $label",
    async ({ authorization, expectedCalls, expectedReply }) => {
      const config = testConfig();
      config.profiles[0]!.enabledFunctions.push("save_memory");
      config.profiles[0]!.permissionRequiredFunctions = [];
      const authorizeFunctions =
        authorization instanceof Error
          ? vi.fn().mockRejectedValue(authorization)
          : vi.fn().mockResolvedValue(authorization);
      const handleCommand = vi.fn().mockResolvedValue({ ok: true, replyText: "removed" });
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createTestApp(config, {
        accountAdminClient: { authorizeFunctions },
        memoryCommands: { handleCommand },
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "message",
        replyToken: "reply-forget-memory",
        source: { type: "user", userId: "Uallowed" },
        message: { type: "text", text: "/forget-memory memory-1" }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeFunctions).toHaveBeenCalledTimes(2);
      expect(handleCommand).toHaveBeenCalledTimes(expectedCalls);
      expect(String(replyText.mock.calls.at(-1)?.[1])).toContain(expectedReply);
    }
  );

  it("accepts an explicit save_memory Account grant for /forget-memory", async () => {
    const config = testConfig();
    config.profiles[0]!.enabledFunctions.push("save_memory");
    config.profiles[0]!.permissionRequiredFunctions = ["save_memory"];
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: ["save_memory"]
    });
    const handleCommand = vi.fn().mockResolvedValue({ ok: true, replyText: "removed" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions },
      memoryCommands: { handleCommand },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-granted-forget-memory",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "/forget-memory memory-1" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(authorizeFunctions).toHaveBeenCalledTimes(2);
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(String(replyText.mock.calls.at(-1)?.[1])).toContain("removed");
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
    for (const command of ["/whoami"]) {
      expect(helpText).toContain(command);
      expect(introText).not.toContain(command);
    }
    for (const command of ["/registry", "/memories", "/forget-memory"]) {
      expect(helpText).not.toContain(command);
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

  it("binds an active helper group to media sync through the signed webhook only", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const route = vi.fn<FunctionRouterPort["route"]>();
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cmedia",
      createdBy: "Uroot"
    });
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    const findActiveBinding = vi
      .spyOn(mediaSyncStore, "findActiveBinding")
      .mockResolvedValue(undefined);
    const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({
      status: "bound",
      binding: {
        id: "binding-1",
        profileName: "helper",
        groupId: "Cmedia",
        collectionId: "collection-1",
        groupDisplayName: "影音同工群",
        bindingCodeCreatedByHhcUserId: "manager-1",
        boundAt: "2026-08-16T00:00:00.000Z"
      }
    });
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn(),
      getGroupDisplayName: vi.fn().mockResolvedValue("影音同工群")
    };
    const app = createApp(accessConfig(), {
      router: { route },
      accessStore,
      mediaSyncStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-media",
      source: { type: "group", groupId: "Cmedia" },
      message: { type: "text", text: "/media-sync BIND-CODE" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(identityClient.getGroupDisplayName).toHaveBeenCalledWith("Cmedia");
    expect(findActiveBinding).toHaveBeenCalledWith({ profileName: "helper", groupId: "Cmedia" });
    expect(bindWithCode).toHaveBeenCalledWith({
      profileName: "helper",
      code: "BIND-CODE",
      groupId: "Cmedia",
      groupDisplayName: "影音同工群",
      boundByLineUserId: undefined
    });
    expect(replyText).toHaveBeenCalledWith(
      "reply-media",
      "已綁定這個群組的媒體資料夾。",
      undefined
    );
    await app.close();
  });

  it.each([
    [
      "main profile",
      "/api/line/webhook/main-public",
      "main-secret",
      { type: "group", groupId: "Cmedia", userId: "Umedia" },
      undefined
    ],
    [
      "direct source",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "user", userId: "Umedia" },
      "此指令只能在已開通的小哈群組中使用。"
    ],
    [
      "room source",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "room", roomId: "Rmedia", userId: "Umedia" },
      undefined
    ],
    [
      "missing code",
      "/api/line/webhook/helper",
      "helper-secret",
      { type: "group", groupId: "Cmedia", userId: "Umedia" },
      "請使用 /media-sync <code>。"
    ]
  ] as const)(
    "does not bind media sync from %s",
    async (_caseName, url, secret, source, expectedReply) => {
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
      const findActiveBinding = vi
        .spyOn(mediaSyncStore, "findActiveBinding")
        .mockResolvedValue(undefined);
      const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({
        status: "invalid_code"
      });
      const app = createApp(accessConfig(), {
        accessStore: new InMemoryAccessStore(),
        mediaSyncStore,
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "message",
        replyToken: "reply-media-rejected",
        source,
        message: {
          type: "text",
          text: _caseName === "missing code" ? "/media-sync" : "/media-sync BIND-CODE"
        }
      });

      const response = await app.inject({
        method: "POST",
        url,
        headers: signedHeaders(body, secret),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(findActiveBinding).not.toHaveBeenCalled();
      expect(bindWithCode).not.toHaveBeenCalled();
      if (expectedReply) {
        expect(replyText).toHaveBeenCalledWith("reply-media-rejected", expectedReply, undefined);
      } else {
        expect(replyText).not.toHaveBeenCalled();
      }
      await app.close();
    }
  );

  it("requires the existing active helper group registration before a media sync bind", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    const findActiveBinding = vi
      .spyOn(mediaSyncStore, "findActiveBinding")
      .mockResolvedValue(undefined);
    const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({
      status: "invalid_code"
    });
    const app = createApp(accessConfig(), {
      accessStore: new InMemoryAccessStore(),
      mediaSyncStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-media-inactive",
      source: { type: "group", groupId: "Cinactive", userId: "Umedia" },
      message: { type: "text", text: "/media-sync BIND-CODE" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(findActiveBinding).not.toHaveBeenCalled();
    expect(bindWithCode).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith(
      "reply-media-inactive",
      expect.stringContaining("尚未開通"),
      undefined
    );
    await app.close();
  });

  it("requires exactly one binding code from an active helper group", async () => {
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cmedia",
      createdBy: "Uroot"
    });
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    const findActiveBinding = vi
      .spyOn(mediaSyncStore, "findActiveBinding")
      .mockResolvedValue(undefined);
    const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({
      status: "invalid_code"
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      accessStore,
      mediaSyncStore,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-media-arguments",
      source: { type: "group", groupId: "Cmedia", userId: "Umedia" },
      message: { type: "text", text: "/media-sync BIND-CODE extra" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(findActiveBinding).not.toHaveBeenCalled();
    expect(bindWithCode).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith(
      "reply-media-arguments",
      "請使用 /media-sync <code>。",
      undefined
    );
    await app.close();
  });

  it("does not consume a code when an active group is already bound or its display-name lookup fails", async () => {
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cmedia",
      createdBy: "Uroot"
    });
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    const findActiveBinding = vi.spyOn(mediaSyncStore, "findActiveBinding");
    const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({
      status: "invalid_code"
    });
    const identityClient: LineIdentityClient = {
      getUserDisplayName: vi.fn(),
      getGroupDisplayName: vi.fn()
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      accessStore,
      mediaSyncStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => identityClient
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-media-existing",
      source: { type: "group", groupId: "Cmedia", userId: "Umedia" },
      message: { type: "text", text: "/media-sync BIND-CODE" }
    });

    findActiveBinding.mockResolvedValueOnce({
      id: "binding-existing",
      profileName: "helper",
      groupId: "Cmedia",
      collectionId: "collection-existing",
      groupDisplayName: "Already bound",
      bindingCodeCreatedByHhcUserId: "manager-1",
      boundAt: "2026-08-16T00:00:00.000Z"
    });
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });
    expect(replyText).toHaveBeenLastCalledWith(
      "reply-media-existing",
      "已經綁定過，無法二次綁定。",
      undefined
    );
    expect(identityClient.getGroupDisplayName).not.toHaveBeenCalled();
    expect(bindWithCode).not.toHaveBeenCalled();

    findActiveBinding.mockResolvedValueOnce(undefined);
    vi.mocked(identityClient.getGroupDisplayName).mockRejectedValueOnce(
      new Error("line unavailable")
    );
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });
    expect(bindWithCode).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenLastCalledWith(
      "reply-media-existing",
      expect.stringContaining("無法取得群組名稱"),
      undefined
    );
    findActiveBinding.mockResolvedValueOnce(undefined);
    vi.mocked(identityClient.getGroupDisplayName).mockResolvedValueOnce(undefined);
    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });
    expect(bindWithCode).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes two independent active helper groups to the atomic binding boundary", async () => {
    const accessStore = new InMemoryAccessStore();
    for (const groupId of ["Cmedia-one", "Cmedia-two"]) {
      await accessStore.addPrincipal({
        profileName: "helper",
        type: "group",
        principalId: groupId,
        createdBy: "Uroot"
      });
    }
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    vi.spyOn(mediaSyncStore, "findActiveBinding").mockResolvedValue(undefined);
    const bindWithCode = vi
      .spyOn(mediaSyncStore, "bindWithCode")
      .mockImplementation(async (input) => ({
        status: "bound",
        binding: {
          id: `binding-${input.groupId}`,
          profileName: input.profileName,
          groupId: input.groupId,
          collectionId: `collection-${input.groupId}`,
          groupDisplayName: input.groupDisplayName,
          boundByLineUserId: input.boundByLineUserId,
          bindingCodeCreatedByHhcUserId: "manager-1",
          boundAt: "2026-08-16T00:00:00.000Z"
        }
      }));
    const app = createApp(accessConfig(), {
      accessStore,
      mediaSyncStore,
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn().mockImplementation(async (groupId) => `群組 ${groupId}`)
      })
    });
    for (const [groupId, code] of [
      ["Cmedia-one", "BIND-CODE-ONE"],
      ["Cmedia-two", "BIND-CODE-TWO"]
    ]) {
      const body = lineBody({
        type: "message",
        replyToken: `reply-${groupId}`,
        source: { type: "group", groupId, userId: "Umedia" },
        message: { type: "text", text: `/media-sync ${code}` }
      });
      await app.inject({
        method: "POST",
        url: "/api/line/webhook/helper",
        headers: signedHeaders(body, "helper-secret"),
        payload: body
      });
    }

    expect(bindWithCode).toHaveBeenCalledTimes(2);
    expect(bindWithCode).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ groupId: "Cmedia-one", code: "BIND-CODE-ONE" })
    );
    expect(bindWithCode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ groupId: "Cmedia-two", code: "BIND-CODE-TWO" })
    );
    await app.close();
  });

  it.each([
    ["invalid_code", "綁定碼無效、已過期或已使用。"],
    ["group_already_bound", "已經綁定過，無法二次綁定。"],
    ["collection_already_bound", "這個媒體資料夾已綁定其他群組。"]
  ] as const)("keeps media sync binding conflicts safe (%s)", async (status, reply) => {
    const accessStore = new InMemoryAccessStore();
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "Cmedia",
      createdBy: "Uroot"
    });
    const mediaSyncStore = new PostgresMediaSyncStore({} as Pool);
    vi.spyOn(mediaSyncStore, "findActiveBinding").mockResolvedValue(undefined);
    const bindWithCode = vi.spyOn(mediaSyncStore, "bindWithCode").mockResolvedValue({ status });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createApp(accessConfig(), {
      accessStore,
      mediaSyncStore,
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(),
        getGroupDisplayName: vi.fn().mockResolvedValue("影音同工群")
      })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-media-conflict",
      source: { type: "group", groupId: "Cmedia", userId: "Umedia" },
      message: { type: "text", text: "/media-sync BIND-CODE" }
    });

    await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(bindWithCode).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledWith("reply-media-conflict", reply, undefined);
    await app.close();
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

  it("keeps public main direct functions provider-free and blocks group events without replying", async () => {
    const deepSeekGenerate = vi.fn<TextGenerationProvider["completeText"]>();
    const embedding = vi.fn().mockResolvedValue([[0]]);
    const replyText = vi.fn<LineReplyClient["replyText"]>();
    const app = createTestApp(providerFreeMainConfig(), {
      textGenerator: { completeText: deepSeekGenerate },
      textFallbackGenerator: { completeText: deepSeekGenerate },
      textMessageHandlers: {
        main_weekly_paper: createDownloadWeeklyPaperTextMessageHandler(
          vi.fn().mockResolvedValue(
            Response.json({
              data: {
                issueNumber: 1733,
                locale: "zh-Hant",
                issueDate: "2026-09-01",
                title: "週報",
                subtitle: "",
                downloadUrl: "/assets/0123456789abcdef0123456789abcdef?filename=1733-weekly.pdf",
                downloadFileName: "1733-weekly.pdf",
                publishedAt: "2026-09-01T00:00:00.000Z",
                version: 1
              },
              error: null,
              meta: {}
            })
          )
        )
      },
      functionRegistry: {
        query_knowledge: createQueryKnowledgeHandler({
          store: new InMemoryKnowledgeStore(),
          embedding: {
            provider: "azure_openai",
            model: "text-embedding-3-small",
            dimensions: 1,
            embed: embedding
          }
        })
      },
      createLineReplyClient: () => ({ replyText })
    });

    const directBody = lineBody({
      type: "message",
      replyToken: "reply-token-1",
      source: { type: "user", userId: "Uany" },
      message: { type: "text", text: "下載第 1733 期週報" }
    });
    const directRes = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(directBody, "main-secret"),
      payload: directBody
    });

    const groupBody = lineBody({
      type: "message",
      replyToken: "reply-token-2",
      source: { type: "group", groupId: "Cblocked", userId: "Uany" },
      message: { type: "text", text: "下載第 1733 期週報" }
    });
    const groupRes = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(groupBody, "main-secret"),
      payload: groupBody
    });

    expect(directRes.statusCode).toBe(200);
    expect(groupRes.statusCode).toBe(200);
    expect(groupRes.json()).toMatchObject({ ok: true, ignored: true, reason: "group_blocked" });
    expect(replyText).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledWith(
      "reply-token-1",
      expect.stringContaining("第 1733 期週報"),
      expect.anything()
    );
    expect(replyText.mock.calls.some(([token]) => token === "reply-token-2")).toBe(false);
    expect(deepSeekGenerate).not.toHaveBeenCalled();
    expect(embedding).not.toHaveBeenCalled();
  });

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

  it("continues an administrator's pending direct attachment without a registration prompt", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"],
      permissionRequiredFunctions: ["save_resource"],
      registration: { enabled: true }
    };
    const router: FunctionRouterPort = { route: vi.fn() };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const continuePendingAttachment = vi.fn().mockResolvedValue({
      ok: true,
      replyText: "這個檔案要保存成哪一種用途？"
    });
    const authorizeFunctions = vi.fn(async ({ functionNames }) => ({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: functionNames
    }));
    const sessionStore = new InMemorySessionStore();
    const app = createTestApp(config, {
      router,
      sessionStore,
      attachmentTextHandlers: [
        {
          capability: "save_resource",
          matches: vi.fn().mockResolvedValue(true),
          handle: continuePendingAttachment
        }
      ],
      accountAdminClient: { authorizeFunctions },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "Uaccountadmin" },
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
        source: { type: "user", userId: "Uaccountadmin" },
        requesterUserId: "Uaccountadmin"
      })
    ).resolves.toMatchObject({
      action: "save_resource",
      stage: "awaiting_opt_in",
      attachment: { messageId: "image-1", messageType: "image" }
    });
    expect(router.route).not.toHaveBeenCalled();

    replyText.mockClear();
    const confirmationBody = lineBody({
      type: "message",
      replyToken: "confirmation-reply-token",
      source: { type: "user", userId: "Uaccountadmin" },
      message: { type: "text", text: "是" }
    });

    const confirmationResponse = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(confirmationBody, "main-secret"),
      payload: confirmationBody
    });

    expect(confirmationResponse.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith(
      "confirmation-reply-token",
      "這個檔案要保存成哪一種用途？",
      undefined
    );
    expect(continuePendingAttachment).toHaveBeenCalledOnce();
    expect(authorizeFunctions).toHaveBeenCalledTimes(3);
    expect(authorizeFunctions.mock.calls[1]?.[0]).toMatchObject({
      functionNames: ["save_resource"]
    });
  });

  it("resolves a managed direct Account role before a locally allowed continuation", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      registration: { enabled: true }
    };
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: []
    });
    const handle = vi.fn().mockResolvedValue({ ok: true, replyText: "continued" });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions },
      textMessageHandlers: {
        role_probe: {
          capability: "query_schedule",
          matches: vi.fn().mockResolvedValue(true),
          handle
        }
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "role-reply-token",
      source: { type: "user", userId: "Uallowed" },
      message: { type: "text", text: "繼續" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith("role-reply-token", "continued", undefined);
    expect(handle.mock.calls[0]?.[1]).toMatchObject({ requesterIsAdmin: true });
    expect(authorizeFunctions).toHaveBeenCalledOnce();
    expect(authorizeFunctions).toHaveBeenCalledWith({
      lineUserId: "Uallowed",
      profileName: "main",
      functionNames: []
    });
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
      select_ppt: { capability: "find_ppt_slides", handle: handleSelect }
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

  it("authorizes a permission-required selection once before invoking its declared capability", async () => {
    const config = testConfig();
    config.profiles[0]!.permissionRequiredFunctions = ["find_ppt_slides"];
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const handle = vi.fn().mockResolvedValue({ ok: true, replyText: "authorized selection" });
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: ["find_ppt_slides"]
    });
    const postbackHandlers: PostbackHandlerRegistry = {
      select_ppt: { capability: "find_ppt_slides", handle }
    };
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      accountAdminClient: { authorizeFunctions },
      postbackHandlers,
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-selection-allowed",
      source: { type: "user", userId: "Uallowed" },
      postback: { data: "action=select_ppt&requestId=req-allowed&index=0" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledWith(
      "reply-selection-allowed",
      "authorized selection",
      undefined
    );
    expect(authorizeFunctions).toHaveBeenCalledTimes(2);
    expect(authorizeFunctions).toHaveBeenCalledWith({
      lineUserId: "Uallowed",
      profileName: "main",
      functionNames: ["find_ppt_slides"]
    });
  });

  it.each([
    {
      label: "revoked",
      authorize: vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      })
    },
    { label: "Account unavailable", authorize: vi.fn().mockRejectedValue(new Error("offline")) }
  ])(
    "fails a $label permission-required selection closed before its handler",
    async ({ authorize, label }) => {
      const config = testConfig();
      config.profiles[0]!.permissionRequiredFunctions = ["find_ppt_slides"];
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const handle = vi.fn().mockResolvedValue({ ok: true, replyText: "unsafe selection" });
      const postbackHandlers: PostbackHandlerRegistry = {
        select_ppt: { capability: "find_ppt_slides", handle }
      };
      const app = createTestApp(config, {
        router: { route: vi.fn() },
        accountAdminClient: { authorizeFunctions: authorize },
        postbackHandlers,
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "postback",
        replyToken: `reply-selection-${label}`,
        source: { type: "user", userId: "Uallowed" },
        postback: { data: "action=select_ppt&requestId=req-denied&index=0" }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(handle).not.toHaveBeenCalled();
      expect(replyText.mock.calls.at(-1)?.[1]).toContain("權限");
      expect(authorize).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    {
      label: "allowed",
      authorization: {
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: ["query_schedule"]
      },
      expectedReply: "stored schedule result"
    },
    {
      label: "revoked",
      authorization: {
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      },
      expectedReply: "權限"
    }
  ])(
    "reauthorizes a $label completed slow job once before delivery",
    async ({ authorization, expectedReply }) => {
      const config = testConfig();
      config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
      const jobStore = new InMemoryAgentJobStore();
      const job = await jobStore.createPending({
        scope: {
          profileName: "main",
          sourceKey: "user:Uallowed",
          requesterUserId: "Uallowed"
        },
        capability: "query_schedule",
        label: "schedule",
        ttlMs: 60_000
      });
      await jobStore.complete(job.id, { ok: true, replyText: "stored schedule result" });
      const authorizeFunctions = vi.fn().mockResolvedValue(authorization);
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createTestApp(config, {
        router: { route: vi.fn() },
        agentJobStore: jobStore,
        accountAdminClient: { authorizeFunctions },
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "postback",
        replyToken: "reply-job",
        source: { type: "user", userId: "Uallowed" },
        postback: { data: `action=agent_job_result&jobId=${job.id}` }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(replyText.mock.calls.at(-1)?.[1]).toContain(expectedReply);
      expect(authorizeFunctions).toHaveBeenCalledTimes(2);
      expect(authorizeFunctions).toHaveBeenCalledWith({
        lineUserId: "Uallowed",
        profileName: "main",
        functionNames: ["query_schedule"]
      });
    }
  );

  it("fails a completed slow job closed when Account authorization is unavailable", async () => {
    const config = testConfig();
    config.profiles[0]!.permissionRequiredFunctions = ["query_schedule"];
    const jobStore = new InMemoryAgentJobStore();
    const job = await jobStore.createPending({
      scope: {
        profileName: "main",
        sourceKey: "user:Uallowed",
        requesterUserId: "Uallowed"
      },
      capability: "query_schedule",
      label: "schedule",
      ttlMs: 60_000
    });
    await jobStore.complete(job.id, { ok: true, replyText: "unsafe stored result" });
    const authorizeFunctions = vi.fn().mockRejectedValue(new Error("offline"));
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      agentJobStore: jobStore,
      accountAdminClient: { authorizeFunctions },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-job-offline",
      source: { type: "user", userId: "Uallowed" },
      postback: { data: `action=agent_job_result&jobId=${job.id}` }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(replyText.mock.calls.at(-1)?.[1]).toContain("權限");
    expect(replyText.mock.calls.at(-1)?.[1]).not.toContain("unsafe stored result");
    expect(authorizeFunctions).toHaveBeenCalledTimes(2);
  });

  it("fails a legacy completed slow job without an owning capability closed after resolving role", async () => {
    const jobStore = new InMemoryAgentJobStore();
    const job = await jobStore.createPending({
      scope: {
        profileName: "main",
        sourceKey: "user:Uallowed",
        requesterUserId: "Uallowed"
      },
      label: "legacy ownerless",
      ttlMs: 60_000
    });
    await jobStore.complete(job.id, { ok: true, replyText: "unsafe legacy result" });
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: false,
      allowedFunctions: []
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(testConfig(), {
      agentJobStore: jobStore,
      accountAdminClient: { authorizeFunctions },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-ownerless-job",
      source: { type: "user", userId: "Uallowed" },
      postback: { data: `action=agent_job_result&jobId=${job.id}` }
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
      functionNames: []
    });
    expect(String(replyText.mock.calls.at(-1)?.[1])).toContain("權限");
    expect(String(replyText.mock.calls.at(-1)?.[1])).not.toContain("unsafe legacy result");
  });

  it.each([
    {
      label: "Account admin",
      authorize: vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: true,
        allowedFunctions: []
      }),
      expectedReply: "stored write result"
    },
    {
      label: "non-admin",
      authorize: vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: []
      }),
      expectedReply: "權限"
    },
    {
      label: "Account unavailable",
      authorize: vi.fn().mockRejectedValue(new Error("offline")),
      expectedReply: "權限"
    }
  ])(
    "applies unlisted-write admin authority to a $label slow job",
    async ({ authorize, expectedReply }) => {
      const config = testConfig();
      config.profiles[0]!.enabledFunctions = ["query_schedule", "save_resource"];
      config.profiles[0]!.permissionRequiredFunctions = [];
      const jobStore = new InMemoryAgentJobStore();
      const job = await jobStore.createPending({
        scope: {
          profileName: "main",
          sourceKey: "user:Uallowed",
          requesterUserId: "Uallowed"
        },
        capability: "save_resource",
        label: "save resource",
        ttlMs: 60_000
      });
      await jobStore.complete(job.id, {
        ok: true,
        replyText: "stored write result",
        executedAction: "save_resource"
      });
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const app = createTestApp(config, {
        agentJobStore: jobStore,
        accountAdminClient: { authorizeFunctions: authorize },
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "postback",
        replyToken: "reply-write-job",
        source: { type: "user", userId: "Uallowed" },
        postback: { data: `action=agent_job_result&jobId=${job.id}` }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook/main",
        headers: signedHeaders(body, "main-secret"),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(replyText.mock.calls.at(-1)?.[1]).toContain(expectedReply);
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenCalledWith({
        lineUserId: "Uallowed",
        profileName: "main",
        functionNames: []
      });
    }
  );

  it("does not let Account administrator status bypass an explicit function permission", async () => {
    const config = testConfig();
    config.profiles[0]!.permissionRequiredFunctions = ["find_ppt_slides"];
    const handle = vi.fn().mockResolvedValue({ ok: true, replyText: "unsafe selection" });
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: []
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: { authorizeFunctions },
      postbackHandlers: {
        select_ppt: { capability: "find_ppt_slides", handle }
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "reply-explicit-admin-denied",
      source: { type: "user", userId: "Uallowed" },
      postback: { data: "action=select_ppt&requestId=req-explicit-admin&index=0" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      headers: signedHeaders(body, "main-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(handle).not.toHaveBeenCalled();
    expect(replyText.mock.calls.at(-1)?.[1]).toContain("權限");
    expect(authorizeFunctions).toHaveBeenCalledTimes(2);
  });

  it("invokes the shared completion boundary exactly once for an executed postback", async () => {
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const complete = vi.fn<FunctionCompletionObserver["complete"]>(async ({ result }) => ({
      ...result,
      replyText: "沒有找到符合條件的結果。請換一個關鍵字再試。"
    }));
    const app = createTestApp(testConfig(), {
      router: { route: vi.fn() },
      completionObserver: { complete },
      postbackHandlers: {
        select_schedule: {
          capability: "query_schedule",
          handle: vi.fn().mockResolvedValue({
            ok: true,
            replyText: "原始未找到",
            executedAction: "query_schedule",
            agentResult: { status: "not_found", replyText: "原始未找到" }
          })
        }
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

  it("retrieves an already-observed slow agent result without observing it again", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0],
      longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1, resultTtlMinutes: 10 }
    };
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const deferred = createDeferred<FunctionExecutionResult | undefined>();
    const completionObserver: FunctionCompletionObserver = {
      complete: vi.fn(async ({ result }) => result)
    };
    const agentTurnRuntime = {
      observesCompletion: true,
      handleTextTurn: vi.fn().mockReturnValue(deferred.promise)
    };
    const app = createTestApp(config, {
      router: { route: vi.fn() },
      profileRuntime: agentTurnRuntime,
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
        capability: "find_ppt_slides",
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
        capability: "find_ppt_slides",
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

  it("dispatches only the owning requester through a pending group review without a wake word", async () => {
    const config = accessConfig();
    const helper = config.profiles[0]!;
    const source = { type: "group" as const, groupId: "Cmain", userId: "Uowner" };
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "review-1",
      type: "action_review",
      profileName: helper.name,
      requesterUserId: "Uowner",
      source,
      threadId: "thread-1",
      interruptId: "interrupt-1",
      toolName: "propose_save_memory",
      argumentsHash: "hash",
      policyKey: "policy",
      resultJobId: "job-1",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const handleTextTurn = vi.fn(async () => ({ ok: true, replyText: "review resumed" }));
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      sessionStore: sessions,
      profileRuntime: { handleTextTurn },
      accessStore: new InMemoryAccessStore({
        principals: [
          {
            id: "helper-review-group",
            profileName: helper.name,
            type: "group",
            principalId: "Cmain",
            createdAt: "2026-09-05T00:00:00.000Z",
            createdBy: "test"
          }
        ]
      }),
      createLineReplyClient: () => ({ replyText })
    });
    const ownerBody = lineBody({
      type: "message",
      replyToken: "owner-token",
      source,
      message: { type: "text", text: "確認" }
    });
    const otherBody = lineBody({
      type: "message",
      replyToken: "other-token",
      source: { ...source, userId: "Uother" },
      message: { type: "text", text: "確認" }
    });

    await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(ownerBody, helper.channelSecret),
      payload: ownerBody
    });
    await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(otherBody, helper.channelSecret),
      payload: otherBody
    });

    expect(handleTextTurn).toHaveBeenCalledOnce();
    expect(handleTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ source }) })
    );
    expect(replyText).toHaveBeenCalledOnce();
  });

  it("routes consented research to helper while keeping other deterministic continuations outside it", async () => {
    const config = accessConfig();
    const helper = config.profiles[0]!;
    helper.enabledFunctions = ["find_sheet_music", "find_ppt_slides", "save_resource"];
    helper.permissionRequiredFunctions = [];
    const profileTurn = vi.fn(async () => ({ ok: true, replyText: "model" }));
    const handlers = {
      sheet_music_numeric_selection: {
        capability: "find_sheet_music" as const,
        matches: ({ text }: { text: string }) => text === "上網找",
        handle: vi.fn(async () => ({
          ok: true,
          replyText: "外部歌譜",
          executedAction: "find_sheet_music" as const,
          agentResource: {
            resourceType: "sheet_music" as const,
            title: "歌譜",
            storage: { provider: "external_link" as const, url: "https://example.test/music.pdf" }
          }
        }))
      },
      ppt_numeric_selection: {
        capability: "find_ppt_slides" as const,
        matches: ({ text }: { text: string }) => text === "1",
        handle: vi.fn(async () => ({
          ok: true,
          replyText: "投影片 1",
          executedAction: "find_ppt_slides" as const
        }))
      },
      pending_attachment_answer: {
        capability: "save_resource" as const,
        matches: vi.fn(({ text }: { text: string }) => text === "是"),
        handle: vi.fn(async () => ({ ok: true, replyText: "請選用途" }))
      }
    };
    const memoryStore = new InMemoryAgentMemoryStore();
    const resourceMemory = createResourceMemoryObserver({ memoryStore });
    const afterFunctionResult = vi.spyOn(resourceMemory, "afterFunctionResult");
    const complete = vi.fn<FunctionCompletionObserver["complete"]>(async ({ result }) => result);
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      profileRuntime: createProfileRuntimeDispatcher({
        helper: {
          acceptSheetMusicResearch: async ({ event }) =>
            event.message?.text === "上網找" ? { kind: "accepted" as const } : undefined,
          handleTextTurn: profileTurn
        }
      }),
      textMessageHandlers: {
        sheet_music_numeric_selection: handlers.sheet_music_numeric_selection,
        ppt_numeric_selection: handlers.ppt_numeric_selection
      },
      attachmentTextHandlers: [handlers.pending_attachment_answer],
      resourceMemory,
      completionObserver: { complete },
      createLineReplyClient: () => ({ replyText })
    });

    for (const [index, text] of ["上網找", "1", "是"].entries()) {
      const body = lineBody({
        type: "message",
        replyToken: `continuation-${index}`,
        source: { type: "user", userId: "Uroot" },
        message: { type: "text", text }
      });
      const response = await app.inject({
        method: "POST",
        url: helper.webhookPath,
        headers: signedHeaders(body, helper.channelSecret),
        payload: body
      });
      expect(response.statusCode).toBe(200);
    }

    expect(handlers.sheet_music_numeric_selection.handle).not.toHaveBeenCalled();
    expect(handlers.ppt_numeric_selection.handle).toHaveBeenCalledOnce();
    expect(handlers.pending_attachment_answer.handle).toHaveBeenCalledOnce();
    expect(profileTurn).toHaveBeenCalledOnce();
    expect(afterFunctionResult).not.toHaveBeenCalled();
    await expect(memoryStore.summary()).resolves.toMatchObject({ resources: 0 });
    expect(complete).toHaveBeenCalledOnce();
    expect(replyText.mock.calls.map(([, text]) => text)).toEqual(["model", "投影片 1", "請選用途"]);
  });

  it.each(["match", "completion"] as const)(
    "returns a bounded support reply when attachment %s fails",
    async (failurePoint) => {
      const config = accessConfig();
      const helper = config.profiles[0]!;
      helper.enabledFunctions = ["save_resource"];
      helper.permissionRequiredFunctions = [];
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const profileTurn = vi.fn(async () => ({ ok: true, replyText: "model" }));
      const record = vi.fn(async () => undefined);
      const completion = vi.fn<FunctionCompletionObserver["complete"]>(async ({ result }) => {
        if (failurePoint === "completion") throw new Error("completion failed");
        return result;
      });
      const app = createTestApp(config, {
        profileRuntime: createProfileRuntimeDispatcher({
          helper: { handleTextTurn: profileTurn }
        }),
        attachmentTextHandlers: [
          {
            capability: "save_resource",
            matches: vi.fn(async () => {
              if (failurePoint === "match") throw new Error("match failed");
              return true;
            }),
            handle: vi.fn(async () => ({
              ok: true,
              replyText: "queued",
              executedAction: "save_resource",
              writePhase: "commit"
            }))
          }
        ],
        completionObserver: { complete: completion },
        lastErrorStore: { record, list: vi.fn(async () => []), clear: vi.fn(async () => 0) },
        createLineReplyClient: () => ({ replyText })
      });
      const body = lineBody({
        type: "message",
        replyToken: `attachment-${failurePoint}`,
        source: { type: "user", userId: "Uroot" },
        message: { type: "text", text: "保存" }
      });

      const response = await app.inject({
        method: "POST",
        url: helper.webhookPath,
        headers: signedHeaders(body, helper.channelSecret),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(replyText).toHaveBeenCalledOnce();
      expect(replyText.mock.calls[0]?.[1]).toContain("支援碼");
      expect(profileTurn).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "function", action: "save_resource" })
      );
    }
  );

  it("returns a helper research cancellation without entering continuations or the model", async () => {
    const config = accessConfig();
    const helper = config.profiles[0]!;
    helper.enabledFunctions = ["find_sheet_music"];
    const profileTurn = vi.fn(async () => ({ ok: true, replyText: "model" }));
    const continuation = vi.fn(async () => ({ ok: true, replyText: "legacy" }));
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      profileRuntime: createProfileRuntimeDispatcher({
        helper: {
          acceptSheetMusicResearch: async () => ({
            kind: "handled" as const,
            result: { ok: true, replyText: "好，我不做外部搜尋。" }
          }),
          handleTextTurn: profileTurn
        }
      }),
      textMessageHandlers: {
        sheet_music_numeric_selection: {
          capability: "find_sheet_music",
          matches: vi.fn(async () => true),
          handle: continuation
        }
      },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      replyToken: "research-cancel",
      source: { type: "user", userId: "Uroot" },
      message: { type: "text", text: "不用" }
    });

    const response = await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(body, helper.channelSecret),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(replyText).toHaveBeenCalledWith("research-cancel", "好，我不做外部搜尋。", undefined);
    expect(continuation).not.toHaveBeenCalled();
    expect(profileTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["allowed", true],
    ["revoked", false]
  ] as const)(
    "rechecks a deterministic continuation capability against Account authorization: %s",
    async (_label, allowed) => {
      const config = accessConfig();
      const helper = config.profiles[0]!;
      helper.enabledFunctions = ["query_schedule"];
      helper.permissionRequiredFunctions = ["query_schedule"];
      helper.directAccessPolicy = "public";
      helper.registration = { enabled: false };
      const source = { type: "user" as const, userId: "Uresolution" };
      const querySchedule = vi.fn(async () => ({ ok: true, replyText: "主日服事表" }));
      const profileTurn = vi.fn(async () => ({ ok: true, replyText: "model" }));
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      const authorizeFunctions = vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        administrator: false,
        allowedFunctions: allowed ? ["query_schedule"] : []
      });
      const app = createTestApp(config, {
        profileRuntime: createProfileRuntimeDispatcher({
          helper: { handleTextTurn: profileTurn }
        }),
        textMessageHandlers: {
          schedule_selection: {
            capability: "query_schedule",
            matches: vi.fn(async () => true),
            handle: querySchedule
          }
        },
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
        replyToken: `resolution-${_label}`,
        source,
        message: { type: "text", text: "主日服事" }
      });

      const response = await app.inject({
        method: "POST",
        url: helper.webhookPath,
        headers: signedHeaders(body, helper.channelSecret),
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeFunctions).toHaveBeenCalledOnce();
      expect(authorizeFunctions).toHaveBeenCalledWith({
        lineUserId: source.userId,
        profileName: helper.name,
        functionNames: ["query_schedule"]
      });
      expect(querySchedule).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(profileTurn).toHaveBeenCalledTimes(allowed ? 0 : 1);
      expect(replyText).toHaveBeenCalledWith(
        `resolution-${_label}`,
        allowed ? "主日服事表" : "model",
        undefined
      );
    }
  );

  it("lets a requester-scoped group intro preserve a pending attachment continuation", async () => {
    const config = accessConfig();
    const helper = config.profiles[0]!;
    helper.enabledFunctions = ["save_resource"];
    helper.permissionRequiredFunctions = [];
    const source = { type: "group" as const, groupId: "Cmain", userId: "Uowner" };
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "pending-upload",
      type: "pending_attachment",
      action: "save_resource",
      stage: "awaiting_opt_in",
      profileName: helper.name,
      requesterUserId: source.userId,
      source,
      attachment: { messageId: "file-1", messageType: "file" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const handle = vi.fn(async () => ({ ok: true, replyText: "continuation" }));
    const profileTurn = vi.fn(async () => ({ ok: true, replyText: "model" }));
    const authorizeFunctions = vi.fn().mockResolvedValue({
      bound: true,
      active: true,
      administrator: true,
      allowedFunctions: ["save_resource"]
    });
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      sessionStore: sessions,
      profileRuntime: createProfileRuntimeDispatcher({
        helper: { handleTextTurn: profileTurn }
      }),
      attachmentTextHandlers: [
        {
          capability: "save_resource",
          matches: vi.fn(async () => true),
          handle
        }
      ],
      accessStore: new InMemoryAccessStore({
        principals: [
          {
            id: "helper-intro-group",
            profileName: helper.name,
            type: "group",
            principalId: source.groupId,
            createdAt: "2026-09-05T00:00:00.000Z",
            createdBy: "test"
          }
        ]
      }),
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
      replyToken: "intro-token",
      source,
      message: { type: "text", text: "小哈" }
    });

    const response = await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(body, helper.channelSecret),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(String(replyText.mock.calls[0]?.[1])).toContain("小哈");
    expect(handle).not.toHaveBeenCalled();
    expect(profileTurn).not.toHaveBeenCalled();
    expect(authorizeFunctions).not.toHaveBeenCalled();
    await expect(sessions.get("pending-upload")).resolves.toBeDefined();
  });

  it("observes a freshly committed helper review once and skips completion on replay", async () => {
    const config = accessConfig();
    const helper = config.profiles[0]!;
    const handleActionReview = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          ok: true,
          replyText: "已保存",
          executedAction: "save_memory",
          writePhase: "commit"
        },
        freshExecution: true
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          replyText: "已保存",
          executedAction: "save_memory",
          writePhase: "commit"
        },
        freshExecution: false
      });
    const routeObserver = vi.fn();
    const completion = createFunctionCompletionObserver({
      routeObserver,
      firstSuccessStore: new InMemoryFirstSuccessStore(),
      observabilityHmacKey: "test-observability-key"
    });
    const complete = vi.fn<FunctionCompletionObserver["complete"]>((input) =>
      completion.complete(input)
    );
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      profileRuntime: { handleTextTurn: vi.fn(), handleActionReview },
      completionObserver: { complete },
      routeObserver,
      accessStore: new InMemoryAccessStore({
        principals: [
          {
            id: "helper-review-user",
            profileName: helper.name,
            type: "user",
            principalId: "Uowner",
            createdAt: "2026-09-05T00:00:00.000Z",
            createdBy: "test"
          }
        ]
      }),
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "postback",
      replyToken: "review-token",
      source: { type: "user", userId: "Uowner" },
      postback: {
        data: "action=helper_action_review&reviewId=review-1&resultJobId=job-1&decision=approve"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(body, helper.channelSecret),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(handleActionReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: "review-1",
        resultJobId: "job-1",
        text: "確認"
      })
    );
    expect(replyText).toHaveBeenCalledWith("review-token", "已保存", undefined);

    const replayBody = lineBody({
      type: "postback",
      replyToken: "review-token-replay",
      source: { type: "user", userId: "Uowner" },
      postback: {
        data: "action=helper_action_review&reviewId=review-1&resultJobId=job-1&decision=approve"
      }
    });
    await app.inject({
      method: "POST",
      url: helper.webhookPath,
      headers: signedHeaders(replayBody, helper.channelSecret),
      payload: replayBody
    });

    expect(handleActionReview).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ action: "save_memory", result: expect.any(Object) })
    );
    expect(
      routeObserver.mock.calls.filter(([event]) => event.eventName === "write_committed")
    ).toHaveLength(1);
    expect(
      routeObserver.mock.calls.filter(([event]) => event.eventName === "first_success")
    ).toHaveLength(1);
    expect(replyText).toHaveBeenLastCalledWith("review-token-replay", "已保存", undefined);
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

  it("does not claim legacy webhook dedupe when bound intake persistence fails", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0]!,
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "helper-secret",
      allowedMessageTypes: ["text", "image", "video", "audio", "file"],
      enabledFunctions: []
    };
    const accessStore = new InMemoryAccessStore({
      principals: [
        {
          id: "helper-group-media",
          profileName: "helper",
          type: "group",
          principalId: "Gmedia",
          createdAt: "2026-08-16T00:00:00.000Z",
          createdBy: "test"
        }
      ]
    });
    const createIngest = vi.fn().mockRejectedValue(new Error("postgres unavailable"));
    const tryStart = vi.fn().mockResolvedValue("started");
    const mediaSyncStore = {
      findActiveBinding: vi.fn().mockResolvedValue({
        profileName: "helper",
        groupId: "Gmedia",
        collectionId: "collection-1"
      }),
      createIngest
    } as unknown as PostgresMediaSyncStore;
    const app = createTestApp(config, {
      accessStore,
      mediaSyncStore,
      webhookEventStore: { tryStart }
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "event-media-1",
      replyToken: "reply-media-1",
      source: { type: "group", groupId: "Gmedia", userId: "Umedia" },
      message: { id: "message-media-1", type: "image", contentProvider: { type: "line" } }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "media_sync_intake_unavailable" });
    expect(createIngest).toHaveBeenCalledOnce();
    expect(tryStart).not.toHaveBeenCalled();
  });

  it("admits bound helper video through media sync without widening legacy message types", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0]!,
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "helper-secret",
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: []
    };
    const accessStore = new InMemoryAccessStore({
      principals: [
        {
          id: "helper-group-media-video",
          profileName: "helper",
          type: "group",
          principalId: "Gmedia-video",
          createdAt: "2026-08-16T00:00:00.000Z",
          createdBy: "test"
        }
      ]
    });
    const createIngest = vi.fn().mockResolvedValue({
      created: true,
      ingest: { workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab" }
    });
    const tryStart = vi.fn().mockResolvedValue("started");
    const app = createTestApp(config, {
      accessStore,
      mediaSyncStore: {
        findActiveBinding: vi.fn().mockResolvedValue({
          profileName: "helper",
          groupId: "Gmedia-video",
          collectionId: "collection-1"
        }),
        createIngest
      } as unknown as PostgresMediaSyncStore,
      webhookEventStore: { tryStart }
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "event-media-video-1",
      source: { type: "group", groupId: "Gmedia-video", userId: "Umedia" },
      message: { id: "message-media-video-1", type: "video", contentProvider: { type: "line" } }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, allowedEvents: 1 });
    expect(createIngest).toHaveBeenCalledOnce();
    expect(tryStart).toHaveBeenCalledWith("helper", "event-media-video-1", 7 * 24 * 60 * 60 * 1000);
  });

  it("deduplicates a signed bound video redelivery after durable intake and before its prompt", async () => {
    const config = testConfig();
    config.profiles[0] = {
      ...config.profiles[0]!,
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "helper-secret",
      allowedMessageTypes: ["text", "image", "file"],
      enabledFunctions: ["save_resource"]
    };
    const accessStore = new InMemoryAccessStore({
      principals: [
        {
          id: "helper-group-media-redelivery",
          profileName: "helper",
          type: "group",
          principalId: "Gmedia-redelivery",
          createdAt: "2026-08-16T00:00:00.000Z",
          createdBy: "test"
        }
      ]
    });
    const createIngest = vi.fn().mockResolvedValue({
      created: true,
      ingest: { workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab" }
    });
    const tryStart = vi.fn().mockResolvedValueOnce("started").mockResolvedValueOnce("duplicate");
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const promoteUploadIntent = vi.fn().mockImplementation(async (pending) => ({ pending }));
    const app = createTestApp(config, {
      accessStore,
      sessionStore: { promoteUploadIntent } as never,
      mediaSyncStore: {
        findActiveBinding: vi.fn().mockResolvedValue({
          profileName: "helper",
          groupId: "Gmedia-redelivery",
          collectionId: "collection-1"
        }),
        createIngest,
        attachManualIntent: vi.fn().mockResolvedValue(true)
      } as unknown as PostgresMediaSyncStore,
      webhookEventStore: { tryStart },
      createLineReplyClient: () => ({ replyText })
    });
    const body = lineBody({
      type: "message",
      webhookEventId: "event-media-redelivery-1",
      replyToken: "reply-media-redelivery-1",
      source: { type: "group", groupId: "Gmedia-redelivery", userId: "Umedia" },
      message: {
        id: "message-media-redelivery-1",
        type: "video",
        contentProvider: { type: "line" }
      }
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: signedHeaders(body, "helper-secret"),
      payload: body
    });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(createIngest).toHaveBeenCalledTimes(2);
    expect(tryStart).toHaveBeenNthCalledWith(
      1,
      "helper",
      "event-media-redelivery-1",
      7 * 24 * 60 * 60 * 1000
    );
    expect(tryStart).toHaveBeenCalledTimes(2);
    expect(createIngest.mock.invocationCallOrder[0]).toBeLessThan(
      tryStart.mock.invocationCallOrder[0]!
    );
    expect(replyText).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(
  Boolean(process.env.KERNEL_POSTGRES_URL?.trim() && process.env.KERNEL_REDIS_URL?.trim())
)("media sync slice local acceptance", () => {
  it("keeps an unregistered code valid through registry, independent binding, and signed intake", async () => {
    const databaseUrl = process.env.KERNEL_POSTGRES_URL!.trim();
    const schemaName = `media_sync_acceptance_${randomUUID().replaceAll("-", "")}`;
    const owner = new Pool({ connectionString: databaseUrl, max: 1 });
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schemaName},public`
    });
    const redis = createClient({ url: process.env.KERNEL_REDIS_URL!.trim() });
    let app: ReturnType<typeof createApp> | undefined;
    try {
      await owner.query(`create schema "${schemaName}"`);
      await runMediaSyncMigrations(pool);
      await redis.connect();
      const bindingCodes = ["BIND-GROUP-ONE", "BIND-GROUP-TWO"];
      const mediaSyncStore = new PostgresMediaSyncStore(pool, {
        codeFactory: () => bindingCodes.shift()!
      });
      const registrationCodes = ["REGISTER-GROUP-ONE", "REGISTER-GROUP-TWO"];
      const registrationInviteCodeStore = new RedisRegistrationInviteCodeStore({
        client: redis,
        keyPrefix: `media-sync-acceptance:${randomUUID()}`,
        codeFactory: () => registrationCodes.shift()!
      });
      for (let index = 0; index < 2; index += 1) {
        await registrationInviteCodeStore.create({
          profileName: "helper",
          createdBy: "manager",
          ttlMinutes: 1
        });
      }
      for (const [collectionId, idempotencyKey] of [
        ["collection-one", "issue-one"],
        ["collection-two", "issue-two"]
      ]) {
        await expect(
          mediaSyncStore.createBindingCode({
            profileName: "helper",
            collectionId,
            createdByHhcUserId: "manager",
            idempotencyKey
          })
        ).resolves.toMatchObject({ status: "issued" });
      }
      const accessStore = new InMemoryAccessStore();
      const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
      app = createApp(accessConfig(), {
        accessStore,
        registrationInviteCodeStore,
        mediaSyncStore,
        createLineReplyClient: () => ({ replyText }),
        createLineIdentityClient: () => ({
          getUserDisplayName: vi.fn(),
          getGroupDisplayName: vi.fn(async (groupId) => `Group ${groupId}`)
        })
      });
      const deliver = (groupId: string, replyToken: string, message: Record<string, unknown>) => {
        const body = lineBody({
          type: "message",
          webhookEventId: `event-${replyToken}`,
          replyToken,
          source: { type: "group", groupId, userId: "line-user" },
          message
        });
        return app!.inject({
          method: "POST",
          url: "/api/line/webhook/helper",
          headers: signedHeaders(body, "helper-secret"),
          payload: body
        });
      };

      const rejected = await deliver("group-one", "unregistered", {
        type: "text",
        text: "/media-sync BIND-GROUP-ONE"
      });
      expect(rejected.statusCode).toBe(200);
      expect(replyText).toHaveBeenLastCalledWith(
        "unregistered",
        expect.stringContaining("尚未開通"),
        undefined
      );
      await expect(
        pool.query<{ consumed_at: Date | null }>(
          "select consumed_at from media_sync_binding_codes where collection_id='collection-one'"
        )
      ).resolves.toMatchObject({ rows: [{ consumed_at: null }] });
      await expect(
        deliver("group-one", "registry-one", {
          type: "text",
          text: "/registry REGISTER-GROUP-ONE"
        })
      ).resolves.toMatchObject({ statusCode: 200 });
      const repliesAfterRegistry = replyText.mock.calls.length;
      await expect(
        deliver("group-one", "unbound-media", {
          id: "message-before-binding",
          type: "image",
          contentProvider: { type: "line" }
        })
      ).resolves.toMatchObject({ statusCode: 200 });
      expect(replyText).toHaveBeenCalledTimes(repliesAfterRegistry);
      await expect(pool.query("select 1 from media_sync_ingests")).resolves.toMatchObject({
        rowCount: 0
      });
      await expect(
        deliver("group-one", "bind-one", {
          type: "text",
          text: "/media-sync BIND-GROUP-ONE"
        })
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        deliver("group-two", "registry-two", {
          type: "text",
          text: "/registry REGISTER-GROUP-TWO"
        })
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        deliver("group-two", "bind-two", {
          type: "text",
          text: "/media-sync BIND-GROUP-TWO"
        })
      ).resolves.toMatchObject({ statusCode: 200 });

      for (const kind of ["image", "video", "audio", "file"] as const) {
        const response = await deliver("group-one", `media-${kind}`, {
          id: `message-${kind}`,
          type: kind,
          contentProvider: { type: "line" },
          ...(kind === "file" ? { fileName: "slides.pptx", fileSize: 1024 } : {})
        });
        expect(response.statusCode, kind).toBe(200);
      }

      await expect(
        mediaSyncStore.findActiveBinding({ profileName: "helper", groupId: "group-one" })
      ).resolves.toMatchObject({ collectionId: "collection-one" });
      await expect(
        mediaSyncStore.findActiveBinding({ profileName: "helper", groupId: "group-two" })
      ).resolves.toMatchObject({ collectionId: "collection-two" });
      const ingests = await pool.query<{ media_kind: string; collection_id: string }>(
        "select media_kind, collection_id from media_sync_ingests order by media_kind"
      );
      expect(ingests.rows).toEqual([
        { media_kind: "audio", collection_id: "collection-one" },
        { media_kind: "file", collection_id: "collection-one" },
        { media_kind: "image", collection_id: "collection-one" },
        { media_kind: "video", collection_id: "collection-one" }
      ]);
      const persistedCodes = await pool.query<{ code_hash: string }>(
        "select code_hash from media_sync_binding_codes order by collection_id"
      );
      expect(persistedCodes.rows.map(({ code_hash }) => code_hash)).toEqual([
        expect.stringMatching(/^[0-9a-f]{64}$/u),
        expect.stringMatching(/^[0-9a-f]{64}$/u)
      ]);
      expect(
        JSON.stringify([persistedCodes.rows, accessStore.audit, replyText.mock.calls])
      ).not.toMatch(/BIND-GROUP|REGISTER-GROUP/u);
    } finally {
      await app?.close();
      if (redis.isOpen) await redis.quit();
      await pool.end();
      await owner.query(`drop schema if exists "${schemaName}" cascade`);
      await owner.end();
    }
  }, 15_000);
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

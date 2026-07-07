import { randomUUID } from "node:crypto";

import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { InMemoryAccessStore } from "./access/memory-access-store.js";
import {
  InMemoryRegistrationInviteCodeStore,
  type RegistrationInviteCodeStore
} from "./access/registration-invite-code-store.js";
import type { AccessPrincipalType, AccessStore } from "./access/types.js";
import { createLineSdkIdentityClient, createLineSdkReplyClient } from "./clients/line.js";
import { getFunctionDefinitions } from "./functions/definitions.js";
import { createIntroReply } from "./intro.js";
import { buildFunctionQuickReplies } from "./line-reply.js";
import { verifyLineSignature } from "./line-signature.js";
import { messages } from "./messages.js";
import {
  formatLastErrors,
  InMemoryLastErrorStore,
  type LastErrorStore
} from "./observability/last-error-store.js";
import {
  formatLastRoutes,
  InMemoryLastRouteStore,
  type LastRouteRecord,
  type LastRouteStore
} from "./observability/last-route-store.js";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import type {
  AppConfig,
  AdminHandlerRegistry,
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionRegistry,
  FunctionRouterPort,
  LineIdentityClient,
  LineEvent,
  LineMessage,
  LineReplyClient,
  LineWebhookPayload,
  JsonRecord,
  FunctionName,
  PostbackHandlerRegistry,
  PostbackRequest,
  RouteObserver,
  RouteObserverEvent,
  TextMessageHandlerRegistry
} from "./types.js";
import { FUNCTION_NAMES, isFunctionName } from "./types.js";

export interface AppDependencies {
  router: FunctionRouterPort;
  functionRegistry?: FunctionRegistry;
  postbackHandlers?: PostbackHandlerRegistry;
  textMessageHandlers?: TextMessageHandlerRegistry;
  adminHandlers?: AdminHandlerRegistry;
  createLineReplyClient?: (profile: BotProfileConfig) => LineReplyClient;
  createLineIdentityClient?: (profile: BotProfileConfig) => LineIdentityClient;
  routeObserver?: RouteObserver;
  requestIdFactory?: () => string;
  lastErrorStore?: LastErrorStore;
  lastRouteStore?: LastRouteStore;
  rateLimiter?: RateLimiter;
  accessStore?: AccessStore;
  registrationInviteCodeStore?: RegistrationInviteCodeStore;
}

interface AllowResult {
  allowed: boolean;
  reason: string;
}

interface ParsedAdminCommand {
  command: string;
  args: string[];
}

interface AdminCommandHelpEntry {
  usage: string;
  description: string;
}

interface AdminCommandHelpGroup {
  title: string;
  entries: AdminCommandHelpEntry[];
  common?: boolean;
}

const builtInAdminCommandGroups: AdminCommandHelpGroup[] = [
  {
    title: "成員與群組",
    common: true,
    entries: [
      { usage: "/access-list [user|group|admin]", description: "列出已開通清單" },
      { usage: "/user-remove <userId>", description: "停用使用者" },
      { usage: "/group-remove [groupId]", description: "停用群組；在群組內可省略 groupId" },
      { usage: "/user-add <userId> [name]", description: "進階：開通指定使用者" },
      { usage: "/group-add <groupId> [name]", description: "進階：開通指定群組" }
    ]
  },
  {
    title: "功能範圍",
    common: true,
    entries: [
      { usage: "/function-grant <functionName> [groupId]", description: "開放功能給群組" },
      { usage: "/function-revoke <functionName> [groupId]", description: "移除群組功能開放" },
      { usage: "/function-scopes [groupId]", description: "查看群組可用功能" }
    ]
  },
  {
    title: "查詢",
    common: true,
    entries: [
      { usage: "/audit-list [limit]", description: "查看最近 access audit" },
      { usage: "/whoami", description: "顯示目前 LINE user/group 與權限狀態" }
    ]
  },
  {
    title: "邀請碼",
    common: true,
    entries: [{ usage: "/invite-code-create", description: "建立一次性註冊邀請碼" }]
  },
  {
    title: "Superadmin",
    entries: [
      { usage: "/admin-add <userId>", description: "superadmin 新增 admin" },
      { usage: "/admin-remove <userId>", description: "superadmin 停用 admin" }
    ]
  },
  {
    title: "診斷",
    entries: [
      { usage: "/help admin", description: "列出常用 admin 指令" },
      { usage: "/help admin all", description: "列出完整 admin 指令" },
      { usage: "/status", description: "查看目前 profile 狀態" },
      { usage: "/profile", description: "查看目前 LINE 來源與 profile 設定摘要" },
      { usage: "/route-test <text>", description: "測試一段文字會 route 到哪個 function" },
      { usage: "/last-errors", description: "查看最近錯誤" },
      { usage: "/last-routes", description: "查看最近 route/function 結果" }
    ]
  }
];

const groupScopedAdminCommands = new Set([
  "group-remove",
  "function-grant",
  "function-revoke",
  "function-scopes"
]);

export function createApp(config: AppConfig, deps: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes
  });
  const functionRegistry = deps.functionRegistry ?? {};
  const createReplyClient = deps.createLineReplyClient ?? createLineSdkReplyClient;
  const createIdentityClient = deps.createLineIdentityClient ?? createLineSdkIdentityClient;
  const requestIdFactory = deps.requestIdFactory ?? randomUUID;
  const accessStore = deps.accessStore ?? new InMemoryAccessStore();
  const registrationInviteCodeStore =
    deps.registrationInviteCodeStore ?? new InMemoryRegistrationInviteCodeStore();
  const registrationInviteCodeTtlMinutes = config.access?.registrationInviteCodeTtlMinutes ?? 60;
  const lastErrorStore =
    deps.lastErrorStore ?? new InMemoryLastErrorStore(config.lastErrors?.maxEntries ?? 20);
  const lastRouteStore =
    deps.lastRouteStore ?? new InMemoryLastRouteStore(config.lastErrors?.maxEntries ?? 20);
  const rateLimiter =
    deps.rateLimiter ??
    new InMemoryRateLimiter(
      config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
    );

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get(config.healthPath, async () => ({
    ok: true,
    service: config.serviceName,
    timeZone: config.timeZone,
    profiles: config.profiles.map((profile) => ({
      name: profile.name,
      webhookPath: profile.webhookPath,
      enabledFunctions: profile.enabledFunctions
    })),
    llm: {
      primary: "ollama",
      model: config.llm.ollamaModel,
      fallback: config.llm.keywordFallbackEnabled ? "keyword" : "disabled"
    }
  }));

  for (const profile of config.profiles) {
    app.post(profile.webhookPath, async (request, reply) => {
      await handleWebhook(
        request,
        reply,
        profile,
        deps.router,
        functionRegistry,
        deps.postbackHandlers ?? {},
        deps.textMessageHandlers ?? {},
        deps.adminHandlers ?? {},
        createReplyClient,
        createIdentityClient,
        deps.routeObserver,
        requestIdFactory,
        lastErrorStore,
        lastRouteStore,
        rateLimiter,
        accessStore,
        registrationInviteCodeStore,
        registrationInviteCodeTtlMinutes
      );
    });
  }

  return app;
}

async function handleWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  profile: BotProfileConfig,
  router: FunctionRouterPort,
  functionRegistry: FunctionRegistry,
  postbackHandlers: PostbackHandlerRegistry,
  textMessageHandlers: TextMessageHandlerRegistry,
  adminHandlers: AdminHandlerRegistry,
  createReplyClient: (profile: BotProfileConfig) => LineReplyClient,
  createIdentityClient: (profile: BotProfileConfig) => LineIdentityClient,
  routeObserver: RouteObserver | undefined,
  requestIdFactory: () => string,
  lastErrorStore: LastErrorStore,
  lastRouteStore: LastRouteStore,
  rateLimiter: RateLimiter,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  registrationInviteCodeTtlMinutes: number
) {
  const signature = getHeaderValue(request.headers["x-line-signature"]);
  if (!signature) {
    return reply.code(400).send({ ok: false, error: "missing_line_signature" });
  }

  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
  if (!verifyLineSignature(body, signature, profile.channelSecret)) {
    return reply.code(401).send({ ok: false, error: "invalid_line_signature" });
  }

  const payload = parseWebhookPayload(body);
  if (!payload) {
    return reply.code(400).send({ ok: false, error: "invalid_line_payload" });
  }

  const allowedEvents: LineEvent[] = [];
  const ignoredCounts = new Map<string, number>();

  for (const event of payload.events) {
    const allow = await allowEvent(profile, event, textMessageHandlers, accessStore);
    if (allow.allowed) {
      allowedEvents.push(event);
    } else {
      ignoredCounts.set(allow.reason, (ignoredCounts.get(allow.reason) ?? 0) + 1);
    }
  }

  if (allowedEvents.length === 0) {
    return reply.send({
      ok: true,
      ignored: true,
      reason: formatIgnoredSummary(ignoredCounts)
    });
  }

  const line = createReplyClient(profile);
  const lineIdentity = createIdentityClient(profile);
  for (const event of allowedEvents) {
    const requestId = requestIdFactory();
    const effectiveProfile = await resolveEffectiveProfile(profile, event, accessStore);

    if (event.type === "postback") {
      if (!event.replyToken) {
        continue;
      }
      const startedAt = Date.now();
      const result = await handlePostbackEvent(
        event,
        effectiveProfile,
        postbackHandlers,
        requestId
      );
      await emitRouteEvent(routeObserver, {
        kind: "postback",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        action: parsePostbackData(event.postback?.data ?? "")?.action,
        ok: result.ok,
        durationMs: elapsedMs(startedAt)
      });
      await line.replyText(
        event.replyToken,
        result.replyText,
        result.quickReplies ? { quickReplies: result.quickReplies } : undefined
      );
      continue;
    }

    if (event.type !== "message" || event.message?.type !== "text" || !event.message.text) {
      continue;
    }

    if (!event.replyToken) {
      continue;
    }

    const rateLimit = await rateLimiter.check({ profileName: profile.name, source: event.source });
    if (!rateLimit.allowed) {
      await line.replyText(event.replyToken, "你傳得太快了，請稍後再試。", undefined);
      await emitRouteEvent(routeObserver, {
        kind: "rate_limited",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        ok: false
      });
      continue;
    }

    if (isAdminCommand(event.message.text)) {
      const parsedAdminCommand = parseAdminCommand(event.message.text);
      const accessCommandResult = await handlePublicAccessCommand(
        event.message.text,
        effectiveProfile,
        event,
        accessStore,
        registrationInviteCodeStore,
        lineIdentity,
        adminHandlers
      );
      if (accessCommandResult) {
        await line.replyText(
          event.replyToken,
          accessCommandResult.replyText,
          accessCommandResult.quickReplies
            ? { quickReplies: accessCommandResult.quickReplies }
            : undefined
        );
        continue;
      }
      const adminStartedAt = Date.now();
      let adminResult: FunctionExecutionResult;
      try {
        adminResult = await handleAdminCommand(
          event.message.text,
          effectiveProfile,
          event,
          adminHandlers,
          router,
          lastErrorStore,
          lastRouteStore,
          accessStore,
          registrationInviteCodeStore,
          registrationInviteCodeTtlMinutes,
          requestId
        );
      } catch (error) {
        await lastErrorStore.record({
          requestId,
          occurredAt: new Date().toISOString(),
          profileName: profile.name,
          sourceType: event.source.type,
          phase: "admin",
          command: parsedAdminCommand?.command,
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error)
        });
        adminResult = { ok: false, replyText: messages.requestFailed };
      }
      await emitRouteEvent(routeObserver, {
        kind: "admin_command",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        command: parsedAdminCommand?.command ?? "unknown",
        authorized: await adminAllowed(profile, event, accessStore, parsedAdminCommand?.command),
        ok: adminResult.ok,
        durationMs: elapsedMs(adminStartedAt)
      });
      await line.replyText(
        event.replyToken,
        adminResult.replyText,
        adminResult.quickReplies ? { quickReplies: adminResult.quickReplies } : undefined
      );
      continue;
    }

    if (await shouldPromptManagedRegistration(profile, event, accessStore)) {
      await line.replyText(event.replyToken, registrationPrompt(profile, event), undefined);
      continue;
    }

    const intro = createIntroReply(effectiveProfile, event.message.text);
    if (intro) {
      await line.replyText(
        event.replyToken,
        intro.replyText,
        intro.quickReplies ? { quickReplies: intro.quickReplies } : undefined
      );
      continue;
    }

    const textMessageHandler = await matchingTextMessageHandler(
      event,
      effectiveProfile,
      textMessageHandlers
    );
    if (textMessageHandler) {
      const handlerStartedAt = Date.now();
      const result = await textMessageHandler.handler.handle(
        { text: event.message.text },
        { profile: effectiveProfile, event, requestId }
      );
      await emitRouteEvent(routeObserver, {
        kind: "text_handler",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        handler: textMessageHandler.name,
        ok: result?.ok,
        durationMs: elapsedMs(handlerStartedAt)
      });
      if (result) {
        await line.replyText(
          event.replyToken,
          result.replyText,
          result.quickReplies ? { quickReplies: result.quickReplies } : undefined
        );
      }
      continue;
    }

    const routeStartedAt = Date.now();
    let route;
    try {
      route = await router.route({
        profileName: effectiveProfile.name,
        text: event.message.text,
        enabledFunctions: effectiveProfile.enabledFunctions,
        source: event.source
      });
    } catch (error) {
      await lastErrorStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: profile.name,
        sourceType: event.source.type,
        phase: "router",
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      });
      await line.replyText(event.replyToken, messages.requestFailed);
      continue;
    }
    await emitRouteEvent(routeObserver, {
      kind: "route",
      profileName: profile.name,
      sourceType: event.source.type,
      requestId,
      provider: route.provider,
      outcome: route.type,
      action: route.type === "execute" || route.type === "respond" ? route.action : undefined,
      reason: route.type === "deny" ? route.reason : undefined,
      confidence:
        route.type === "execute" || route.type === "respond" ? route.confidence : undefined,
      fallbackProvider: route.fallbackProvider,
      fallbackReason: route.fallbackReason,
      durationMs: elapsedMs(routeStartedAt)
    });
    await lastRouteStore.record({
      requestId,
      occurredAt: new Date().toISOString(),
      profileName: profile.name,
      sourceType: event.source.type,
      phase: "route",
      provider: route.provider,
      outcome: route.type,
      action: route.type === "execute" || route.type === "respond" ? route.action : undefined,
      reason: route.type === "deny" ? route.reason : undefined,
      fallbackProvider: route.fallbackProvider,
      fallbackReason: route.fallbackReason,
      ...(route.type === "execute" ? summarizeRouteArguments(route.arguments) : {}),
      durationMs: elapsedMs(routeStartedAt)
    });

    if (route.type === "respond") {
      if (route.action === "introduce_bot") {
        const intro = createIntroReply(effectiveProfile, event.message.text, {
          force: true,
          greeting: stringRouteArgument(route.arguments, "greeting")
        });
        await line.replyText(
          event.replyToken,
          intro?.replyText ?? messages.requestFailed,
          intro?.quickReplies ? { quickReplies: intro.quickReplies } : undefined
        );
        continue;
      }
      await line.replyText(event.replyToken, messages.unsupported);
      continue;
    }

    if (route.type === "deny") {
      const quickReplies = buildFunctionQuickReplies(effectiveProfile);
      await line.replyText(
        event.replyToken,
        quickReplies.length > 0 ? messages.unsupportedWithSuggestions : messages.unsupported,
        quickReplies.length > 0 ? { quickReplies } : undefined
      );
      continue;
    }

    const handler = functionRegistry[route.action];
    if (!handler) {
      await line.replyText(event.replyToken, messages.functionNotConfigured);
      continue;
    }

    const functionStartedAt = Date.now();
    try {
      const result = await handler(route.arguments, {
        profile: effectiveProfile,
        event,
        requestId
      });
      await emitRouteEvent(routeObserver, {
        kind: "function_result",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        action: route.action,
        ok: result.ok,
        durationMs: elapsedMs(functionStartedAt)
      });
      await lastRouteStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: profile.name,
        sourceType: event.source.type,
        phase: "function",
        action: route.action,
        ok: result.ok,
        durationMs: elapsedMs(functionStartedAt)
      });
      await line.replyText(
        event.replyToken,
        result.replyText,
        result.quickReplies ? { quickReplies: result.quickReplies } : undefined
      );
    } catch (error) {
      await lastErrorStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: profile.name,
        sourceType: event.source.type,
        phase: "function",
        action: route.action,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      });
      await emitRouteEvent(routeObserver, {
        kind: "function_error",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        action: route.action,
        ok: false,
        errorName: error instanceof Error ? error.name : typeof error,
        durationMs: elapsedMs(functionStartedAt)
      });
      await lastRouteStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: profile.name,
        sourceType: event.source.type,
        phase: "function",
        action: route.action,
        ok: false,
        errorName: error instanceof Error ? error.name : typeof error,
        durationMs: elapsedMs(functionStartedAt)
      });
      await line.replyText(event.replyToken, messages.requestFailed);
    }
  }

  return reply.send({
    ok: true,
    allowedEvents: allowedEvents.length,
    ignored: ignoredCounts.size > 0 ? formatIgnoredSummary(ignoredCounts) : undefined
  });
}

async function resolveEffectiveProfile(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore
): Promise<BotProfileConfig> {
  const enabledFunctions = await resolveEffectiveFunctions(profile, event, accessStore);
  if (enabledFunctions.length === profile.enabledFunctions.length) {
    const unchanged = enabledFunctions.every(
      (name, index) => name === profile.enabledFunctions[index]
    );
    if (unchanged) {
      return profile;
    }
  }
  return { ...profile, enabledFunctions };
}

async function resolveEffectiveFunctions(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore
): Promise<FunctionName[]> {
  if (event.source.type !== "group" || !event.source.groupId) {
    return profile.enabledFunctions;
  }
  const groupGrants = await accessStore.listGroupFunctionGrants(profile.name, event.source.groupId);
  return mergeFunctionNames(profile.enabledFunctions, groupGrants);
}

async function handlePostbackEvent(
  event: LineEvent,
  profile: BotProfileConfig,
  postbackHandlers: PostbackHandlerRegistry,
  requestId: string
) {
  const request = parsePostbackData(event.postback?.data ?? "");
  if (!request) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  const handler = postbackHandlers[request.action];
  if (!handler) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  return handler(request, { profile, event, requestId });
}

function parsePostbackData(data: string): PostbackRequest | null {
  const params = Object.fromEntries(new URLSearchParams(data));
  const action = params.action;
  if (!action) {
    return null;
  }
  return { action, params };
}

function parseWebhookPayload(body: Buffer): LineWebhookPayload | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as LineWebhookPayload;
    if (!parsed || !Array.isArray(parsed.events)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function shouldAllowGroupRegistrationPrompt(
  profile: BotProfileConfig,
  event: LineEvent,
  textMessageHandlers: TextMessageHandlerRegistry
): Promise<boolean> {
  if (!profile.registration?.enabled) {
    return false;
  }
  if (event.type?.trim().toLowerCase() !== "message") {
    return false;
  }
  if (!messageTypeAllowed(profile, event)) {
    return false;
  }
  if (!profile.groupRequireWakeWord || matchesWakeRule(profile, event.message)) {
    return true;
  }
  return Boolean(await matchingTextMessageHandler(event, profile, textMessageHandlers));
}

async function allowEvent(
  profile: BotProfileConfig,
  event: LineEvent,
  textMessageHandlers: TextMessageHandlerRegistry,
  accessStore: AccessStore
): Promise<AllowResult> {
  const eventType = event.type?.trim().toLowerCase();
  const sourceType = event.source?.type?.trim().toLowerCase();
  const command = parseAdminCommand(event.message?.text)?.command;

  switch (sourceType) {
    case "room":
      if (!profile.allowRooms) {
        return { allowed: false, reason: "room_blocked" };
      }
      return { allowed: false, reason: "room_not_implemented" };

    case "group":
      if (groupAccessPolicy(profile) === "blocked") {
        return { allowed: false, reason: "group_blocked" };
      }
      if (command === "registry") {
        return { allowed: true, reason: "group_registration_command_allowed" };
      }
      if (!(await isGroupAllowed(profile, event.source.groupId, accessStore))) {
        if (command) {
          return { allowed: true, reason: "group_admin_command_allowed" };
        }
        if (await shouldAllowGroupRegistrationPrompt(profile, event, textMessageHandlers)) {
          return { allowed: true, reason: "group_registration_prompt_allowed" };
        }
        return { allowed: false, reason: "group_not_allowed" };
      }
      if (eventType === "postback") {
        return { allowed: true, reason: "group_postback_allowed" };
      }
      if (eventType !== "message") {
        return { allowed: false, reason: "event_type_not_allowed" };
      }
      if (!messageTypeAllowed(profile, event)) {
        return { allowed: false, reason: "message_type_not_allowed" };
      }
      if (command) {
        return { allowed: true, reason: "group_admin_command_allowed" };
      }
      if (!profile.groupRequireWakeWord || matchesWakeRule(profile, event.message)) {
        return { allowed: true, reason: "group_wake_matched" };
      }
      if (
        await matchingTextMessageHandler(
          event,
          await resolveEffectiveProfile(profile, event, accessStore),
          textMessageHandlers
        )
      ) {
        return { allowed: true, reason: "group_text_message_handler_matched" };
      }
      return { allowed: false, reason: "wake_word_missing" };

    case "user":
      if (command === "whoami" || command === "registry") {
        return { allowed: true, reason: "direct_access_command_allowed" };
      }
      if (command) {
        return { allowed: true, reason: "direct_admin_command_allowed" };
      }
      if (directAccessPolicy(profile) === "blocked") {
        return { allowed: false, reason: "direct_user_blocked" };
      }
      if (
        directAccessPolicy(profile) === "managed" &&
        !(await isDirectUserAllowed(profile, event.source.userId, accessStore))
      ) {
        if (profile.registration?.enabled && eventType === "message") {
          return { allowed: true, reason: "direct_registration_prompt_allowed" };
        }
        return { allowed: false, reason: "user_not_allowed" };
      }
      if (eventType === "postback") {
        return { allowed: true, reason: "direct_user_postback_allowed" };
      }
      if (eventType !== "message") {
        return { allowed: false, reason: "event_type_not_allowed" };
      }
      if (!messageTypeAllowed(profile, event)) {
        return { allowed: false, reason: "message_type_not_allowed" };
      }
      return { allowed: true, reason: "direct_user_allowed" };

    default:
      return { allowed: false, reason: "source_type_not_supported" };
  }
}

function isAdminCommand(text: string | undefined): boolean {
  return Boolean(parseAdminCommand(text));
}

async function handlePublicAccessCommand(
  text: string,
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  lineIdentity: LineIdentityClient,
  adminHandlers: AdminHandlerRegistry
): Promise<FunctionExecutionResult | undefined> {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return undefined;
  }
  if (parsed.command === "help") {
    if (parsed.args[0]?.toLowerCase() === "admin") {
      if (!(await adminAllowed(profile, event, accessStore, "help"))) {
        return { ok: true, replyText: messages.adminUnauthorized };
      }
      return {
        ok: true,
        replyText: formatAdminCommandHelpByMode(adminHandlers, parsed.args[1] === "all")
      };
    }
    return formatPublicHelp(profile);
  }
  if (parsed.command === "whoami") {
    return handleWhoamiCommand(profile, event, accessStore);
  }
  if (parsed.command !== "registry") {
    return undefined;
  }
  return handleRegistryCommand(
    parsed.args,
    profile,
    event,
    accessStore,
    registrationInviteCodeStore,
    lineIdentity
  );
}

function formatPublicHelp(profile: BotProfileConfig): FunctionExecutionResult {
  const definitions = getFunctionDefinitions(profile.enabledFunctions);
  const functionLines =
    definitions.length > 0
      ? definitions.map((definition) => `- ${definition.quickReply.label}`)
      : ["- 目前沒有開放可查詢的功能"];
  return {
    ok: true,
    replyText: [
      "小哈可以協助你查詢：",
      ...functionLines,
      "",
      "可用指令：",
      "/help - 查看小哈可以協助什麼",
      "/registry <code> - 使用邀請碼開通",
      "/whoami - 查看目前 LINE user/group 資訊",
      "/help admin - 管理員指令說明"
    ].join("\n"),
    quickReplies: buildFunctionQuickReplies(profile)
  };
}

async function handleWhoamiCommand(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore
): Promise<FunctionExecutionResult> {
  const userId = event.source.userId ?? "(none)";
  const groupId = event.source.groupId ?? "(none)";
  return {
    ok: true,
    replyText: [
      "Who am I",
      `profile: ${profile.name}`,
      `source: ${event.source.type}`,
      `userId: ${userId}`,
      `groupId: ${groupId}`,
      `directPolicy: ${directAccessPolicy(profile)}`,
      `groupPolicy: ${groupAccessPolicy(profile)}`,
      `superadmin: ${isBootstrapSuperAdmin(profile, event.source.userId)}`,
      `admin: ${await isAdminUser(profile, event.source.userId, accessStore)}`,
      `userAllowed: ${await isDirectUserAllowed(profile, event.source.userId, accessStore)}`,
      `groupAllowed: ${await isGroupAllowed(profile, event.source.groupId, accessStore)}`
    ].join("\n")
  };
}

async function handleRegistryCommand(
  args: string[],
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  lineIdentity: LineIdentityClient
): Promise<FunctionExecutionResult> {
  if (!profile.registration?.enabled) {
    return { ok: true, replyText: "這個 bot 目前沒有開放邀請碼註冊。" };
  }
  const code = args[0]?.trim();
  if (!code) {
    return { ok: true, replyText: "請輸入 /registry <code>。" };
  }

  if (event.source.type === "group") {
    return handleGroupRegistryCommand(
      code,
      profile,
      event,
      accessStore,
      registrationInviteCodeStore,
      lineIdentity
    );
  }

  if (event.source.type !== "user" || !event.source.userId) {
    return { ok: true, replyText: "請在個人聊天室或群組裡使用 /registry <code>。" };
  }

  if (await isDirectUserAllowed(profile, event.source.userId, accessStore)) {
    return { ok: true, replyText: "你已經可以使用小哈。" };
  }
  if (!(await registrationInviteCodeStore.consume(profile.name, code))) {
    return { ok: true, replyText: "邀請碼無效或已過期，請向管理員索取新的邀請碼。" };
  }
  const displayName = await resolveUserRegistrationDisplayName(lineIdentity, event.source.userId);
  await accessStore.addPrincipal({
    profileName: profile.name,
    type: "user",
    principalId: event.source.userId,
    displayName,
    createdBy: event.source.userId
  });
  await accessStore.recordAudit({
    profileName: profile.name,
    actorUserId: event.source.userId,
    action: "access.user.registry",
    targetType: "user",
    targetId: event.source.userId
  });
  return { ok: true, replyText: "已開通小哈。" };
}

async function handleGroupRegistryCommand(
  code: string,
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  lineIdentity: LineIdentityClient
): Promise<FunctionExecutionResult> {
  const groupId = event.source.groupId;
  const actorUserId = event.source.userId;
  if (!groupId || !actorUserId) {
    return { ok: true, replyText: "無法取得群組或申請人資訊。" };
  }
  if (await isGroupAllowed(profile, groupId, accessStore)) {
    return { ok: true, replyText: "這個群組已經可以使用小哈。" };
  }
  if (!(await registrationInviteCodeStore.consume(profile.name, code))) {
    return { ok: true, replyText: "邀請碼無效或已過期，請向管理員索取新的邀請碼。" };
  }
  const displayName = await resolveGroupRegistrationDisplayName(lineIdentity, groupId);
  await accessStore.addPrincipal({
    profileName: profile.name,
    type: "group",
    principalId: groupId,
    displayName,
    createdBy: actorUserId
  });
  await accessStore.recordAudit({
    profileName: profile.name,
    actorUserId,
    action: "access.group.registry",
    targetType: "group",
    targetId: groupId
  });
  return {
    ok: true,
    replyText: `已開通此群組 ${groupId}${displayName ? ` (${displayName})` : ""}`
  };
}

async function resolveUserRegistrationDisplayName(
  lineIdentity: LineIdentityClient,
  userId: string
): Promise<string | undefined> {
  try {
    return nonBlank(await lineIdentity.getUserDisplayName(userId));
  } catch {
    return undefined;
  }
}

async function resolveGroupRegistrationDisplayName(
  lineIdentity: LineIdentityClient,
  groupId: string
): Promise<string | undefined> {
  try {
    return nonBlank(await lineIdentity.getGroupDisplayName(groupId));
  } catch {
    return undefined;
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function registrationPrompt(profile: BotProfileConfig, event: LineEvent): string {
  if (profile.registration?.enabled) {
    if (event.source.type === "group") {
      return "這個群組還沒有開通小哈，請先找管理員協助註冊。";
    }
    return "你尚未開通小哈，請先找管理員協助註冊。";
  }
  return "你尚未開通小哈，請聯絡管理同工協助。";
}

async function shouldPromptManagedRegistration(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore
): Promise<boolean> {
  if (
    event.source.type === "user" &&
    directAccessPolicy(profile) === "managed" &&
    !(await isDirectUserAllowed(profile, event.source.userId, accessStore))
  ) {
    return true;
  }

  return (
    event.source.type === "group" &&
    groupAccessPolicy(profile) === "managed" &&
    Boolean(profile.registration?.enabled) &&
    event.type?.trim().toLowerCase() === "message" &&
    !(await isGroupAllowed(profile, event.source.groupId, accessStore))
  );
}

async function handleAdminCommand(
  text: string,
  profile: BotProfileConfig,
  event: LineEvent,
  adminHandlers: AdminHandlerRegistry,
  router: FunctionRouterPort,
  lastErrorStore: LastErrorStore,
  lastRouteStore: LastRouteStore,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  registrationInviteCodeTtlMinutes: number,
  requestId: string
): Promise<FunctionExecutionResult> {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (!isKnownAdminCommand(parsed.command, adminHandlers)) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (!(await adminAllowed(profile, event, accessStore, parsed.command))) {
    return { ok: true, replyText: messages.adminUnauthorized };
  }

  if (parsed.command === "status") {
    return {
      ok: true,
      replyText: [
        "Admin status",
        `profile: ${profile.name}`,
        `functions: ${profile.enabledFunctions.join(", ") || "(none)"}`,
        `source: ${event.source.type}`
      ].join("\n")
    };
  }

  if (parsed.command === "profile") {
    return {
      ok: true,
      replyText: [
        "Profile",
        `name: ${profile.name}`,
        `source: ${event.source.type}`,
        `functions: ${profile.enabledFunctions.join(", ") || "(none)"}`,
        `adminDirectOnly: ${profile.adminDirectOnly !== false}`
      ].join("\n")
    };
  }

  if (parsed.command === "route-test") {
    return handleRouteTestCommand(parsed.args, profile, event, router);
  }

  if (parsed.command === "last-errors") {
    return lastErrorStore.list().then((errors) => ({
      ok: true,
      replyText: formatLastErrors(errors)
    }));
  }

  if (parsed.command === "last-routes") {
    return lastRouteStore.list().then((routes) => ({
      ok: true,
      replyText: formatLastRoutes(routes)
    }));
  }

  const accessResult = await handleAdminAccessCommand(
    parsed.command,
    parsed.args,
    profile,
    event,
    accessStore,
    registrationInviteCodeStore,
    registrationInviteCodeTtlMinutes
  );
  if (accessResult) {
    return accessResult;
  }

  const handler = adminHandlers[parsed.command];
  if (handler) {
    return handler({ profile, event, command: parsed.command, args: parsed.args, requestId });
  }

  return { ok: true, replyText: "目前不支援這個 admin 指令。" };
}

async function handleAdminAccessCommand(
  command: string,
  args: string[],
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  registrationInviteCodeStore: RegistrationInviteCodeStore,
  registrationInviteCodeTtlMinutes: number
): Promise<FunctionExecutionResult | undefined> {
  const actorUserId = event.source.userId;
  if (!actorUserId) {
    return { ok: true, replyText: messages.adminUnauthorized };
  }

  if (command === "access-list") {
    const filterType = parseAccessPrincipalType(args[0], ["user", "group", "admin"]);
    const principals = (await accessStore.listPrincipals(profile.name)).filter(
      (principal) => !filterType || principal.type === filterType
    );
    if (principals.length === 0) {
      return { ok: true, replyText: "Access list\n(none)" };
    }
    return {
      ok: true,
      replyText: [
        "Access list",
        ...principals.map(
          (principal) =>
            `${principal.type}: ${principal.principalId}${
              principal.displayName ? ` (${principal.displayName})` : ""
            }`
        )
      ].join("\n")
    };
  }

  if (command === "function-grant" || command === "function-revoke") {
    const functionName = parseFunctionName(args[0]);
    if (!functionName) {
      return {
        ok: true,
        replyText: `Usage: /${command} <functionName> [groupId]\n可用功能：${formatFunctionNames()}`
      };
    }
    const targetGroupId =
      args[1] ?? (event.source.type === "group" ? event.source.groupId : undefined);
    if (!targetGroupId) {
      return { ok: true, replyText: `Usage: /${command} <functionName> <groupId>` };
    }
    if (command === "function-grant") {
      await accessStore.addGroupFunctionGrant({
        profileName: profile.name,
        groupId: targetGroupId,
        functionName,
        createdBy: actorUserId
      });
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.function.grant",
        targetType: "group",
        targetId: targetGroupId,
        metadata: { functionName }
      });
      return {
        ok: true,
        replyText: `已開放 ${functionName} 給 group ${targetGroupId}`
      };
    }

    const revoked = await accessStore.disableGroupFunctionGrant({
      profileName: profile.name,
      groupId: targetGroupId,
      functionName,
      disabledBy: actorUserId
    });
    if (revoked) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.function.revoke",
        targetType: "group",
        targetId: targetGroupId,
        metadata: { functionName }
      });
    }
    return {
      ok: true,
      replyText: revoked
        ? `已移除 group ${targetGroupId} 的 ${functionName}`
        : "找不到群組功能開放設定。"
    };
  }

  if (command === "function-scopes") {
    const targetGroupId =
      args[0] ?? (event.source.type === "group" ? event.source.groupId : undefined);
    if (!targetGroupId) {
      return { ok: true, replyText: "Usage: /function-scopes <groupId>" };
    }
    const groupGrants = await accessStore.listGroupFunctionGrants(profile.name, targetGroupId);
    const effectiveFunctions = mergeFunctionNames(profile.enabledFunctions, groupGrants);
    return {
      ok: true,
      replyText: [
        "Function scopes",
        `profile: ${profile.name}`,
        `group: ${targetGroupId}`,
        `profile-global: ${profile.enabledFunctions.join(", ") || "(none)"}`,
        `group-grants: ${groupGrants.join(", ") || "(none)"}`,
        `effective: ${effectiveFunctions.join(", ") || "(none)"}`
      ].join("\n")
    };
  }

  if (command === "group-remove") {
    const targetGroupId =
      args[0] ?? (event.source.type === "group" ? event.source.groupId : undefined);
    if (!targetGroupId) {
      return { ok: true, replyText: "Usage: /group-remove <groupId>" };
    }
    const removed = await accessStore.disablePrincipal({
      profileName: profile.name,
      type: "group",
      principalId: targetGroupId,
      disabledBy: actorUserId
    });
    if (removed) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.group.remove",
        targetType: "group",
        targetId: targetGroupId
      });
    }
    const currentGroup = event.source.type === "group" && targetGroupId === event.source.groupId;
    return {
      ok: true,
      replyText: removed
        ? currentGroup
          ? `已停用此群組 ${targetGroupId}`
          : `已停用 group ${targetGroupId}`
        : "找不到群組。"
    };
  }

  if (command === "user-add" || command === "group-add") {
    const principalId = args[0];
    if (!principalId) {
      return { ok: true, replyText: `Usage: /${command} <id>` };
    }
    const type: AccessPrincipalType = command === "user-add" ? "user" : "group";
    const displayName = args.slice(1).join(" ").trim() || undefined;
    await accessStore.addPrincipal({
      profileName: profile.name,
      type,
      principalId,
      displayName,
      createdBy: actorUserId
    });
    await accessStore.recordAudit({
      profileName: profile.name,
      actorUserId,
      action: `access.${type}.add`,
      targetType: type,
      targetId: principalId
    });
    return {
      ok: true,
      replyText: `已加入 ${type} ${principalId}${displayName ? ` (${displayName})` : ""}`
    };
  }

  if (command === "user-remove") {
    const principalId = args[0];
    if (!principalId) {
      return { ok: true, replyText: `Usage: /${command} <id>` };
    }
    const removed = await accessStore.disablePrincipal({
      profileName: profile.name,
      type: "user",
      principalId,
      disabledBy: actorUserId
    });
    if (removed) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.user.remove",
        targetType: "user",
        targetId: principalId
      });
    }
    return { ok: true, replyText: removed ? `已停用 user ${principalId}` : "找不到項目。" };
  }

  if (command === "audit-list") {
    const limit = Math.min(parsePositiveInt(args[0]) ?? 10, 50);
    const events = await accessStore.listAuditEvents(profile.name, limit);
    if (events.length === 0) {
      return { ok: true, replyText: "Audit events\n(none)" };
    }
    return {
      ok: true,
      replyText: [
        "Audit events",
        ...events.map((event) =>
          [
            `- ${event.createdAt}`,
            `action=${event.action}`,
            event.targetType && event.targetId
              ? `target=${event.targetType}:${event.targetId}`
              : undefined,
            `actor=${event.actorUserId}`
          ]
            .filter(Boolean)
            .join(" ")
        )
      ].join("\n")
    };
  }

  if (command === "invite-code-create") {
    if (!profile.registration?.enabled) {
      return { ok: true, replyText: "這個 profile 沒有開放邀請碼註冊。" };
    }
    const invite = await registrationInviteCodeStore.create({
      profileName: profile.name,
      createdBy: actorUserId,
      ttlMinutes: registrationInviteCodeTtlMinutes
    });
    await accessStore.recordAudit({
      profileName: profile.name,
      actorUserId,
      action: "invite_code.create",
      metadata: { ttlMinutes: registrationInviteCodeTtlMinutes }
    });
    return {
      ok: true,
      replyText: [
        "邀請碼已建立",
        `有效期限：${registrationInviteCodeTtlMinutes} 分鐘`,
        `過期時間：${invite.expiresAt}`,
        "",
        "請複製下面這行給要註冊的人：",
        `/registry ${invite.code}`
      ].join("\n")
    };
  }
  if (command === "admin-add" || command === "admin-remove") {
    if (!isBootstrapSuperAdmin(profile, actorUserId)) {
      return { ok: true, replyText: "只有 superadmin 可以管理 admin。" };
    }
    const targetUserId = args[0];
    if (!targetUserId) {
      return { ok: true, replyText: `Usage: /${command} <userId>` };
    }
    if (command === "admin-add") {
      await accessStore.addPrincipal({
        profileName: profile.name,
        type: "admin",
        principalId: targetUserId,
        createdBy: actorUserId
      });
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.admin.add",
        targetType: "admin",
        targetId: targetUserId
      });
      return { ok: true, replyText: `已加入 admin ${targetUserId}` };
    }
    if (isBootstrapSuperAdmin(profile, targetUserId)) {
      return { ok: true, replyText: "不能移除 bootstrap superadmin。" };
    }
    const removed = await accessStore.disablePrincipal({
      profileName: profile.name,
      type: "admin",
      principalId: targetUserId,
      disabledBy: actorUserId
    });
    if (removed) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "access.admin.remove",
        targetType: "admin",
        targetId: targetUserId
      });
    }
    return { ok: true, replyText: removed ? `已停用 admin ${targetUserId}` : "找不到 admin。" };
  }

  return undefined;
}

function parseAccessPrincipalType(
  value: string | undefined,
  allowed: AccessPrincipalType[]
): AccessPrincipalType | undefined {
  return value && (allowed as string[]).includes(value)
    ? (value as AccessPrincipalType)
    : undefined;
}

function parseFunctionName(value: string | undefined): FunctionName | undefined {
  return value && isFunctionName(value) ? value : undefined;
}

function formatFunctionNames(): string {
  return FUNCTION_NAMES.join(", ");
}

function mergeFunctionNames(
  profileFunctions: FunctionName[],
  grantedFunctions: FunctionName[]
): FunctionName[] {
  return Array.from(new Set([...profileFunctions, ...grantedFunctions]));
}

function isKnownAdminCommand(command: string, adminHandlers: AdminHandlerRegistry): boolean {
  return (
    builtInAdminCommandGroups.some((group) =>
      group.entries.some((entry) => commandNameFromUsage(entry.usage) === command)
    ) || Boolean(adminHandlers[command])
  );
}

function commandNameFromUsage(usage: string): string | undefined {
  return usage.match(/^\/([a-z0-9][a-z0-9-]*)/i)?.[1].toLowerCase();
}

function formatAdminCommandHelpByMode(
  adminHandlers: AdminHandlerRegistry,
  showAll: boolean
): string {
  const groups = showAll
    ? builtInAdminCommandGroups
    : builtInAdminCommandGroups
        .filter((group) => group.common)
        .map((group) => ({
          ...group,
          entries: group.entries.filter((entry) => !entry.description.startsWith("進階："))
        }));
  const registeredCommands = Object.keys(adminHandlers)
    .map((command) => `/${command}`)
    .sort();

  return [
    "Admin commands",
    ...groups.flatMap((group) => [
      "",
      group.title,
      ...group.entries.map(
        (entry) => `${entry.usage} - ${entry.description.replace(/^進階：/, "")}`
      )
    ]),
    ...(showAll && registeredCommands.length
      ? ["", "功能模組", ...registeredCommands.map((usage) => `${usage} - registered handler`)]
      : []),
    ...(showAll ? [] : ["", "更多指令", "/help admin all"])
  ].join("\n");
}

async function handleRouteTestCommand(
  args: string[],
  profile: BotProfileConfig,
  event: LineEvent,
  router: FunctionRouterPort
): Promise<FunctionExecutionResult> {
  const text = args.join(" ").trim();
  if (!text) {
    return { ok: true, replyText: "Route test\n請提供要測試的文字。" };
  }

  const route = await router.route({
    profileName: profile.name,
    text,
    enabledFunctions: profile.enabledFunctions,
    source: event.source
  });

  if (route.type === "deny") {
    return {
      ok: true,
      replyText: [
        "Route test",
        "type: deny",
        `provider: ${route.provider}`,
        `reason: ${route.reason}`,
        ...formatFallbackDiagnostics(route)
      ].join("\n")
    };
  }

  if (route.type === "respond") {
    return {
      ok: true,
      replyText: [
        "Route test",
        "type: respond",
        `provider: ${route.provider}`,
        `action: ${route.action}`,
        `arguments: ${JSON.stringify(route.arguments)}`,
        ...formatFallbackDiagnostics(route)
      ].join("\n")
    };
  }

  return {
    ok: true,
    replyText: [
      "Route test",
      "type: execute",
      `provider: ${route.provider}`,
      `action: ${route.action}`,
      `arguments: ${JSON.stringify(route.arguments)}`,
      ...formatFallbackDiagnostics(route)
    ].join("\n")
  };
}

function formatFallbackDiagnostics(route: {
  fallbackProvider?: string;
  fallbackReason?: string;
}): string[] {
  if (!route.fallbackProvider && !route.fallbackReason) {
    return [];
  }
  return [
    `fallbackProvider: ${route.fallbackProvider ?? "(unknown)"}`,
    `fallbackReason: ${route.fallbackReason ?? "(unknown)"}`
  ];
}

function summarizeRouteArguments(args: JsonRecord): Pick<LastRouteRecord, "query" | "fileType"> {
  const queryValue = args.query;
  const fileTypeValue = args.fileType;
  return {
    query: typeof queryValue === "string" ? (queryValue.trim() ? "present" : "empty") : "missing",
    fileType: typeof fileTypeValue === "string" ? fileTypeValue : undefined
  };
}

function stringRouteArgument(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function parseAdminCommand(text: string | undefined): ParsedAdminCommand | undefined {
  const normalized = text?.trim().replace(/^小哈[，,\s]*/i, "") ?? "";
  const match = normalized.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/i);
  if (!match) {
    return undefined;
  }
  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? "").split(/\s+/).filter(Boolean)
  };
}

async function adminAllowed(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  command?: string
): Promise<boolean> {
  if (!(await isAdminUser(profile, event.source.userId, accessStore))) {
    return false;
  }
  if (command && groupScopedAdminCommands.has(command) && event.source.type === "group") {
    return true;
  }
  if (profile.adminDirectOnly !== false && event.source.type !== "user") {
    return false;
  }
  return true;
}

async function isAdminUser(
  profile: BotProfileConfig,
  userId: string | undefined,
  accessStore: AccessStore
): Promise<boolean> {
  if (!userId) {
    return false;
  }
  return (
    isBootstrapSuperAdmin(profile, userId) ||
    (await accessStore.hasActivePrincipal(profile.name, "admin", userId))
  );
}

function isBootstrapSuperAdmin(profile: BotProfileConfig, userId: string | undefined): boolean {
  if (!userId) {
    return false;
  }
  return profile.adminUserId === userId;
}

async function isDirectUserAllowed(
  profile: BotProfileConfig,
  userId: string | undefined,
  accessStore: AccessStore
): Promise<boolean> {
  if (!userId) {
    return false;
  }
  return (
    directAccessPolicy(profile) === "public" ||
    isBootstrapSuperAdmin(profile, userId) ||
    (await accessStore.hasActivePrincipal(profile.name, "admin", userId)) ||
    (await accessStore.hasActivePrincipal(profile.name, "user", userId))
  );
}

async function isGroupAllowed(
  profile: BotProfileConfig,
  groupId: string | undefined,
  accessStore: AccessStore
): Promise<boolean> {
  if (!groupId) {
    return false;
  }
  return accessStore.hasActivePrincipal(profile.name, "group", groupId);
}

function directAccessPolicy(profile: BotProfileConfig) {
  return profile.directAccessPolicy ?? (profile.allowDirectUser ? "managed" : "blocked");
}

function groupAccessPolicy(profile: BotProfileConfig) {
  return profile.groupAccessPolicy ?? "blocked";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function messageTypeAllowed(profile: BotProfileConfig, event: LineEvent): boolean {
  const messageType = event.message?.type?.trim().toLowerCase();
  if (!messageType) {
    return false;
  }
  return profile.allowedMessageTypes.map((type) => type.toLowerCase()).includes(messageType);
}

async function matchingTextMessageHandler(
  event: LineEvent,
  profile: BotProfileConfig,
  textMessageHandlers: TextMessageHandlerRegistry
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) {
    return undefined;
  }
  for (const [name, handler] of Object.entries(textMessageHandlers)) {
    if (await handler.matches({ text }, { profile, event })) {
      return { name, handler };
    }
  }
  return undefined;
}

async function emitRouteEvent(
  observer: RouteObserver | undefined,
  event: RouteObserverEvent
): Promise<void> {
  if (!observer) {
    return;
  }
  try {
    await observer(event);
  } catch {
    // Observability must not change LINE webhook behavior.
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function matchesWakeRule(profile: BotProfileConfig, message?: LineMessage): boolean {
  const text = typeof message?.text === "string" ? message.text : "";
  if (profile.wakeKeywords.some((keyword) => keyword && text.includes(keyword))) {
    return true;
  }
  return Boolean(
    profile.acceptMention && message?.mention?.mentionees?.some((mentionee) => mentionee.isSelf)
  );
}

function formatIgnoredSummary(counts: Map<string, number>): string {
  if (counts.size === 0) {
    return "";
  }
  if (counts.size === 1) {
    return counts.keys().next().value ?? "";
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

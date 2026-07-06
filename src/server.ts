import { randomUUID } from "node:crypto";

import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createLineSdkReplyClient } from "./clients/line.js";
import { createIntroReply } from "./intro.js";
import { buildFunctionQuickReplies } from "./line-reply.js";
import { verifyLineSignature } from "./line-signature.js";
import { messages } from "./messages.js";
import {
  formatLastErrors,
  InMemoryLastErrorStore,
  type LastErrorStore
} from "./observability/last-error-store.js";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import type {
  AppConfig,
  AdminHandlerRegistry,
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionRegistry,
  FunctionRouterPort,
  LineEvent,
  LineMessage,
  LineReplyClient,
  LineWebhookPayload,
  PostbackHandlerRegistry,
  PostbackRequest,
  RouteObserver,
  RouteObserverEvent,
  TextMessageHandlerRegistry
} from "./types.js";

export interface AppDependencies {
  router: FunctionRouterPort;
  functionRegistry?: FunctionRegistry;
  postbackHandlers?: PostbackHandlerRegistry;
  textMessageHandlers?: TextMessageHandlerRegistry;
  adminHandlers?: AdminHandlerRegistry;
  createLineReplyClient?: (profile: BotProfileConfig) => LineReplyClient;
  routeObserver?: RouteObserver;
  requestIdFactory?: () => string;
  lastErrorStore?: LastErrorStore;
  rateLimiter?: RateLimiter;
}

interface AllowResult {
  allowed: boolean;
  reason: string;
}

interface ParsedAdminCommand {
  command: string;
  args: string[];
}

export function createApp(config: AppConfig, deps: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes
  });
  const functionRegistry = deps.functionRegistry ?? {};
  const createReplyClient = deps.createLineReplyClient ?? createLineSdkReplyClient;
  const requestIdFactory = deps.requestIdFactory ?? randomUUID;
  const lastErrorStore =
    deps.lastErrorStore ?? new InMemoryLastErrorStore(config.lastErrors?.maxEntries ?? 20);
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
        deps.routeObserver,
        requestIdFactory,
        lastErrorStore,
        rateLimiter
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
  routeObserver: RouteObserver | undefined,
  requestIdFactory: () => string,
  lastErrorStore: LastErrorStore,
  rateLimiter: RateLimiter
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
    const allow = await allowEvent(profile, event, textMessageHandlers);
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
  for (const event of allowedEvents) {
    const requestId = requestIdFactory();

    if (event.type === "postback") {
      if (!event.replyToken) {
        continue;
      }
      const startedAt = Date.now();
      const result = await handlePostbackEvent(event, profile, postbackHandlers, requestId);
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
      const adminStartedAt = Date.now();
      let adminResult: FunctionExecutionResult;
      try {
        adminResult = await handleAdminCommand(
          event.message.text,
          profile,
          event,
          adminHandlers,
          router,
          lastErrorStore,
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
        authorized: adminAllowed(profile, event),
        ok: adminResult.ok,
        durationMs: elapsedMs(adminStartedAt)
      });
      await line.replyText(event.replyToken, adminResult.replyText, undefined);
      continue;
    }

    const intro = createIntroReply(profile, event.message.text);
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
      profile,
      textMessageHandlers
    );
    if (textMessageHandler) {
      const handlerStartedAt = Date.now();
      const result = await textMessageHandler.handler.handle(
        { text: event.message.text },
        { profile, event, requestId }
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
        profileName: profile.name,
        text: event.message.text,
        enabledFunctions: profile.enabledFunctions,
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
      action: route.type === "execute" ? route.action : undefined,
      reason: route.type === "deny" ? route.reason : undefined,
      confidence: route.type === "execute" ? route.confidence : undefined,
      fallbackProvider: route.fallbackProvider,
      fallbackReason: route.fallbackReason,
      durationMs: elapsedMs(routeStartedAt)
    });

    if (route.type === "deny") {
      const quickReplies = buildFunctionQuickReplies(profile);
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
      const result = await handler(route.arguments, { profile, event, requestId });
      await emitRouteEvent(routeObserver, {
        kind: "function_result",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
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
      await line.replyText(event.replyToken, messages.requestFailed);
    }
  }

  return reply.send({
    ok: true,
    allowedEvents: allowedEvents.length,
    ignored: ignoredCounts.size > 0 ? formatIgnoredSummary(ignoredCounts) : undefined
  });
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

async function allowEvent(
  profile: BotProfileConfig,
  event: LineEvent,
  textMessageHandlers: TextMessageHandlerRegistry
): Promise<AllowResult> {
  const eventType = event.type?.trim().toLowerCase();
  const sourceType = event.source?.type?.trim().toLowerCase();

  switch (sourceType) {
    case "room":
      if (!profile.allowRooms) {
        return { allowed: false, reason: "room_blocked" };
      }
      return { allowed: false, reason: "room_not_implemented" };

    case "group":
      if (!isAllowedId(profile.allowedGroupIds, event.source.groupId)) {
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
      if (isAdminCommand(event.message?.text)) {
        return { allowed: true, reason: "group_admin_command_allowed" };
      }
      if (!profile.groupRequireWakeWord || matchesWakeRule(profile, event.message)) {
        return { allowed: true, reason: "group_wake_matched" };
      }
      if (await matchingTextMessageHandler(event, profile, textMessageHandlers)) {
        return { allowed: true, reason: "group_text_message_handler_matched" };
      }
      return { allowed: false, reason: "wake_word_missing" };

    case "user":
      if (!profile.allowDirectUser) {
        return { allowed: false, reason: "direct_user_blocked" };
      }
      if (isAdminCommand(event.message?.text)) {
        return { allowed: true, reason: "direct_admin_command_allowed" };
      }
      if (!isAllowedId(profile.allowedUserIds, event.source.userId)) {
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

function handleAdminCommand(
  text: string,
  profile: BotProfileConfig,
  event: LineEvent,
  adminHandlers: AdminHandlerRegistry,
  router: FunctionRouterPort,
  lastErrorStore: LastErrorStore,
  requestId: string
): Promise<FunctionExecutionResult> | FunctionExecutionResult {
  if (!adminAllowed(profile, event)) {
    return { ok: true, replyText: messages.adminUnauthorized };
  }

  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
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

  const handler = adminHandlers[parsed.command];
  if (handler) {
    return handler({ profile, event, command: parsed.command, args: parsed.args, requestId });
  }

  return { ok: true, replyText: "目前不支援這個 admin 指令。" };
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

function adminAllowed(profile: BotProfileConfig, event: LineEvent): boolean {
  if (!isAdminUser(profile, event.source.userId)) {
    return false;
  }
  if (profile.adminDirectOnly !== false && event.source.type !== "user") {
    return false;
  }
  return true;
}

function isAdminUser(profile: BotProfileConfig, userId: string | undefined): boolean {
  if (!userId) {
    return false;
  }
  return (profile.adminUserIds ?? []).includes(userId);
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

function isAllowedId(allowedIds: string[], actual?: string): boolean {
  if (!actual) {
    return false;
  }
  return allowedIds.includes("*") || allowedIds.includes(actual);
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

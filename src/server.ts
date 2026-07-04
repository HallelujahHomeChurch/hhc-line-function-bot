import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createLineSdkReplyClient } from "./clients/line.js";
import { verifyLineSignature } from "./line-signature.js";
import type {
  AppConfig,
  BotProfileConfig,
  FunctionRegistry,
  FunctionRouterPort,
  LineEvent,
  LineMessage,
  LineReplyClient,
  LineWebhookPayload
} from "./types.js";

export interface AppDependencies {
  router: FunctionRouterPort;
  functionRegistry?: FunctionRegistry;
  createLineReplyClient?: (profile: BotProfileConfig) => LineReplyClient;
}

interface AllowResult {
  allowed: boolean;
  reason: string;
}

export function createApp(config: AppConfig, deps: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes
  });
  const functionRegistry = deps.functionRegistry ?? {};
  const createReplyClient = deps.createLineReplyClient ?? createLineSdkReplyClient;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get(config.healthPath, async () => ({
    ok: true,
    service: config.serviceName,
    profiles: config.profiles.map((profile) => ({
      name: profile.name,
      webhookPath: profile.webhookPath,
      enabledFunctions: profile.enabledFunctions
    })),
    llm: {
      primary: "ollama",
      model: config.llm.ollamaModel,
      fallback: config.llm.azureFallbackEnabled ? "azure_openai" : "disabled"
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
        createReplyClient
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
  createReplyClient: (profile: BotProfileConfig) => LineReplyClient
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
    const allow = allowEvent(profile, event);
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
    if (event.type !== "message" || event.message?.type !== "text" || !event.message.text) {
      continue;
    }

    const route = await router.route({
      profileName: profile.name,
      text: event.message.text,
      enabledFunctions: profile.enabledFunctions,
      source: event.source
    });

    if (!event.replyToken) {
      continue;
    }

    if (route.type === "deny") {
      await line.replyText(event.replyToken, "目前不支援這個請求。");
      continue;
    }

    const handler = functionRegistry[route.action];
    if (!handler) {
      await line.replyText(event.replyToken, "這個功能尚未完成設定。");
      continue;
    }

    try {
      const result = await handler(route.arguments);
      await line.replyText(event.replyToken, result.replyText);
    } catch {
      await line.replyText(event.replyToken, "處理請求時發生錯誤。");
    }
  }

  return reply.send({
    ok: true,
    allowedEvents: allowedEvents.length,
    ignored: ignoredCounts.size > 0 ? formatIgnoredSummary(ignoredCounts) : undefined
  });
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

function allowEvent(profile: BotProfileConfig, event: LineEvent): AllowResult {
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
      if (eventType !== "message") {
        return { allowed: false, reason: "event_type_not_allowed" };
      }
      if (!messageTypeAllowed(profile, event)) {
        return { allowed: false, reason: "message_type_not_allowed" };
      }
      if (!profile.groupRequireWakeWord || matchesWakeRule(profile, event.message)) {
        return { allowed: true, reason: "group_wake_matched" };
      }
      return { allowed: false, reason: "wake_word_missing" };

    case "user":
      if (!profile.allowDirectUser) {
        return { allowed: false, reason: "direct_user_blocked" };
      }
      if (!isAllowedId(profile.allowedUserIds, event.source.userId)) {
        return { allowed: false, reason: "user_not_allowed" };
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

function messageTypeAllowed(profile: BotProfileConfig, event: LineEvent): boolean {
  const messageType = event.message?.type?.trim().toLowerCase();
  if (!messageType) {
    return false;
  }
  return profile.allowedMessageTypes.map((type) => type.toLowerCase()).includes(messageType);
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

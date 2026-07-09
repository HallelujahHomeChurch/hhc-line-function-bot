import { randomUUID } from "node:crypto";

import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { InMemoryAccessStore } from "./access/memory-access-store.js";
import { createAdminActionRegistry, type AdminActionRegistry } from "./actions/admin-registry.js";
import type { ConfirmationStore } from "./actions/confirmation-store.js";
import {
  InMemoryRegistrationInviteCodeStore,
  type RegistrationInviteCodeStore
} from "./access/registration-invite-code-store.js";
import type { AgentRuntime } from "./agent/agent-runtime.js";
import { createAgentTurnRuntime, type AgentTurnRuntime } from "./agent/turn-runtime.js";
import { InMemoryAgentJobStore, type AgentJobScope, type AgentJobStore } from "./agent/jobs.js";
import {
  createContextManager,
  InMemoryConversationWindowStore,
  type ConversationWindowScope,
  type ConversationWindowStore
} from "./agent/context-manager.js";
import {
  formatAgentTurnTraces,
  InMemoryAgentTraceStore,
  type AgentTraceStore
} from "./agent/trace-store.js";
import type { AccessPrincipalType, AccessStore } from "./access/types.js";
import { createStaticAppDiagnostics } from "./diagnostics/dependencies.js";
import {
  classifyGroupEngagement,
  groupEngagementAllowsReply,
  groupEngagementIgnoredReason
} from "./engagement.js";
import { createLineSdkIdentityClient, createLineSdkReplyClient } from "./clients/line.js";
import { getFunctionDefinitions } from "./functions/definitions.js";
import { MemoryInFlightStore, type InFlightStore } from "./in-flight/in-flight-store.js";
import { createIntroReply } from "./intro.js";
import { buildFunctionQuickReplies, buildPostbackQuickReply } from "./line-reply.js";
import { verifyLineSignature } from "./line-signature.js";
import { allowedProvidersForProfile, providerIsAllowedForProfile } from "./llm/provider-runtime.js";
import { messages } from "./messages.js";
import { sanitizeActionTelemetryEvent } from "./observability/action-telemetry.js";
import { resolveRequesterDisplayName } from "./requester-personalization.js";
import { createControlledSmallTalkReply } from "./small-talk.js";
import { InMemoryWebAllowlistStore, type WebAllowlistStore } from "./web/allowlist.js";
import {
  formatLastErrors,
  InMemoryLastErrorStore,
  type LastErrorStore
} from "./observability/last-error-store.js";
import {
  formatLastRoutes,
  InMemoryLastRouteStore,
  type LastRouteStore
} from "./observability/last-route-store.js";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import type { SessionStore } from "./state/session-store.js";
import type {
  AppConfig,
  AppDiagnostics,
  AgentResourceType,
  AdminHandlerRegistry,
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionRegistry,
  FunctionRouterPort,
  AdminActionRouterPort,
  LineIdentityClient,
  LineEvent,
  ModelProviderName,
  LineReplyClient,
  LineWebhookPayload,
  FunctionName,
  PostbackHandlerRegistry,
  PostbackRequest,
  RouteObserver,
  RouteObserverEvent,
  TextGenerationProvider,
  TextMessageHandlerRegistry
} from "./types.js";
import { FUNCTION_NAMES, isFunctionName } from "./types.js";

export interface AppDependencies {
  router: FunctionRouterPort;
  adminActionRouter?: AdminActionRouterPort;
  adminActionRegistry?: AdminActionRegistry;
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
  diagnostics?: AppDiagnostics;
  confirmationStore?: ConfirmationStore;
  inFlightStore?: InFlightStore;
  textGenerator?: TextGenerationProvider;
  agentRuntime?: AgentRuntime;
  agentTurnRuntime?: AgentTurnRuntime;
  agentTraceStore?: AgentTraceStore;
  sessionStore?: SessionStore;
  agentJobStore?: AgentJobStore;
  conversationWindowStore?: ConversationWindowStore;
  webAllowlistStore?: WebAllowlistStore;
  textFallbackGenerator?: TextGenerationProvider;
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
    title: "Web allowlist",
    entries: [
      { usage: "/web-allowlist", description: "list controlled web targets" },
      { usage: "/web-allowlist-add <domain> [pathPrefix]", description: "allow a HTTPS domain" },
      { usage: "/web-allowlist-enable <id>", description: "enable a web target" },
      { usage: "/web-allowlist-disable <id>", description: "disable a web target" },
      { usage: "/web-allowlist-remove <id>", description: "remove a web target" }
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
      { usage: "/admin-remove <userId>", description: "superadmin 停用 admin" },
      { usage: "/llm-use <provider>", description: "show/change the active provider" }
    ]
  },
  {
    title: "診斷",
    entries: [
      { usage: "/help admin", description: "列出常用 admin 指令" },
      { usage: "/help admin all", description: "列出完整 admin 指令" },
      { usage: "/status", description: "查看目前 profile 狀態" },
      { usage: "/profile", description: "查看目前 LINE 來源與 profile 設定摘要" },
      { usage: "/diag", description: "查看服務診斷摘要" },
      { usage: "/confirm <code>", description: "確認需要二次確認的操作" },
      { usage: "/route-test <text>", description: "測試一段文字會 route 到哪個 function" },
      { usage: "/last-errors", description: "查看最近錯誤" },
      { usage: "/last-routes", description: "查看最近 route/function 結果" },
      { usage: "/last-agent-turns [limit]", description: "查看最近 agent runtime 步驟" },
      { usage: "/memory-status", description: "查看 agent memory 統計" }
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
  const adminActionRouter = deps.adminActionRouter;
  const createReplyClient = deps.createLineReplyClient ?? createLineSdkReplyClient;
  const createIdentityClient = deps.createLineIdentityClient ?? createLineSdkIdentityClient;
  const requestIdFactory = deps.requestIdFactory ?? randomUUID;
  const accessStore = deps.accessStore ?? new InMemoryAccessStore();
  const registrationInviteCodeStore =
    deps.registrationInviteCodeStore ?? new InMemoryRegistrationInviteCodeStore();
  const registrationInviteCodeTtlMinutes = config.access?.registrationInviteCodeTtlMinutes ?? 60;
  const webAllowlistStore = deps.webAllowlistStore ?? new InMemoryWebAllowlistStore();
  const adminActionRegistry =
    deps.adminActionRegistry ??
    createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes,
      confirmationStore: deps.confirmationStore,
      confirmationTtlMinutes: config.access?.confirmationTtlMinutes,
      webAllowlistStore
    });
  const lastErrorStore =
    deps.lastErrorStore ?? new InMemoryLastErrorStore(config.lastErrors?.maxEntries ?? 20);
  const lastRouteStore =
    deps.lastRouteStore ?? new InMemoryLastRouteStore(config.lastErrors?.maxEntries ?? 20);
  const rateLimiter =
    deps.rateLimiter ??
    new InMemoryRateLimiter(
      config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
    );
  const diagnostics = deps.diagnostics ?? createStaticAppDiagnostics(config);
  const inFlightStore = deps.inFlightStore ?? new MemoryInFlightStore();
  const textGenerator = deps.textGenerator;
  const textFallbackGenerator = deps.textFallbackGenerator;
  const agentTraceStore =
    deps.agentTraceStore ?? new InMemoryAgentTraceStore(config.lastErrors?.maxEntries ?? 20);
  const agentJobStore = deps.agentJobStore ?? new InMemoryAgentJobStore();
  const conversationWindowStore =
    deps.conversationWindowStore ?? new InMemoryConversationWindowStore();
  const contextManager = createContextManager({
    runtimeContextBudgetTokens: config.llm.runtimeContextBudgetTokens ?? 2000,
    compressionThresholdRatio: config.llm.contextCompressionThresholdRatio ?? 0.75
  });
  const agentTurnRuntime =
    deps.agentTurnRuntime ??
    createAgentTurnRuntime({
      router: deps.router,
      functionRegistry,
      textMessageHandlers: deps.textMessageHandlers ?? {},
      adminActionRouter,
      adminActionRegistry,
      accessStore,
      inFlightStore,
      sessionStore: deps.sessionStore,
      agentRuntime: deps.agentRuntime,
      traceStore: agentTraceStore,
      lastErrorStore,
      lastRouteStore,
      routeObserver: deps.routeObserver,
      textGenerator,
      textFallbackGenerator,
      contextManager,
      conversationWindowStore
    });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get(config.healthPath, async () => ({
    ok: true,
    service: config.serviceName,
    timestamp: new Date().toISOString()
  }));

  app.get(config.readyPath ?? "/readyz", async (_request, reply) => {
    const readiness = await diagnostics.checkPublicReadiness();
    return reply.code(readiness.status === "ok" ? 200 : 503).send(readiness);
  });

  for (const profile of config.profiles) {
    app.post(profile.webhookPath, async (request, reply) => {
      await handleWebhook(
        request,
        reply,
        profile,
        config,
        deps.router,
        adminActionRegistry,
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
        diagnostics,
        agentTurnRuntime,
        agentTraceStore,
        textGenerator,
        textFallbackGenerator,
        deps.agentRuntime,
        agentJobStore,
        conversationWindowStore,
        webAllowlistStore
      );
    });
  }

  return app;
}

async function handleWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  profile: BotProfileConfig,
  config: AppConfig,
  router: FunctionRouterPort,
  adminActionRegistry: AdminActionRegistry,
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
  diagnostics: AppDiagnostics,
  agentTurnRuntime: AgentTurnRuntime,
  agentTraceStore: AgentTraceStore,
  textGenerator: TextGenerationProvider | undefined,
  textFallbackGenerator: TextGenerationProvider | undefined,
  agentRuntime: AgentRuntime | undefined,
  agentJobStore: AgentJobStore,
  conversationWindowStore: ConversationWindowStore,
  webAllowlistStore: WebAllowlistStore
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
    const allow = await allowEvent(
      profile,
      event,
      textMessageHandlers,
      accessStore,
      conversationWindowStore
    );
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
    const requesterDisplayName = await resolveRequesterDisplayName(lineIdentity, event);

    if (event.type === "postback") {
      if (!event.replyToken) {
        continue;
      }
      const startedAt = Date.now();
      const result = await handlePostbackEvent(
        event,
        effectiveProfile,
        postbackHandlers,
        requestId,
        requesterDisplayName,
        agentJobStore
      );
      const postbackFunctionName = functionNameForAgentResource(result.agentResource?.resourceType);
      if (postbackFunctionName) {
        await agentRuntime?.afterFunctionResult({
          context: { profile: effectiveProfile, event, requestId, requesterDisplayName },
          action: postbackFunctionName,
          arguments: {},
          result
        });
      }
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
      const agentCommandResult = await agentRuntime?.handleCommand({
        text: event.message.text,
        context: { profile: effectiveProfile, event, requestId, requesterDisplayName },
        isAdmin: await adminAllowed(
          effectiveProfile,
          event,
          accessStore,
          parsedAdminCommand?.command
        )
      });
      if (agentCommandResult) {
        await line.replyText(
          event.replyToken,
          agentCommandResult.replyText,
          agentCommandResult.quickReplies
            ? { quickReplies: agentCommandResult.quickReplies }
            : undefined
        );
        continue;
      }
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
          config,
          adminHandlers,
          router,
          lastErrorStore,
          lastRouteStore,
          accessStore,
          adminActionRegistry,
          diagnostics,
          agentTraceStore,
          requestId,
          webAllowlistStore
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

    const groupEngagement =
      event.source.type === "group"
        ? classifyGroupEngagement(effectiveProfile, event.message)
        : undefined;
    const conversationScope = buildConversationWindowScope(effectiveProfile, event);
    const conversationWindowActive =
      event.source.type === "group" &&
      Boolean(effectiveProfile.generalAgent?.enabled) &&
      Boolean(conversationScope) &&
      (await conversationWindowStore.isActive(conversationScope as ConversationWindowScope));
    if (groupEngagement?.kind === "intro") {
      const intro = createIntroReply(effectiveProfile, event.message.text, { force: true });
      await emitRouteEvent(routeObserver, {
        kind: "route",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        outcome: "respond",
        action: "introduce_bot",
        engagement: "intro"
      });
      await line.replyText(
        event.replyToken,
        intro?.replyText ?? messages.requestFailed,
        intro?.quickReplies ? { quickReplies: intro.quickReplies } : undefined
      );
      if (intro) {
        await recordConversationReply(conversationWindowStore, effectiveProfile, event, intro);
      }
      continue;
    }
    if (groupEngagement?.kind === "small_talk" && groupEngagement.smallTalkCategory) {
      const result = await createControlledSmallTalkReply({
        profile: effectiveProfile,
        text: event.message.text,
        category: groupEngagement.smallTalkCategory,
        generator: textGenerator,
        fallbackGenerator: textFallbackGenerator
      });
      await emitRouteEvent(routeObserver, {
        kind: "route",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        outcome: "respond",
        action: "small_talk",
        engagement: groupEngagement.kind,
        smallTalkCategory: groupEngagement.smallTalkCategory
      });
      await line.replyText(event.replyToken, result.replyText, undefined);
      await recordConversationReply(conversationWindowStore, effectiveProfile, event, result);
      continue;
    }

    const intro = createIntroReply(effectiveProfile, event.message.text);
    if (intro) {
      await line.replyText(
        event.replyToken,
        intro.replyText,
        intro.quickReplies ? { quickReplies: intro.quickReplies } : undefined
      );
      await recordConversationReply(conversationWindowStore, effectiveProfile, event, intro);
      continue;
    }

    const routingAllowed =
      !groupEngagement || groupEngagementAllowsReply(groupEngagement) || conversationWindowActive;

    const agentTurnResult = await handleAgentTextTurnWithLongJob({
      runtime: agentTurnRuntime,
      jobStore: agentJobStore,
      profile: effectiveProfile,
      event,
      requestId,
      requesterDisplayName,
      engagement: conversationWindowActive ? "conversation_window" : groupEngagement?.kind,
      allowRouting: routingAllowed
    });
    if (agentTurnResult) {
      await line.replyText(
        event.replyToken,
        agentTurnResult.replyText,
        agentTurnResult.quickReplies ? { quickReplies: agentTurnResult.quickReplies } : undefined
      );
      await recordConversationReply(
        conversationWindowStore,
        effectiveProfile,
        event,
        agentTurnResult
      );
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
  requestId: string,
  requesterDisplayName: string | undefined,
  agentJobStore: AgentJobStore
) {
  const request = parsePostbackData(event.postback?.data ?? "");
  if (!request) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  if (request.action === "agent_job_result") {
    return handleAgentJobResultPostback(request, profile, event, agentJobStore);
  }
  const handler = postbackHandlers[request.action];
  if (!handler) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  return handler(request, { profile, event, requestId, requesterDisplayName });
}

function parsePostbackData(data: string): PostbackRequest | null {
  const params = Object.fromEntries(new URLSearchParams(data));
  const action = params.action;
  if (!action) {
    return null;
  }
  return { action, params };
}

async function handleAgentTextTurnWithLongJob(input: {
  runtime: AgentTurnRuntime;
  jobStore: AgentJobStore;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  engagement?: string;
  allowRouting: boolean;
}): Promise<FunctionExecutionResult | undefined> {
  const turnPromise = input.runtime.handleTextTurn({
    profile: input.profile,
    event: input.event,
    requestId: input.requestId,
    requesterDisplayName: input.requesterDisplayName,
    engagement: input.engagement,
    allowRouting: input.allowRouting
  });
  const config = input.profile.longRunningJobs;
  if (!config?.enabled || config.inlineReplyTimeoutMs <= 0) {
    return turnPromise;
  }
  const scope = buildAgentJobScope(input.profile, input.event);
  if (!scope) {
    return turnPromise;
  }
  const timeout = sleep(config.inlineReplyTimeoutMs).then(() => timeoutSymbol);
  const first = await Promise.race([turnPromise, timeout]);
  if (first === timeoutSymbol) {
    const job = await input.jobStore.createPending({
      scope,
      label: input.event.message?.text?.slice(0, 40) || "agent-turn",
      ttlMs: config.resultTtlMinutes * 60_000
    });
    turnPromise
      .then((result) =>
        input.jobStore.complete(
          job.id,
          result ?? { ok: true, replyText: "這次沒有需要回覆的結果。" }
        )
      )
      .catch((error: unknown) =>
        input.jobStore.fail(job.id, error instanceof Error ? error.message : String(error))
      );

    return {
      ok: true,
      replyText: waitingForAgentJobReply(input.requesterDisplayName),
      quickReplies: [buildAgentJobQuickReply(job.id)]
    };
  }
  return first as FunctionExecutionResult | undefined;
}

async function handleAgentJobResultPostback(
  request: PostbackRequest,
  profile: BotProfileConfig,
  event: LineEvent,
  jobStore: AgentJobStore
): Promise<FunctionExecutionResult> {
  const jobId = request.params.jobId;
  const scope = buildAgentJobScope(profile, event);
  if (!jobId || !scope) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  const job = await jobStore.get(jobId, scope);
  if (!job) {
    return { ok: true, replyText: "找不到這筆結果，可能已經過期，請再問一次。" };
  }
  if (job.status === "pending") {
    return {
      ok: true,
      replyText: "我還在處理，稍後可以再按一次查看結果。",
      quickReplies: [buildAgentJobQuickReply(job.id)]
    };
  }
  if (job.status === "failed") {
    return { ok: true, replyText: "剛剛處理時遇到問題，請再問一次。" };
  }
  return job.result ?? { ok: true, replyText: "這筆任務沒有可顯示的結果。" };
}

function buildAgentJobQuickReply(jobId: string) {
  return buildPostbackQuickReply(
    "查看結果",
    `action=agent_job_result&jobId=${encodeURIComponent(jobId)}`,
    "查看結果"
  );
}

function buildAgentJobScope(
  profile: BotProfileConfig,
  event: LineEvent
): AgentJobScope | undefined {
  const source = sourceKey(event.source);
  if (!source) {
    return undefined;
  }
  if (event.source.type !== "user" && !event.source.userId) {
    return undefined;
  }
  return {
    profileName: profile.name,
    sourceKey: source,
    requesterUserId: event.source.userId
  };
}

function waitingForAgentJobReply(displayName: string | undefined): string {
  return displayName
    ? `${displayName}，我先處理這個查詢。等一下可以按「查看結果」。`
    : "我先處理這個查詢。等一下可以按「查看結果」。";
}

const timeoutSymbol = Symbol("agent_turn_timeout");

function sleep(ms: number): Promise<typeof timeoutSymbol> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(timeoutSymbol), ms);
  });
}

function sourceKey(source: LineEvent["source"]): string | undefined {
  switch (source.type) {
    case "group":
      return source.groupId ? `group:${source.groupId}` : undefined;
    case "room":
      return source.roomId ? `room:${source.roomId}` : undefined;
    case "user":
      return source.userId ? `user:${source.userId}` : undefined;
    default:
      return undefined;
  }
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
  const engagement = classifyGroupEngagement(profile, event.message);
  if (!profile.groupRequireWakeWord || groupEngagementAllowsReply(engagement)) {
    return true;
  }
  return Boolean(await matchingTextMessageHandler(event, profile, textMessageHandlers));
}

async function allowEvent(
  profile: BotProfileConfig,
  event: LineEvent,
  textMessageHandlers: TextMessageHandlerRegistry,
  accessStore: AccessStore,
  conversationWindowStore: ConversationWindowStore
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

    case "group": {
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
      const engagement = classifyGroupEngagement(profile, event.message);
      if (!profile.groupRequireWakeWord || groupEngagementAllowsReply(engagement)) {
        return { allowed: true, reason: `group_${engagement.kind}_matched` };
      }
      if (await hasActiveConversationWindow(profile, event, conversationWindowStore)) {
        return { allowed: true, reason: "group_conversation_window_active" };
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
      return { allowed: false, reason: groupEngagementIgnoredReason(engagement) };
    }

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
      "/memories - 列出目前記住的資訊",
      "/forget-memory <id> - 移除一段記憶",
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

async function hasActiveConversationWindow(
  profile: BotProfileConfig,
  event: LineEvent,
  store: ConversationWindowStore
): Promise<boolean> {
  if (!profile.generalAgent?.enabled) {
    return false;
  }
  const scope = buildConversationWindowScope(profile, event);
  return scope ? store.isActive(scope) : false;
}

async function recordConversationReply(
  store: ConversationWindowStore,
  profile: BotProfileConfig,
  event: LineEvent,
  result: FunctionExecutionResult
): Promise<void> {
  const ttlMs = conversationWindowTtlMs(profile);
  const scope = buildConversationWindowScope(profile, event);
  const userText = event.message?.text;
  if (!ttlMs || !scope || !userText || !result.replyText) {
    return;
  }
  await store.recordTurn({ scope, role: "user", text: userText, ttlMs });
  await store.recordTurn({ scope, role: "assistant", text: result.replyText, ttlMs });
}

function buildConversationWindowScope(
  profile: BotProfileConfig,
  event: LineEvent
): ConversationWindowScope | undefined {
  if (event.source.type !== "group" || !event.source.groupId || !event.source.userId) {
    return undefined;
  }
  const key = sourceKey(event.source);
  if (!key) {
    return undefined;
  }
  return {
    profileName: profile.name,
    sourceKey: key,
    requesterUserId: event.source.userId
  };
}

function conversationWindowTtlMs(profile: BotProfileConfig): number {
  if (!profile.generalAgent?.enabled) {
    return 0;
  }
  return Math.max(1, profile.generalAgent.conversationWindowSeconds) * 1000;
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
  config: AppConfig,
  adminHandlers: AdminHandlerRegistry,
  router: FunctionRouterPort,
  lastErrorStore: LastErrorStore,
  lastRouteStore: LastRouteStore,
  accessStore: AccessStore,
  adminActionRegistry: AdminActionRegistry,
  diagnostics: AppDiagnostics,
  agentTraceStore: AgentTraceStore,
  requestId: string,
  webAllowlistStore: WebAllowlistStore
): Promise<FunctionExecutionResult> {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (!isKnownAdminCommand(parsed.command, adminHandlers)) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (parsed.command === "llm-use") {
    return handleLlmUseCommand(config, profile, event, parsed.args[0]);
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
        `webhookPath: ${profile.webhookPath}`,
        `source: ${event.source.type}`,
        `functions: ${profile.enabledFunctions.join(", ") || "(none)"}`,
        `adminDirectOnly: ${profile.adminDirectOnly !== false}`
      ].join("\n")
    };
  }

  if (parsed.command === "diag") {
    return {
      ok: true,
      replyText: await diagnostics.formatAdminDiagnostics()
    };
  }

  if (parsed.command === "confirm") {
    const code = parsed.args[0];
    if (!code) {
      return { ok: true, replyText: "Usage: /confirm <code>" };
    }
    return adminActionRegistry.confirm({
      code,
      profile,
      event
    });
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

  if (parsed.command === "last-agent-turns") {
    const limit = Math.min(parsePositiveInt(parsed.args[0]) ?? 10, 50);
    return {
      ok: true,
      replyText: formatAgentTurnTraces(await agentTraceStore.list(limit))
    };
  }

  const accessResult = await handleAdminAccessCommand(
    parsed.command,
    parsed.args,
    profile,
    event,
    accessStore,
    adminActionRegistry,
    webAllowlistStore
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

async function handleLlmUseCommand(
  config: AppConfig,
  profile: BotProfileConfig,
  event: LineEvent,
  providerArg: string | undefined
): Promise<FunctionExecutionResult> {
  const actorUserId = event.source.userId;
  if (!isBootstrapSuperAdmin(profile, actorUserId)) {
    return { ok: true, replyText: "你沒有權限使用 LLM provider 指令。" };
  }
  if (event.source.type !== "user") {
    return { ok: true, replyText: "請在 1 對 1 對話中使用 LLM provider 指令。" };
  }
  if (!providerArg) {
    const availableProviders = allowedProvidersForProfile(profile);
    const active = profile.providerPolicy?.smart_talk
      ? formatLanePolicy(profile.providerPolicy.smart_talk)
      : (availableProviders[0] ?? "ollama");
    const available = availableProviders.join(", ") || "(none)";
    return {
      ok: true,
      replyText: [
        "LLM provider",
        `profile: ${profile.name}`,
        `active: ${active ?? "(none)"}`,
        `available: ${available}`,
        "目前 provider 由 profile/env 設定；LINE 指令先提供查詢與驗證，不做持久化切換。"
      ].join("\n")
    };
  }
  const provider = resolveProviderArg(providerArg, profile);
  if (!provider) {
    return { ok: true, replyText: `不支援的 LLM provider：${providerArg}` };
  }
  if (!providerIsAllowedForProfile(profile, provider)) {
    return { ok: true, replyText: `provider is not allowed for this profile: ${provider}` };
  }
  return {
    ok: true,
    replyText: `Provider ${provider} 可用；請透過 profile/env 設定切換後重新部署。`
  };
}

function resolveProviderArg(
  value: string | undefined,
  profile: BotProfileConfig
): ModelProviderName | undefined {
  if (value === "ollama") {
    return "ollama";
  }
  if (value === "deepseek") {
    return "deepseek";
  }
  if (value) {
    return undefined;
  }
  return profile.providerPolicy?.smart_talk.primary ?? "ollama";
}

function formatLanePolicy(policy: {
  primary: ModelProviderName;
  fallback?: ModelProviderName;
}): string {
  return policy.fallback ? `${policy.primary} -> ${policy.fallback}` : policy.primary;
}

async function handleAdminAccessCommand(
  command: string,
  args: string[],
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  adminActionRegistry: AdminActionRegistry,
  webAllowlistStore: WebAllowlistStore
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

  if (command === "web-allowlist") {
    const entries = await webAllowlistStore.list(profile.name);
    return {
      ok: true,
      replyText:
        entries.length === 0
          ? "Web allowlist\n(none)"
          : [
              "Web allowlist",
              ...entries.map((entry) =>
                [
                  `- ${entry.id}`,
                  entry.enabled ? "enabled" : "disabled",
                  entry.domain,
                  entry.pathPrefix ? `path=${entry.pathPrefix}` : undefined,
                  entry.label ? `label=${entry.label}` : undefined
                ]
                  .filter(Boolean)
                  .join(" ")
              )
            ].join("\n")
    };
  }

  if (command === "web-allowlist-add") {
    const domain = args[0];
    if (!domain) {
      return { ok: true, replyText: "Usage: /web-allowlist-add <domain> [pathPrefix]" };
    }
    const entry = await webAllowlistStore.add({
      profileName: profile.name,
      domain,
      pathPrefix: args[1],
      createdBy: actorUserId
    });
    await accessStore.recordAudit({
      profileName: profile.name,
      actorUserId,
      action: "web_allowlist.add",
      targetType: "web_allowlist",
      targetId: entry.id,
      metadata: { domain: entry.domain, pathPrefix: entry.pathPrefix }
    });
    return {
      ok: true,
      replyText: `Added web allowlist\nid: ${entry.id}\ndomain: ${entry.domain}${
        entry.pathPrefix ? `\npath: ${entry.pathPrefix}` : ""
      }`
    };
  }

  if (command === "web-allowlist-enable" || command === "web-allowlist-disable") {
    const id = args[0];
    if (!id) {
      return { ok: true, replyText: `Usage: /${command} <id>` };
    }
    const enabled = command === "web-allowlist-enable";
    const changed = await webAllowlistStore.setEnabled(profile.name, id, enabled);
    if (changed) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: enabled ? "web_allowlist.enable" : "web_allowlist.disable",
        targetType: "web_allowlist",
        targetId: id
      });
    }
    return {
      ok: true,
      replyText: changed
        ? `${enabled ? "Enabled" : "Disabled"} web allowlist ${id}`
        : "Web allowlist entry not found"
    };
  }

  if (command === "web-allowlist-remove") {
    const id = args[0];
    if (!id) {
      return { ok: true, replyText: "Usage: /web-allowlist-remove <id>" };
    }
    const removed = await webAllowlistStore.remove(profile.name, id);
    if (removed) {
      await accessStore.recordAudit({
        profileName: profile.name,
        actorUserId,
        action: "web_allowlist.remove",
        targetType: "web_allowlist",
        targetId: id
      });
    }
    return {
      ok: true,
      replyText: removed ? `Removed web allowlist ${id}` : "Web allowlist entry not found"
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
    return adminActionRegistry.execute({
      action: "invite_code_create",
      profile,
      event
    });
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

function functionNameForAgentResource(resourceType: AgentResourceType | undefined) {
  switch (resourceType) {
    case "ppt_slide":
      return "find_ppt_slides";
    case "sheet_music":
      return "find_pop_sheet_music";
    default:
      return undefined;
  }
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
  textMessageHandlers: TextMessageHandlerRegistry,
  requesterDisplayName?: string
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) {
    return undefined;
  }
  for (const [name, handler] of Object.entries(textMessageHandlers)) {
    if (await handler.matches({ text }, { profile, event, requesterDisplayName })) {
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
    await observer(sanitizeActionTelemetryEvent(event) as RouteObserverEvent);
  } catch {
    // Observability must not change LINE webhook behavior.
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
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

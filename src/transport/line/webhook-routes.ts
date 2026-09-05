import type { CapabilityName } from "../../capabilities/names.js";
import fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminActionRegistry } from "../../actions/admin-registry.js";
import {
  enabledNaturalLanguageAdminActionNames,
  matchesGroupScopedNaturalLanguageAdminActionHint,
  matchesNaturalLanguageAdminActionHint,
  matchNaturalLanguageSystemActionHint
} from "../../actions/catalog.js";
import { evaluateActionPolicy } from "../../actions/policy.js";
import type { ConfirmationStore } from "../../actions/confirmation-store.js";
import type { RegistrationInviteCodeStore } from "../../access/registration-invite-code-store.js";
import type { ResourceMemoryObserver } from "../../agent/resource-memory.js";
import { matchExactWholeMessageIntent } from "../../functions/explicit-function-intent.js";
import type { AgentJobStore } from "../../agent/jobs.js";
import {
  type ConversationWindowScope,
  type ConversationWindowStore
} from "../../agent/context-manager.js";
import { formatAgentTurnTraces, type AgentTraceStore } from "../../agent/trace-store.js";
import type { AccessPrincipalType, AccessStore } from "../../access/types.js";
import {
  AccountApiError,
  type AccountAdminClient,
  type FinalizeLineBindingInput,
  type LineBindingTerminalStatus,
  type LineFunctionAuthorization
} from "../../account/account-admin-client.js";
import { resolveEffectiveAccessContext } from "../../application/access/effective-access.js";
import type { EffectiveAccessContext } from "../../application/access/effective-access.js";
import type { FunctionCompletionObserver } from "../../observability/function-completion.js";
import { projectEffectiveCapabilities } from "../../application/capabilities/effective-capability-projection.js";
import {
  type AccountSurfacePresentation,
  renderCapabilityHelp
} from "../../application/capabilities/capability-presenters.js";
import {
  classifyGroupEngagement,
  groupEngagementAllowsReply,
  groupEngagementIgnoredReason
} from "../../engagement.js";
import { getFunctionDefinition } from "../../capabilities/catalog.js";
import type { WebhookEventStore } from "../../idempotency/webhook-event-store.js";
import type { PostgresMediaSyncStore } from "../../media-sync/store.js";
import { prepareMediaSyncIntake } from "../../media-sync/intake.js";
import { logMediaSyncTiming } from "../../media-sync/timing.js";
import { applyMediaSyncLifecycle, mediaSyncLifecycleAction } from "../../media-sync/unsend.js";
import { createIntroReply, introVariantForText } from "../../intro.js";
import { verifyLineSignature } from "../../line-signature.js";
import {
  allowedProvidersForProfile,
  providerIsAllowedForProfile
} from "../../llm/provider-runtime.js";
import { messages, requestFailedMessage } from "../../messages.js";
import type { ProfileRuntime } from "../../runtime/profile-runtime.js";
import { handleAttachmentIntake, isUploadActivation } from "./attachment-intake.js";
import { sanitizeActionTelemetryEvent } from "../../observability/action-telemetry.js";
import { emitProductEvent } from "../../observability/product-events.js";
import { resolveRequesterDisplayName } from "../../requester-personalization.js";
import { createControlledSmallTalkReply } from "../../small-talk.js";
import { formatLastErrors, type LastErrorStore } from "../../observability/last-error-store.js";
import { formatLastRoutes, type LastRouteStore } from "../../observability/last-route-store.js";
import type { RateLimiter } from "../../rate-limit.js";
import type { SessionStore } from "../../state/session-store.js";
import type {
  AppConfig,
  AppDiagnostics,
  AdminHandlerRegistry,
  AdminActionRouterPort,
  BotProfileConfig,
  FunctionExecutionResult,
  LineAccountLinkEvent,
  LineIdentityClient,
  LineEvent,
  LineReplyOptions,
  ModelProviderName,
  LineReplyClient,
  LineWebhookPayload,
  PostbackHandlerRegistry,
  RouteObserver,
  RouteObserverEvent,
  TextGenerationProvider,
  TextMessageHandler,
  TextMessageHandlerRegistry
} from "../../types.js";
import { registerHealthRoutes } from "../http/health-routes.js";
import { registerMediaSyncRoutes } from "../../media-sync/http-routes.js";
import type { MediaSyncManagementService } from "../../media-sync/service.js";
import { runAdminCommand } from "./admin-commands.js";
import {
  handleAgentTextTurnWithLongJob,
  handlePostbackEvent,
  parsePostbackData,
  sourceKey
} from "./postbacks.js";
import { handlePublicAccessCommand, registrationPrompt } from "./public-access-commands.js";
import { memoryCommandCapabilityName, type MemoryCommandHandler } from "./memory-commands.js";
import { pendingAttachmentPrompt } from "./attachment-intake.js";

export interface AppDependencies {
  adminActionRegistry: AdminActionRegistry;
  adminActionRouter?: AdminActionRouterPort;
  postbackHandlers: PostbackHandlerRegistry;
  textMessageHandlers: TextMessageHandlerRegistry;
  attachmentTextHandlers: TextMessageHandler[];
  adminHandlers: AdminHandlerRegistry;
  createLineReplyClient: (profile: BotProfileConfig) => LineReplyClient;
  createLineIdentityClient: (profile: BotProfileConfig) => LineIdentityClient;
  routeObserver?: RouteObserver;
  requestIdFactory: () => string;
  lastErrorStore: LastErrorStore;
  lastRouteStore: LastRouteStore;
  rateLimiter: RateLimiter;
  accessStore: AccessStore;
  registrationInviteCodeStore: RegistrationInviteCodeStore;
  diagnostics: AppDiagnostics;
  confirmationStore?: ConfirmationStore;
  webhookEventStore: WebhookEventStore;
  textGenerator?: TextGenerationProvider;
  memoryCommands?: MemoryCommandHandler;
  resourceMemory?: ResourceMemoryObserver;
  profileRuntime: ProfileRuntime;
  agentTraceStore: AgentTraceStore;
  sessionStore?: SessionStore;
  agentJobStore: AgentJobStore;
  conversationWindowStore: ConversationWindowStore;
  textFallbackGenerator?: TextGenerationProvider;
  completionObserver: FunctionCompletionObserver;
  accountAdminClient: AccountAdminClient;
  mediaSyncStore?: PostgresMediaSyncStore;
  mediaSyncManagementService?: MediaSyncManagementService;
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
      { usage: "/access-list [user|group]", description: "列出已開通清單" },
      { usage: "/user-remove <userId>", description: "停用使用者" },
      { usage: "/group-remove [groupId]", description: "停用群組；在群組內可省略 groupId" },
      { usage: "/user-add <userId> [name]", description: "進階：開通指定使用者" },
      { usage: "/group-add <groupId> [name]", description: "進階：開通指定群組" }
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
    title: "系統",
    entries: [{ usage: "/llm-use <provider>", description: "show/change the active provider" }]
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

const retiredFunctionScopeCommands = new Set([
  "function-grant",
  "function-revoke",
  "function-scopes",
  "function-user-grant",
  "function-user-revoke",
  "function-user-scopes"
]);

export function createApp(config: AppConfig, deps: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes
  });
  const createReplyClient = deps.createLineReplyClient;
  const createIdentityClient = deps.createLineIdentityClient;
  const requestIdFactory = deps.requestIdFactory;
  const accessStore = deps.accessStore;
  const registrationInviteCodeStore = deps.registrationInviteCodeStore;
  const adminActionRegistry = deps.adminActionRegistry;
  const adminActionRouter = deps.adminActionRouter;
  const lastErrorStore = deps.lastErrorStore;
  const lastRouteStore = deps.lastRouteStore;
  const rateLimiter = deps.rateLimiter;
  const diagnostics = deps.diagnostics;
  const webhookEventStore = deps.webhookEventStore;
  const textGenerator = deps.textGenerator;
  const textFallbackGenerator = deps.textFallbackGenerator;
  const agentTraceStore = deps.agentTraceStore;
  const agentJobStore = deps.agentJobStore;
  const conversationWindowStore = deps.conversationWindowStore;
  const profileRuntime = deps.profileRuntime;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  registerHealthRoutes(app, config, diagnostics);
  if (deps.mediaSyncManagementService && config.mediaSync) {
    registerMediaSyncRoutes(app, {
      ...config.mediaSync,
      requestIdFactory,
      accountAdminClient: deps.accountAdminClient,
      service: deps.mediaSyncManagementService
    });
  }

  for (const profile of config.profiles) {
    app.post(profile.webhookPath, async (request, reply) => {
      await handleWebhook(
        request,
        reply,
        profile,
        config,
        adminActionRegistry,
        adminActionRouter,
        deps.postbackHandlers,
        deps.textMessageHandlers,
        deps.attachmentTextHandlers,
        deps.adminHandlers,
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
        profileRuntime,
        agentTraceStore,
        textGenerator,
        textFallbackGenerator,
        deps.memoryCommands,
        deps.resourceMemory,
        agentJobStore,
        conversationWindowStore,
        webhookEventStore,
        deps.sessionStore,
        deps.completionObserver,
        deps.accountAdminClient,
        deps.mediaSyncStore
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
  adminActionRegistry: AdminActionRegistry,
  adminActionRouter: AdminActionRouterPort | undefined,
  postbackHandlers: PostbackHandlerRegistry,
  textMessageHandlers: TextMessageHandlerRegistry,
  attachmentTextHandlers: TextMessageHandler[],
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
  profileRuntime: ProfileRuntime,
  agentTraceStore: AgentTraceStore,
  textGenerator: TextGenerationProvider | undefined,
  textFallbackGenerator: TextGenerationProvider | undefined,
  memoryCommands: MemoryCommandHandler | undefined,
  resourceMemory: ResourceMemoryObserver | undefined,
  agentJobStore: AgentJobStore,
  conversationWindowStore: ConversationWindowStore,
  webhookEventStore: WebhookEventStore,
  sessionStore: SessionStore | undefined,
  completionObserver: FunctionCompletionObserver,
  accountAdminClient: AccountAdminClient,
  mediaSyncStore: PostgresMediaSyncStore | undefined
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

  const ignoredCounts = new Map<string, number>();
  const handledLifecycleEvents = new Set<LineEvent>();
  for (const event of payload.events) {
    if (!isOrdinaryLineEvent(event)) continue;
    const action = mediaSyncLifecycleAction(profile, event);
    if (!action) continue;
    if (!mediaSyncStore) {
      return reply.code(503).send({ ok: false, error: "media_sync_lifecycle_unavailable" });
    }
    try {
      await applyMediaSyncLifecycle(action, mediaSyncStore);
    } catch {
      return reply.code(503).send({ ok: false, error: "media_sync_lifecycle_unavailable" });
    }
    handledLifecycleEvents.add(event);
    incrementIgnored(ignoredCounts, `media_sync_${action.type}`);
  }
  for (const event of payload.events) {
    if (!isAccountLinkEvent(event)) continue;
    const input = accountLinkFinalizeInput(event, payload.destination, profile.name);
    if (!input) {
      incrementIgnored(ignoredCounts, "invalid_account_link_event");
      continue;
    }
    const requestId = requestIdFactory();
    const startedAt = Date.now();
    let status: LineBindingTerminalStatus;
    try {
      status = (await accountAdminClient.finalizeBinding(input)).status;
    } catch (error) {
      const retryable = !(error instanceof AccountApiError) || error.retryable;
      if (retryable) {
        await emitRouteEvent(routeObserver, {
          kind: "route",
          profileName: profile.name,
          sourceType: event.source?.type ?? "unknown",
          requestId,
          provider: "keyword",
          outcome: "respond",
          action: "account_login",
          ok: false,
          retry: true,
          durationMs: elapsedMs(startedAt)
        });
        await emitProductEvent(routeObserver, {
          eventName: "account_link_finalized",
          requestId,
          profileName: profile.name,
          source: event.source ?? { type: "unknown" },
          hmacKey: config.observability?.hmacKey,
          action: "account_login",
          resultClass: "error",
          retry: true,
          durationMs: elapsedMs(startedAt)
        });
        return reply.code(503).send({ ok: false, error: "account_link_finalize_retry" });
      }
      status = "failed";
    }
    await emitRouteEvent(routeObserver, {
      kind: "route",
      profileName: profile.name,
      sourceType: event.source?.type ?? "unknown",
      requestId,
      provider: "keyword",
      outcome: "respond",
      action: "account_login",
      ok: status === "completed",
      retry: false,
      durationMs: elapsedMs(startedAt)
    });
    await emitProductEvent(routeObserver, {
      eventName: "account_link_finalized",
      requestId,
      profileName: profile.name,
      source: event.source ?? { type: "unknown" },
      hmacKey: config.observability?.hmacKey,
      action: "account_login",
      resultClass: status === "completed" ? "success" : "error",
      retry: false,
      durationMs: elapsedMs(startedAt)
    });
    if (input.result === "ok" && event.replyToken) {
      const line = createReplyClient(profile);
      await replyTextBestEffort(
        line,
        event.replyToken,
        status === "completed"
          ? "已完成 HHC 帳戶登入／綁定。"
          : "目前無法完成 HHC 帳戶登入／綁定，請重新操作。"
      );
    }
    incrementIgnored(ignoredCounts, `account_link_${status}`);
  }

  const ordinaryEvents = payload.events
    .filter(isOrdinaryLineEvent)
    .filter((event) => !handledLifecycleEvents.has(event));
  const handledAccountChallengeEvents = new Set<LineEvent>();
  for (const event of ordinaryEvents) {
    const text = event.message?.type === "text" ? event.message.text : undefined;
    if (!text || !looksLikeAccountLinkChallenge(text)) continue;
    handledAccountChallengeEvents.add(event);
    const requestId = requestIdFactory();
    const rateLimit = await rateLimiter.check({ profileName: profile.name, source: event.source });
    if (!rateLimit.allowed) {
      await emitRouteEvent(routeObserver, {
        kind: "rate_limited",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        action: "account_login",
        ok: false
      });
      incrementIgnored(ignoredCounts, "account_link_challenge_rate_limited");
      continue;
    }
    const nonce = parseAccountLinkChallenge(text);
    if (
      !nonce ||
      !profile.accountLink ||
      event.type !== "message" ||
      event.source.type !== "user" ||
      !boundedOpaque(event.source.userId, 255) ||
      !boundedOpaque(event.webhookEventId, 255) ||
      !boundedOpaque(payload.destination, 255) ||
      (event.replyToken !== undefined && !boundedOpaque(event.replyToken, 255))
    ) {
      incrementIgnored(ignoredCounts, "invalid_account_link_challenge");
      continue;
    }

    const startedAt = Date.now();
    let status: LineBindingTerminalStatus;
    try {
      status = (
        await accountAdminClient.finalizeBinding({
          nonce,
          result: "ok",
          actualLineUserId: event.source.userId,
          profileName: profile.name,
          channelId: payload.destination,
          webhookEventId: event.webhookEventId
        })
      ).status;
    } catch (error) {
      const retryable = !(error instanceof AccountApiError) || error.retryable;
      if (retryable) {
        await emitAccountLinkFinalizedEvent({
          routeObserver,
          config,
          profile,
          source: event.source,
          requestId,
          status: "failed",
          retry: true,
          durationMs: elapsedMs(startedAt)
        });
        return reply.code(503).send({ ok: false, error: "account_link_finalize_retry" });
      }
      status = "failed";
    }

    await emitAccountLinkFinalizedEvent({
      routeObserver,
      config,
      profile,
      source: event.source,
      requestId,
      status,
      retry: false,
      durationMs: elapsedMs(startedAt)
    });
    if (event.replyToken) {
      await replyTextBestEffort(
        createReplyClient(profile),
        event.replyToken,
        status === "completed"
          ? "已完成 HHC 帳戶登入／連結。"
          : "目前無法完成 HHC 帳戶登入／連結，請重新操作。"
      );
    }
    incrementIgnored(ignoredCounts, `account_link_${status}`);
  }

  const allowedEvents: LineEvent[] = [];
  const mediaSyncOnlyEvents: Array<{ event: LineEvent; manual: boolean }> = [];

  for (const event of ordinaryEvents) {
    if (handledAccountChallengeEvents.has(event)) continue;
    if (
      mediaSyncStore &&
      event.source.type === "group" &&
      event.source.groupId &&
      (await isGroupAllowed(profile, event.source.groupId, accessStore))
    ) {
      try {
        const intake = await prepareMediaSyncIntake({
          profile,
          event,
          store: mediaSyncStore,
          sessionStore,
          now: new Date(),
          onTiming: logMediaSyncTiming
        });
        if (
          intake.eligible &&
          (!intake.workId || event.message?.type === "video" || event.message?.type === "audio")
        ) {
          if (
            event.webhookEventId &&
            (await webhookEventStore.tryStart(
              profile.name,
              event.webhookEventId,
              7 * 24 * 60 * 60 * 1000
            )) === "duplicate"
          ) {
            incrementIgnored(ignoredCounts, "duplicate_webhook_event");
            continue;
          }
          mediaSyncOnlyEvents.push({ event, manual: Boolean(intake.manual) });
          continue;
        }
      } catch {
        return reply.code(503).send({ ok: false, error: "media_sync_intake_unavailable" });
      }
    }
    const allow = structurallyAllowEvent(profile, event);
    if (!allow.allowed) {
      incrementIgnored(ignoredCounts, allow.reason);
      continue;
    }
    allowedEvents.push(event);
  }

  if (allowedEvents.length === 0 && mediaSyncOnlyEvents.length === 0) {
    return reply.send({
      ok: true,
      ignored: true,
      reason: formatIgnoredSummary(ignoredCounts)
    });
  }

  const line = createReplyClient(profile);
  for (const { event, manual } of mediaSyncOnlyEvents) {
    if (manual && event.replyToken && event.message) {
      const prompt = pendingAttachmentPrompt(event.message);
      await line.replyText(event.replyToken, prompt.replyText, {
        quickReplies: prompt.quickReplies
      });
    }
  }
  let lineIdentity: LineIdentityClient | undefined;
  const getLineIdentity = (): LineIdentityClient =>
    (lineIdentity ??= createIdentityClient(profile));
  let admittedEvents = mediaSyncOnlyEvents.length;
  let rejectedAfterStructuralGate = false;
  for (const event of allowedEvents) {
    if (
      event.webhookEventId &&
      (await webhookEventStore.tryStart(
        profile.name,
        event.webhookEventId,
        7 * 24 * 60 * 60 * 1000
      )) === "duplicate"
    ) {
      ignoredCounts.set(
        "duplicate_webhook_event",
        (ignoredCounts.get("duplicate_webhook_event") ?? 0) + 1
      );
      continue;
    }
    const requestId = requestIdFactory();
    const rateLimit = await rateLimiter.check({ profileName: profile.name, source: event.source });
    if (!rateLimit.allowed) {
      if (event.replyToken) {
        await line.replyText(event.replyToken, "你傳得太快了，請稍後再試。", undefined);
      }
      await emitRouteEvent(routeObserver, {
        kind: "rate_limited",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        ok: false
      });
      continue;
    }
    const turnAccountAuthorization = createTurnFunctionAuthorizer(
      accountAdminClient,
      profile,
      event.source.userId
    );
    const localAction =
      event.type === "message" && event.message?.type === "text"
        ? matchNaturalLanguageSystemActionHint(event.message.text ?? "")
        : undefined;
    if (
      localAction === "show_help" ||
      localAction === "show_account" ||
      localAction === "account_login"
    ) {
      const policy = await evaluateActionPolicy({
        action: localAction,
        profile,
        source: event.source
      });
      if (!policy.allowed || !event.replyToken) {
        incrementIgnored(ignoredCounts, policy.allowed ? "missing_reply_token" : policy.reason);
        continue;
      }
      const requestedFunctions =
        localAction === "account_login"
          ? []
          : profile.permissionRequiredFunctions.filter((name) =>
              profile.enabledFunctions.includes(name)
            );
      const shouldAuthorizeAccount = Boolean(
        event.source.userId &&
        ((localAction === "show_help" && profileUsesProviders(profile)) ||
          (profile.accountLink && (event.source.type === "user" || requestedFunctions.length > 0)))
      );
      const accountState = shouldAuthorizeAccount
        ? await turnAccountAuthorization.state(requestedFunctions)
        : {
            available: Boolean(profile.accountLink),
            authorization: emptyFunctionAuthorization()
          };
      const requesterIsAdmin = accountState.authorization.administrator;
      const resolveCurrentAccess = async () =>
        applyAccountFunctionAuthorization(
          await resolveEffectiveAccessContext({ profile, event, accessStore, requesterIsAdmin }),
          profile,
          accountState
        );
      let bindingAttempted = false;
      let bindingStarted = false;
      const startedAt = Date.now();
      const result = await handlePublicAccessCommand({
        text: event.message?.text ?? "",
        profile,
        event,
        accessStore,
        registrationInviteCodeStore,
        lineIdentity: undefined,
        adminHandlers,
        productContext: {
          routeObserver,
          requestId,
          hmacKey: config.observability?.hmacKey
        },
        requesterIsAdmin,
        account:
          event.source.type === "user"
            ? accountSurfacePresentation(profile, accountState)
            : undefined,
        accountAllowedFunctions: accountState.authorization.allowedFunctions,
        startAccountLogin: async () => {
          bindingAttempted = true;
          if (
            !profile.accountLink ||
            !boundedOpaque(event.source.userId, 255) ||
            !boundedOpaque(payload.destination, 255)
          ) {
            throw new Error("invalid_account_login");
          }
          const binding = await accountAdminClient.createBinding({
            expectedLineUserId: event.source.userId,
            profileName: profile.name,
            channelId: payload.destination,
            presentation: profile.accountLink
          });
          bindingStarted = true;
          return binding;
        },
        policies: {
          parseCommand: parseAdminCommand,
          adminAllowed,
          formatAdminHelp: formatAdminCommandHelpByMode,
          directAccessPolicy,
          groupAccessPolicy,
          isDirectUserAllowed,
          isGroupAllowed
        },
        resolveCurrentAccess
      });
      if (!result) {
        incrementIgnored(ignoredCounts, "unsupported_public_surface");
        continue;
      }
      admittedEvents += 1;
      await replyTextBestEffort(
        line,
        event.replyToken,
        result.replyText,
        result.quickReplies ? { quickReplies: result.quickReplies } : undefined
      );
      await emitRouteEvent(routeObserver, {
        kind: "route",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        provider: "keyword",
        outcome: "respond",
        action: localAction,
        ok: result.ok,
        durationMs: elapsedMs(startedAt)
      });
      if (localAction === "account_login" && bindingAttempted) {
        await emitProductEvent(routeObserver, {
          eventName: "account_link_started",
          requestId,
          profileName: profile.name,
          source: event.source,
          hmacKey: config.observability?.hmacKey,
          action: "account_login",
          resultClass: bindingStarted ? "success" : "error",
          retry: false,
          durationMs: elapsedMs(startedAt)
        });
      }
      continue;
    }
    const eventText = event.type === "message" ? event.message?.text : undefined;
    const introVariant = eventText ? introVariantForText(eventText) : undefined;
    const parsedAdminCommand = parseAdminCommand(eventText);
    const functionOwnedCommand = isConfiguredExactFunctionCommand(
      profile,
      eventText,
      event.source.type
    );
    const needsAdminAuthorization = Boolean(
      (!functionOwnedCommand &&
        parsedAdminCommand &&
        requiresAdminAuthorization(parsedAdminCommand, adminHandlers)) ||
      (eventText && matchesNaturalLanguageAdminActionHint(eventText))
    );
    const needsAttachmentAuthorization =
      event.type === "message" &&
      event.message?.type !== "text" &&
      profile.enabledFunctions.includes("save_resource");
    const attachmentAuthorization = needsAttachmentAuthorization
      ? profile.permissionRequiredFunctions.filter((name) => name === "save_resource")
      : [];
    const introAuthorization =
      introVariant === "capabilities"
        ? profile.permissionRequiredFunctions.filter((name) =>
            profile.enabledFunctions.includes(name)
          )
        : [];
    const registrationAuthorization =
      parsedAdminCommand?.command === "registry"
        ? profile.permissionRequiredFunctions.filter((name) =>
            profile.enabledFunctions.includes(name)
          )
        : [];
    const needsIntroAuthorization = Boolean(
      event.source.userId &&
      introVariant === "capabilities" &&
      (profile.accountLink || introAuthorization.length > 0)
    );
    const needsRegistrationAuthorization = Boolean(
      event.source.userId && profile.accountLink && parsedAdminCommand?.command === "registry"
    );
    const needsManagedDirectAuthorization = Boolean(
      event.source.type === "user" &&
      event.source.userId &&
      profile.accountLink &&
      directAccessPolicy(profile) === "managed"
    );
    const managedDirectAuthorization = needsManagedDirectAuthorization
      ? profile.permissionRequiredFunctions.filter((name) =>
          profile.enabledFunctions.includes(name)
        )
      : [];
    let accountAuthorizationUsed =
      needsAdminAuthorization ||
      needsAttachmentAuthorization ||
      needsIntroAuthorization ||
      needsRegistrationAuthorization ||
      needsManagedDirectAuthorization;
    let accountState = accountAuthorizationUsed
      ? await turnAccountAuthorization.state(
          needsManagedDirectAuthorization
            ? managedDirectAuthorization
            : needsAttachmentAuthorization
              ? attachmentAuthorization
              : needsIntroAuthorization
                ? introAuthorization
                : registrationAuthorization
        )
      : { available: true, authorization: emptyFunctionAuthorization() };
    let accountAuthorization = adminAuthorizationFromFunctionState(accountState);
    let allow = await allowEvent(
      profile,
      event,
      textMessageHandlers,
      accessStore,
      conversationWindowStore,
      accountAuthorization.allowed,
      sessionStore
    );
    if (
      !allow.allowed &&
      !needsAdminAuthorization &&
      event.source.type === "user" &&
      directAccessPolicy(profile) === "managed" &&
      event.source.userId
    ) {
      accountAuthorizationUsed = true;
      accountState = await turnAccountAuthorization.state([]);
      accountAuthorization = adminAuthorizationFromFunctionState(accountState);
      if (accountAuthorization.allowed) {
        allow = await allowEvent(
          profile,
          event,
          textMessageHandlers,
          accessStore,
          conversationWindowStore,
          true,
          sessionStore
        );
      }
    }
    if (!allow.allowed) {
      incrementIgnored(ignoredCounts, allow.reason);
      rejectedAfterStructuralGate = true;
      continue;
    }
    admittedEvents += 1;
    const requesterIsAdmin = accountAuthorization.allowed;
    const baseEffectiveAccess = await resolveEffectiveAccessContext({
      profile,
      event,
      accessStore,
      requesterIsAdmin
    });
    const effectiveAccess = accountAuthorizationUsed
      ? applyAccountFunctionAuthorization(baseEffectiveAccess, profile, accountState)
      : baseEffectiveAccess;
    const effectiveProfile = effectiveAccess.profile;
    const capabilityProjection = projectEffectiveCapabilities({ context: effectiveAccess });
    const requesterDisplayName = await resolveRequesterDisplayName(getLineIdentity(), event);

    if (event.type === "postback") {
      if (!event.replyToken) {
        continue;
      }
      const startedAt = Date.now();
      const {
        result,
        completionEligible,
        capability,
        profile: authorizedPostbackProfile
      } = await handlePostbackEvent(
        event,
        effectiveProfile,
        postbackHandlers,
        requestId,
        requesterDisplayName,
        agentJobStore,
        profile.enabledFunctions,
        turnAccountAuthorization.allowedFunctions,
        profileRuntime.handleActionReview
          ? async (review) => {
              const reviewOutcome = await profileRuntime.handleActionReview!({
                profile: review.profile,
                event: review.event,
                requestId: review.requestId,
                requesterDisplayName: review.requesterDisplayName,
                requesterIsAdmin,
                configuredFunctions: [...profile.enabledFunctions],
                authorizeFunctions: async (names) => [
                  ...(await turnAccountAuthorization.allowedFunctions(names))
                ],
                accountAdministrator: turnAccountAuthorization.administrator,
                reviewId: review.reviewId,
                resultJobId: review.resultJobId,
                text: review.text
              });
              if (!reviewOutcome) return { ok: true, replyText: messages.postbackUnsupported };
              const reviewResult = reviewOutcome.result;
              if (
                reviewOutcome.freshExecution &&
                reviewResult.writePhase === "commit" &&
                reviewResult.executedAction
              ) {
                return completionObserver.complete({
                  context: {
                    profile: review.profile,
                    event: review.event,
                    requestId: review.requestId,
                    requesterDisplayName: review.requesterDisplayName,
                    requesterIsAdmin
                  },
                  action: reviewResult.executedAction,
                  result: reviewResult,
                  durationMs: elapsedMs(startedAt),
                  clarificationCount: 0
                });
              }
              return reviewResult;
            }
          : undefined
      );
      const postbackProfile = authorizedPostbackProfile ?? effectiveProfile;
      const postbackCapabilityName = completionEligible ? capability : undefined;
      if (postbackCapabilityName) {
        await resourceMemory?.afterFunctionResult({
          context: { profile: postbackProfile, event, requestId, requesterDisplayName },
          action: postbackCapabilityName,
          arguments: {},
          result
        });
      }
      const durationMs = elapsedMs(startedAt);
      const completedResult = postbackCapabilityName
        ? await completionObserver.complete({
            context: {
              profile: postbackProfile,
              event,
              requestId,
              requesterDisplayName,
              requesterIsAdmin
            },
            action: postbackCapabilityName,
            result,
            durationMs,
            clarificationCount: 0
          })
        : result;
      await emitRouteEvent(routeObserver, {
        kind: "postback",
        profileName: profile.name,
        sourceType: event.source.type,
        requestId,
        action: parsePostbackData(event.postback?.data ?? "")?.action,
        ok: completedResult.ok,
        durationMs
      });
      await line.replyText(
        event.replyToken,
        completedResult.replyText,
        completedResult.quickReplies ? { quickReplies: completedResult.quickReplies } : undefined
      );
      continue;
    }

    if (event.type === "message" && event.message?.type !== "text") {
      if (!event.replyToken) {
        continue;
      }
      const attachmentResult = await handleAttachmentIntake({
        profile: effectiveProfile,
        event,
        requestId,
        requesterDisplayName,
        sessionStore,
        maxAttachmentBytes: config.attachments?.maxBytes ?? 25 * 1024 * 1024,
        now: new Date(),
        textHandlers: attachmentTextHandlers
      });
      if (attachmentResult) {
        await line.replyText(
          event.replyToken,
          attachmentResult.replyText,
          attachmentResult.quickReplies
            ? { quickReplies: attachmentResult.quickReplies }
            : undefined
        );
      }
      continue;
    }

    if (event.type !== "message" || event.message?.type !== "text" || !event.message.text) {
      continue;
    }

    if (!event.replyToken) {
      continue;
    }

    if (isAdminCommand(event.message.text) && !functionOwnedCommand) {
      const parsedAdminCommand = parseAdminCommand(event.message.text);
      if (
        !profileUsesProviders(effectiveProfile) &&
        !(parsedAdminCommand?.command === "help" && parsedAdminCommand.args.length === 0)
      ) {
        const localHelp = renderCapabilityHelp(
          capabilityProjection,
          "help",
          effectiveProfile,
          undefined,
          { sourceType: effectiveAccess.sourceType, authorized: effectiveAccess.authorized }
        );
        await line.replyText(
          event.replyToken,
          localHelp.replyText,
          localHelp.quickReplies ? { quickReplies: localHelp.quickReplies } : undefined
        );
        continue;
      }
      if (
        parsedAdminCommand &&
        requiresAdminAuthorization(parsedAdminCommand, adminHandlers) &&
        !requesterIsAdmin
      ) {
        await line.replyText(
          event.replyToken,
          await adminAuthorizationReply({
            event,
            authorization: accountAuthorization
          }),
          undefined
        );
        continue;
      }
      const memoryCommandFunction = memoryCommandCapabilityName(event.message.text);
      let agentCommandProfile = effectiveProfile;
      let agentCommandIsAdmin = requesterIsAdmin;
      if (memoryCommandFunction) {
        const definition = getFunctionDefinition(memoryCommandFunction);
        const sourceType = event.source.type;
        if (
          !profile.enabledFunctions.includes(memoryCommandFunction) ||
          (sourceType !== "user" && sourceType !== "group") ||
          !definition?.allowedSources.includes(sourceType)
        ) {
          await line.replyText(event.replyToken, messages.permissionDenied, undefined);
          continue;
        }
        const allowed = await turnAccountAuthorization.allowedFunctions([memoryCommandFunction]);
        if (!allowed.includes(memoryCommandFunction)) {
          await line.replyText(event.replyToken, messages.permissionDenied, undefined);
          continue;
        }
        if (!agentCommandProfile.enabledFunctions.includes(memoryCommandFunction)) {
          agentCommandProfile = {
            ...agentCommandProfile,
            enabledFunctions: [...agentCommandProfile.enabledFunctions, memoryCommandFunction]
          };
        }
        const commandPolicy = await evaluateActionPolicy({
          action: memoryCommandFunction,
          profile,
          source: event.source,
          requesterIsAdmin: turnAccountAuthorization.administrator() || requesterIsAdmin,
          effectiveFunctions: agentCommandProfile.enabledFunctions
        });
        if (!commandPolicy.allowed) {
          await line.replyText(event.replyToken, messages.permissionDenied, undefined);
          continue;
        }
        agentCommandIsAdmin = turnAccountAuthorization.administrator() || requesterIsAdmin;
      }
      const agentCommandResult = await memoryCommands?.handleCommand({
        text: event.message.text,
        context: { profile: agentCommandProfile, event, requestId, requesterDisplayName },
        isAdmin: memoryCommandFunction
          ? agentCommandIsAdmin
          : await adminAllowed(
              effectiveProfile,
              event,
              requesterIsAdmin,
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
      const accessCommandResult = await handlePublicAccessCommand({
        text: event.message.text,
        profile: effectiveProfile,
        event,
        accessStore,
        registrationInviteCodeStore,
        lineIdentity: getLineIdentity(),
        adminHandlers,
        productContext: {
          routeObserver,
          requestId,
          hmacKey: config.observability?.hmacKey
        },
        requesterIsAdmin,
        policies: {
          parseCommand: parseAdminCommand,
          adminAllowed,
          formatAdminHelp: formatAdminCommandHelpByMode,
          directAccessPolicy,
          groupAccessPolicy,
          isDirectUserAllowed,
          isGroupAllowed
        },
        resolveCurrentAccess: async () => {
          const context = await resolveEffectiveAccessContext({
            profile,
            event,
            accessStore,
            requesterIsAdmin
          });
          return accountAuthorizationUsed
            ? applyAccountFunctionAuthorization(context, profile, accountState)
            : context;
        },
        mediaSyncStore
      });
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
      const adminResult = await runAdminCommand({
        context: { profile: effectiveProfile, event, requestId },
        command: parsedAdminCommand?.command ?? "unknown",
        lastErrorStore,
        routeObserver,
        isAuthorized: () =>
          adminAllowed(profile, event, requesterIsAdmin, parsedAdminCommand?.command),
        elapsedMs: () => elapsedMs(adminStartedAt),
        handler: () =>
          handleAdminCommand(
            event.message!.text!,
            effectiveProfile,
            profile,
            event,
            config,
            adminHandlers,
            lastErrorStore,
            lastRouteStore,
            accessStore,
            adminActionRegistry,
            diagnostics,
            agentTraceStore,
            requestId,
            requesterIsAdmin
          )
      });
      await line.replyText(
        event.replyToken,
        adminResult.replyText,
        adminResult.quickReplies ? { quickReplies: adminResult.quickReplies } : undefined
      );
      continue;
    }

    if (!requesterIsAdmin && matchesNaturalLanguageAdminActionHint(event.message.text)) {
      if (!profileUsesProviders(effectiveProfile)) {
        const localHelp = renderCapabilityHelp(
          capabilityProjection,
          "help",
          effectiveProfile,
          undefined,
          { sourceType: effectiveAccess.sourceType, authorized: effectiveAccess.authorized }
        );
        await line.replyText(
          event.replyToken,
          localHelp.replyText,
          localHelp.quickReplies ? { quickReplies: localHelp.quickReplies } : undefined
        );
        continue;
      }
      await line.replyText(
        event.replyToken,
        await adminAuthorizationReply({
          event,
          authorization: accountAuthorization
        }),
        undefined
      );
      continue;
    }

    if (requesterIsAdmin && matchesNaturalLanguageAdminActionHint(event.message.text)) {
      if (
        event.source.type !== "user" &&
        !matchesGroupScopedNaturalLanguageAdminActionHint(event.message.text)
      ) {
        await line.replyText(event.replyToken, "管理操作請到個人對話使用。", undefined);
        continue;
      }
      if (!adminActionRouter) {
        await line.replyText(event.replyToken, "目前無法辨識這個管理操作。", undefined);
        continue;
      }
      const adminRouteStartedAt = Date.now();
      const route = await adminActionRouter.route({
        profileName: effectiveProfile.name,
        text: event.message.text,
        enabledActions: enabledNaturalLanguageAdminActionNames(),
        source: event.source
      });
      const adminRouteDurationMs = elapsedMs(adminRouteStartedAt);
      await emitRouteEvent(routeObserver, {
        kind: "admin_action_route",
        profileName: effectiveProfile.name,
        sourceType: event.source.type,
        requestId,
        provider: route.provider,
        lane: route.lane,
        outcome: route.type,
        action: route.type === "execute" ? route.action : undefined,
        reason: route.type === "deny" ? route.reason : undefined,
        durationMs: adminRouteDurationMs
      });
      await lastRouteStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: effectiveProfile.name,
        sourceType: event.source.type,
        phase: "admin_route",
        provider: route.provider,
        outcome: route.type,
        action: route.type === "execute" ? route.action : undefined,
        reason: route.type === "deny" ? route.reason : undefined,
        durationMs: adminRouteDurationMs
      });
      if (route.type !== "execute") {
        await line.replyText(event.replyToken, "目前無法辨識這個管理操作。", undefined);
        continue;
      }
      const adminResult = await adminActionRegistry.execute({
        action: route.action,
        profile: effectiveProfile,
        event,
        arguments: route.arguments,
        requesterIsAdmin: true
      });
      await emitRouteEvent(routeObserver, {
        kind: "admin_action_result",
        profileName: effectiveProfile.name,
        sourceType: event.source.type,
        requestId,
        action: route.action,
        ok: adminResult.ok
      });
      await lastRouteStore.record({
        requestId,
        occurredAt: new Date().toISOString(),
        profileName: effectiveProfile.name,
        sourceType: event.source.type,
        phase: "admin_action",
        action: route.action,
        ok: adminResult.ok
      });
      await line.replyText(
        event.replyToken,
        adminResult.replyText,
        adminResult.quickReplies ? { quickReplies: adminResult.quickReplies } : undefined
      );
      continue;
    }

    if (await shouldPromptManagedRegistration(profile, event, accessStore, requesterIsAdmin)) {
      await line.replyText(event.replyToken, registrationPrompt(profile, event), undefined);
      continue;
    }

    const pendingActionReview =
      sessionStore && event.source.userId
        ? await sessionStore.findActionReview({
            profileName: profile.name,
            source: event.source,
            requesterUserId: event.source.userId
          })
        : undefined;
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
      const intro = createIntroReply(capabilityProjection, event.message.text, {
        force: true,
        profile: effectiveProfile,
        account:
          event.source.type === "user" && accountAuthorizationUsed
            ? accountSurfacePresentation(profile, accountState)
            : undefined
      });
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
    if (
      profile.name !== "helper" &&
      groupEngagement?.kind === "small_talk" &&
      groupEngagement.smallTalkCategory
    ) {
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

    const intro = createIntroReply(capabilityProjection, event.message.text, {
      profile: effectiveProfile,
      account:
        event.source.type === "user" && accountAuthorizationUsed
          ? accountSurfacePresentation(profile, accountState)
          : undefined
    });
    if (intro) {
      await line.replyText(
        event.replyToken,
        intro.replyText,
        intro.quickReplies ? { quickReplies: intro.quickReplies } : undefined
      );
      await recordConversationReply(conversationWindowStore, effectiveProfile, event, intro);
      continue;
    }

    const profileTurnInput = {
      profile: effectiveProfile,
      event,
      requestId,
      requesterDisplayName,
      requesterIsAdmin,
      configuredFunctions: [...profile.enabledFunctions],
      authorizeFunctions: async (names: CapabilityName[]) => [
        ...(await turnAccountAuthorization.allowedFunctions(names))
      ],
      accountAdministrator: turnAccountAuthorization.administrator
    };
    const researchOutcome = await profileRuntime.acceptSheetMusicResearch?.(profileTurnInput);
    if (researchOutcome?.kind === "handled") {
      await line.replyText(
        event.replyToken,
        researchOutcome.result.replyText,
        researchOutcome.result.quickReplies
          ? { quickReplies: researchOutcome.result.quickReplies }
          : undefined
      );
      await recordConversationReply(
        conversationWindowStore,
        effectiveProfile,
        event,
        researchOutcome.result
      );
      continue;
    }
    const researchAccepted = researchOutcome?.kind === "accepted";
    if (!researchAccepted) {
      const attachmentResult = await executeAttachmentTextIntake({
        intake: {
          profile: effectiveProfile,
          event,
          requestId,
          requesterDisplayName,
          requesterIsAdmin,
          configuredFunctions: profile.enabledFunctions,
          authorizeFunctions: turnAccountAuthorization.allowedFunctions,
          sessionStore,
          maxAttachmentBytes: config.attachments?.maxBytes ?? 25 * 1024 * 1024,
          now: new Date(),
          textHandlers: attachmentTextHandlers
        },
        completion: {
          profile: effectiveProfile,
          event,
          requestId,
          requesterDisplayName,
          requesterIsAdmin,
          completionObserver,
          accessStore,
          resourceMemory,
          routeObserver,
          lastRouteStore
        },
        lastErrorStore
      });
      if (attachmentResult) {
        await line.replyText(
          event.replyToken,
          attachmentResult.replyText,
          attachmentResult.quickReplies
            ? { quickReplies: attachmentResult.quickReplies }
            : undefined
        );
        await recordConversationReply(
          conversationWindowStore,
          effectiveProfile,
          event,
          attachmentResult
        );
        continue;
      }
    }

    const continuation = researchAccepted
      ? { matched: false as const }
      : await executeDeterministicTextContinuation({
          event,
          profile: effectiveProfile,
          configuredFunctions: profile.enabledFunctions,
          handlers: textMessageHandlers,
          requesterDisplayName,
          requesterIsAdmin,
          authorizeFunctions: turnAccountAuthorization.allowedFunctions,
          sessionStore,
          resourceMemory,
          completionObserver,
          accessStore,
          routeObserver,
          lastErrorStore,
          lastRouteStore,
          requestId
        });
    if (continuation.matched) {
      if (continuation.result) {
        await line.replyText(
          event.replyToken,
          continuation.result.replyText,
          continuation.result.quickReplies
            ? { quickReplies: continuation.result.quickReplies }
            : undefined
        );
        await recordConversationReply(
          conversationWindowStore,
          effectiveProfile,
          event,
          continuation.result
        );
      }
      continue;
    }

    const routingAllowed =
      Boolean(researchAccepted) ||
      Boolean(pendingActionReview) ||
      !groupEngagement ||
      groupEngagementAllowsReply(groupEngagement) ||
      conversationWindowActive;

    const agentTurnResult = routingAllowed
      ? await handleAgentTextTurnWithLongJob({
          runtime: profileRuntime,
          jobStore: agentJobStore,
          ...profileTurnInput,
          completeResult: (result) =>
            result.executedAction &&
            result.writePhase !== "preview" &&
            !profileRuntime.observesCompletion
              ? completionObserver.complete({
                  context: {
                    profile: effectiveProfile,
                    event,
                    requestId,
                    requesterDisplayName,
                    requesterIsAdmin
                  },
                  action: result.executedAction,
                  result,
                  durationMs: 0,
                  clarificationCount: 0
                })
              : Promise.resolve(result)
        })
      : undefined;
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

  if (admittedEvents === 0 && rejectedAfterStructuralGate && ignoredCounts.size > 0) {
    return reply.send({
      ok: true,
      ignored: true,
      reason: formatIgnoredSummary(ignoredCounts)
    });
  }
  return reply.send({
    ok: true,
    allowedEvents: admittedEvents,
    ignored: ignoredCounts.size > 0 ? formatIgnoredSummary(ignoredCounts) : undefined
  });
}

async function executeDeterministicTextContinuation(input: {
  event: LineEvent;
  profile: BotProfileConfig;
  configuredFunctions: readonly CapabilityName[];
  handlers: TextMessageHandlerRegistry;
  requesterDisplayName?: string;
  requesterIsAdmin: boolean;
  authorizeFunctions(names: readonly CapabilityName[]): Promise<readonly CapabilityName[]>;
  sessionStore?: SessionStore;
  resourceMemory?: ResourceMemoryObserver;
  completionObserver: FunctionCompletionObserver;
  accessStore: AccessStore;
  routeObserver?: RouteObserver;
  lastErrorStore: LastErrorStore;
  lastRouteStore: LastRouteStore;
  requestId: string;
}): Promise<{ matched: boolean; result?: FunctionExecutionResult }> {
  const matched = await matchTextContinuation(
    input.event,
    input.profile,
    input.handlers,
    input.requesterDisplayName,
    input.requesterIsAdmin,
    input.authorizeFunctions,
    input.configuredFunctions
  );
  if (!matched) return { matched: false };
  const startedAt = Date.now();
  const context = {
    profile: matched.profile,
    event: input.event,
    requestId: input.requestId,
    requesterDisplayName: input.requesterDisplayName,
    requesterIsAdmin: input.requesterIsAdmin
  };
  try {
    if ("matchError" in matched) throw matched.matchError;
    const result = await matched.handler.handle({ text: input.event.message?.text ?? "" }, context);
    if (!result) return { matched: true };
    const action = result.executedAction ?? matched.handler.capability;
    const durationMs = elapsedMs(startedAt);
    await emitRouteEvent(input.routeObserver, {
      kind: "text_handler",
      profileName: input.profile.name,
      sourceType: input.event.source.type,
      requestId: input.requestId,
      handler: matched.name,
      action,
      ok: result.ok,
      durationMs
    });
    if (result.executedAction) {
      await recordDeterministicFunctionWriteAudit(
        input.accessStore,
        context,
        result.executedAction,
        result
      );
    }
    if (action && result.agentResource) {
      await input.resourceMemory?.afterFunctionResult({
        context,
        action,
        arguments: {},
        result
      });
    }
    const completed = result.executedAction
      ? await input.completionObserver.complete({
          context,
          action: result.executedAction,
          result,
          durationMs,
          clarificationCount: 0
        })
      : result;
    await input.lastRouteStore.record({
      requestId: input.requestId,
      occurredAt: new Date().toISOString(),
      profileName: input.profile.name,
      sourceType: input.event.source.type,
      phase: "function",
      action,
      ok: result.ok,
      durationMs
    });
    return { matched: true, result: completed };
  } catch (error) {
    await input.lastErrorStore.record({
      requestId: input.requestId,
      occurredAt: new Date().toISOString(),
      profileName: input.profile.name,
      sourceType: input.event.source.type,
      phase: "function",
      action: matched.handler.capability,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      matched: true,
      result: { ok: false, replyText: requestFailedMessage(input.requestId) }
    };
  }
}

export async function matchTextContinuation(
  event: LineEvent,
  profile: BotProfileConfig,
  handlers: TextMessageHandlerRegistry,
  requesterDisplayName: string | undefined,
  requesterIsAdmin: boolean,
  authorizeFunctions: (names: readonly CapabilityName[]) => Promise<readonly CapabilityName[]>,
  configuredFunctions: readonly CapabilityName[]
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) return undefined;
  for (const [name, handler] of Object.entries(handlers)) {
    const capability = handler.capability;
    const protectedCapability =
      capability &&
      configuredFunctions.includes(capability) &&
      (profile.permissionRequiredFunctions.includes(capability) ||
        !profile.enabledFunctions.includes(capability))
        ? capability
        : undefined;
    const matchProfile =
      protectedCapability && !profile.enabledFunctions.includes(protectedCapability)
        ? { ...profile, enabledFunctions: [...profile.enabledFunctions, protectedCapability] }
        : profile;
    let matches: boolean;
    try {
      matches = await handler.matches(
        { text },
        { profile: matchProfile, event, requesterDisplayName, requesterIsAdmin }
      );
    } catch (matchError) {
      return { name, handler, profile: matchProfile, matchError };
    }
    if (!matches) {
      continue;
    }
    if (protectedCapability) {
      try {
        if (!(await authorizeFunctions([protectedCapability])).includes(protectedCapability)) {
          continue;
        }
      } catch {
        continue;
      }
    }
    return { name, handler, profile: matchProfile };
  }
  return undefined;
}

async function executeAttachmentTextIntake(input: {
  intake: Parameters<typeof handleAttachmentIntake>[0];
  completion: Omit<Parameters<typeof completeAttachmentIntake>[0], "result">;
  lastErrorStore: LastErrorStore;
}): Promise<FunctionExecutionResult | undefined> {
  try {
    const result = await handleAttachmentIntake(input.intake);
    if (!result) return undefined;
    return await completeAttachmentIntake({ ...input.completion, result });
  } catch (error) {
    try {
      await input.lastErrorStore.record({
        requestId: input.intake.requestId,
        occurredAt: new Date().toISOString(),
        profileName: input.intake.profile.name,
        sourceType: input.intake.event.source.type,
        phase: "function",
        action: "save_resource",
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Error telemetry must never replace the bounded support response.
    }
    return { ok: false, replyText: requestFailedMessage(input.intake.requestId) };
  }
}

async function completeAttachmentIntake(input: {
  result: FunctionExecutionResult;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin: boolean;
  completionObserver: FunctionCompletionObserver;
  accessStore: AccessStore;
  resourceMemory?: ResourceMemoryObserver;
  routeObserver?: RouteObserver;
  lastRouteStore: LastRouteStore;
}): Promise<FunctionExecutionResult> {
  const startedAt = Date.now();
  const context = {
    profile: input.profile,
    event: input.event,
    requestId: input.requestId,
    requesterDisplayName: input.requesterDisplayName,
    requesterIsAdmin: input.requesterIsAdmin
  };
  const action = input.result.executedAction ?? "save_resource";
  if (input.result.executedAction) {
    await recordDeterministicFunctionWriteAudit(
      input.accessStore,
      context,
      input.result.executedAction,
      input.result
    );
  }
  if (input.result.agentResource) {
    await input.resourceMemory?.afterFunctionResult({
      context,
      action,
      arguments: {},
      result: input.result
    });
  }
  const durationMs = elapsedMs(startedAt);
  const completed = input.result.executedAction
    ? await input.completionObserver.complete({
        context,
        action: input.result.executedAction,
        result: input.result,
        durationMs,
        clarificationCount: 0
      })
    : input.result;
  await emitRouteEvent(input.routeObserver, {
    kind: "text_handler",
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    requestId: input.requestId,
    handler: "attachment_intake",
    action,
    ok: input.result.ok,
    durationMs
  });
  await input.lastRouteStore.record({
    requestId: input.requestId,
    occurredAt: new Date().toISOString(),
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    phase: "function",
    action,
    ok: input.result.ok,
    durationMs
  });
  return completed;
}

async function recordDeterministicFunctionWriteAudit(
  accessStore: AccessStore,
  context: {
    profile: BotProfileConfig;
    event: LineEvent;
  },
  action: CapabilityName,
  result: FunctionExecutionResult
): Promise<void> {
  const definition = getFunctionDefinition(action);
  const actorUserId = context.event.source.userId;
  if (!actorUserId || !result.ok || !definition || definition.sideEffectLevel === "read") return;
  await accessStore.recordAudit({
    profileName: context.profile.name,
    actorUserId,
    action: `function.${definition.sideEffectLevel}.${result.writePhase ?? "preview"}`,
    targetType: "function",
    targetId: action,
    metadata: { sourceType: context.event.source.type }
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

function isAccountLinkEvent(value: unknown): value is LineAccountLinkEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "accountLink"
  );
}

function isOrdinaryLineEvent(value: unknown): value is LineEvent {
  if (typeof value !== "object" || value === null || isAccountLinkEvent(value)) return false;
  const source = (value as { source?: unknown }).source;
  return (
    typeof (value as { type?: unknown }).type === "string" &&
    typeof source === "object" &&
    source !== null &&
    typeof (source as { type?: unknown }).type === "string"
  );
}

function parseAccountLinkChallenge(text: string): string | undefined {
  return text.match(/^HHC_ACCOUNT_LINK_V1:([A-Za-z0-9_-]{43})$/)?.[1];
}

function looksLikeAccountLinkChallenge(text: string): boolean {
  return /^HHC[ _-]+ACCOUNT[ _-]+LINK/i.test(text.trim());
}

function accountLinkFinalizeInput(
  event: LineAccountLinkEvent,
  destination: string | undefined,
  profileName: string
): FinalizeLineBindingInput | undefined {
  const nonce = event.link?.nonce;
  const result = event.link?.result;
  if (
    !boundedOpaque(nonce, 255) ||
    (result !== "ok" && result !== "failed") ||
    !boundedOpaque(event.webhookEventId, 255) ||
    !boundedOpaque(destination, 255) ||
    (event.replyToken !== undefined && !boundedOpaque(event.replyToken, 255))
  ) {
    return undefined;
  }
  const base: FinalizeLineBindingInput = {
    nonce,
    result,
    profileName,
    channelId: destination,
    webhookEventId: event.webhookEventId
  };
  if (result === "failed") return base;
  if (event.source?.type !== "user" || !boundedOpaque(event.source.userId, 255)) {
    return undefined;
  }
  return { ...base, actualLineUserId: event.source.userId };
}

function boundedOpaque(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !hasAsciiControl(value)
  );
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function incrementIgnored(counts: Map<string, number>, reason: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
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
  conversationWindowStore: ConversationWindowStore,
  requesterIsAdmin: boolean,
  sessionStore?: SessionStore
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
      if (event.message?.type !== "text") {
        return { allowed: true, reason: "group_attachment_candidate" };
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
        sessionStore &&
        event.source.userId &&
        (await sessionStore.findActionReview({
          profileName: profile.name,
          source: event.source,
          requesterUserId: event.source.userId
        }))
      ) {
        return { allowed: true, reason: "group_action_review_active" };
      }
      if (await hasAttachmentTextIntake(profile, event, sessionStore)) {
        return { allowed: true, reason: "group_attachment_intake_active" };
      }
      if (
        await matchingTextMessageHandler(
          event,
          (
            await resolveEffectiveAccessContext({
              profile,
              event,
              accessStore,
              requesterIsAdmin
            })
          ).profile,
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
        !(await isDirectUserAllowed(profile, event.source.userId, accessStore, requesterIsAdmin))
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

function structurallyAllowEvent(profile: BotProfileConfig, event: LineEvent): AllowResult {
  const sourceType = event.source?.type?.trim().toLowerCase();
  const eventType = event.type?.trim().toLowerCase();
  const command = parseAdminCommand(event.message?.text)?.command;
  if (sourceType === "room") {
    return {
      allowed: false,
      reason: profile.allowRooms ? "room_not_implemented" : "room_blocked"
    };
  }
  if (sourceType === "group" && groupAccessPolicy(profile) === "blocked") {
    return { allowed: false, reason: "group_blocked" };
  }
  if (sourceType !== "user" && sourceType !== "group") {
    return { allowed: false, reason: "source_type_not_supported" };
  }
  if (sourceType === "user" && directAccessPolicy(profile) === "blocked" && !command) {
    return { allowed: false, reason: "direct_user_blocked" };
  }
  if (eventType === "postback") {
    return { allowed: true, reason: "postback_structurally_allowed" };
  }
  if (eventType !== "message") {
    return { allowed: false, reason: "event_type_not_allowed" };
  }
  if (!messageTypeAllowed(profile, event)) {
    return { allowed: false, reason: "message_type_not_allowed" };
  }
  return { allowed: true, reason: "message_structurally_allowed" };
}

function profileUsesProviders(profile: BotProfileConfig): boolean {
  return profile.allowedProviders?.length !== 0;
}

function isAdminCommand(text: string | undefined): boolean {
  return Boolean(parseAdminCommand(text));
}

function isConfiguredExactFunctionCommand(
  profile: BotProfileConfig,
  text: string | undefined,
  sourceType: LineEvent["source"]["type"]
): boolean {
  if (!text || (sourceType !== "user" && sourceType !== "group")) return false;
  return profile.enabledFunctions.some((name) => {
    const definition = getFunctionDefinition(name);
    return Boolean(
      definition?.allowedSources.includes(sourceType) &&
      definition.agentCapability?.exactIntents === true &&
      matchExactWholeMessageIntent(
        text,
        definition.agentCapability.intents.filter((intent) => intent.trim().startsWith("/"))
      )
    );
  });
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
  if (
    !event.source.userId ||
    (event.source.type === "group" && !event.source.groupId) ||
    (event.source.type !== "group" && event.source.type !== "user")
  ) {
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

async function shouldPromptManagedRegistration(
  profile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  requesterIsAdmin: boolean
): Promise<boolean> {
  if (
    event.source.type === "user" &&
    directAccessPolicy(profile) === "managed" &&
    !(await isDirectUserAllowed(profile, event.source.userId, accessStore, requesterIsAdmin))
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
  configuredProfile: BotProfileConfig,
  event: LineEvent,
  config: AppConfig,
  adminHandlers: AdminHandlerRegistry,
  lastErrorStore: LastErrorStore,
  lastRouteStore: LastRouteStore,
  accessStore: AccessStore,
  adminActionRegistry: AdminActionRegistry,
  diagnostics: AppDiagnostics,
  agentTraceStore: AgentTraceStore,
  requestId: string,
  requesterIsAdmin: boolean
): Promise<FunctionExecutionResult> {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (!isKnownAdminCommand(parsed.command, adminHandlers)) {
    return { ok: true, replyText: "目前不支援這個 admin 指令。" };
  }

  if (parsed.command === "llm-use") {
    return handleLlmUseCommand(config, profile, event, parsed.args[0], requesterIsAdmin);
  }

  if (!(await adminAllowed(profile, event, requesterIsAdmin, parsed.command))) {
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
      event,
      requesterIsAdmin
    });
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
    configuredProfile,
    event,
    accessStore,
    adminActionRegistry,
    requesterIsAdmin
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
  providerArg: string | undefined,
  requesterIsAdmin: boolean
): Promise<FunctionExecutionResult> {
  if (!requesterIsAdmin) {
    return { ok: true, replyText: "你沒有權限使用 LLM provider 指令。" };
  }
  if (event.source.type !== "user") {
    return { ok: true, replyText: "請在 1 對 1 對話中使用 LLM provider 指令。" };
  }
  if (!providerArg) {
    const availableProviders = allowedProvidersForProfile(profile);
    const active = profile.providerPolicy?.smart_talk
      ? formatLanePolicy(profile.providerPolicy.smart_talk)
      : (availableProviders[0] ?? "deepseek");
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
  if (value === "deepseek") {
    return "deepseek";
  }
  if (value) {
    return undefined;
  }
  return profile.providerPolicy?.smart_talk?.primary ?? "deepseek";
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
  configuredProfile: BotProfileConfig,
  event: LineEvent,
  accessStore: AccessStore,
  adminActionRegistry: AdminActionRegistry,
  requesterIsAdmin: boolean
): Promise<FunctionExecutionResult | undefined> {
  const actorUserId = event.source.userId;
  if (!actorUserId) {
    return { ok: true, replyText: messages.adminUnauthorized };
  }

  if (isRetiredFunctionScopeCommand(command)) {
    return {
      ok: true,
      replyText: "功能權限已改由 HHC 帳戶統一管理，LINE bot 不再提供本地授權操作。"
    };
  }

  if (command === "access-list") {
    const filterType = parseAccessPrincipalType(args[0], ["user", "group"]);
    const principals = (
      await accessStore.listPrincipals(profile.name, { includeDisabled: true })
    ).filter(
      (principal) =>
        principal.type !== "admin" &&
        (!principal.disabledAt || principal.type === "group") &&
        (!filterType || principal.type === filterType)
    );
    if (principals.length === 0) {
      return { ok: true, replyText: "Access list\n(none)" };
    }
    const rows = await Promise.all(
      principals.map(async (principal) => {
        const base = `${principal.type}: ${principal.principalId}${
          principal.displayName ? ` (${principal.displayName})` : ""
        }`;
        if (principal.type !== "group") {
          return base;
        }
        const effectiveDisplayNames = await groupEffectiveFunctionDisplayNames(
          configuredProfile,
          accessStore,
          principal.principalId
        );
        const lastSuccessDisplayName = principal.lastSuccessCapabilityName
          ? getFunctionDefinition(principal.lastSuccessCapabilityName)?.displayName
          : undefined;
        return [
          base,
          `  state: ${principal.disabledAt ? "disabled" : "active"}`,
          `  effective: ${effectiveDisplayNames.join(", ") || "(none)"}`,
          `  last-success: ${
            lastSuccessDisplayName && principal.lastSuccessAt
              ? `${lastSuccessDisplayName} @ ${principal.lastSuccessAt}`
              : "(none)"
          }`
        ].join("\n");
      })
    );
    return {
      ok: true,
      replyText: ["Access list", ...rows].join("\n")
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
      event,
      requesterIsAdmin
    });
  }

  return undefined;
}

function isRetiredFunctionScopeCommand(command: string): boolean {
  return retiredFunctionScopeCommands.has(command);
}

function parseAccessPrincipalType(
  value: string | undefined,
  allowed: AccessPrincipalType[]
): AccessPrincipalType | undefined {
  return value && (allowed as string[]).includes(value)
    ? (value as AccessPrincipalType)
    : undefined;
}

async function groupEffectiveFunctionDisplayNames(
  profile: BotProfileConfig,
  accessStore: AccessStore,
  groupId: string
): Promise<string[]> {
  const context = await resolveEffectiveAccessContext({
    profile,
    event: { type: "access-summary", source: { type: "group", groupId } },
    accessStore,
    requesterIsAdmin: false
  });
  return context.profile.enabledFunctions.flatMap(
    (name) => getFunctionDefinition(name)?.displayName ?? []
  );
}

function isKnownAdminCommand(command: string, adminHandlers: AdminHandlerRegistry): boolean {
  return (
    retiredFunctionScopeCommands.has(command) ||
    builtInAdminCommandGroups.some((group) =>
      group.entries.some((entry) => commandNameFromUsage(entry.usage) === command)
    ) ||
    Boolean(adminHandlers[command])
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
  requesterIsAdmin: boolean,
  command?: string
): Promise<boolean> {
  if (!requesterIsAdmin) {
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

async function isDirectUserAllowed(
  profile: BotProfileConfig,
  userId: string | undefined,
  accessStore: AccessStore,
  requesterIsAdmin: boolean
): Promise<boolean> {
  if (!userId) {
    return false;
  }
  return (
    directAccessPolicy(profile) === "public" ||
    requesterIsAdmin ||
    (await accessStore.hasActivePrincipal(profile.name, "user", userId))
  );
}

interface FunctionAuthorizationState {
  available: boolean;
  authorization: LineFunctionAuthorization;
}

async function authorizeFunctions(
  accountAdminClient: AccountAdminClient,
  profile: BotProfileConfig,
  lineUserId: string | undefined,
  functionNames: CapabilityName[]
): Promise<FunctionAuthorizationState> {
  if (!lineUserId) {
    return { available: false, authorization: emptyFunctionAuthorization() };
  }
  try {
    return {
      available: true,
      authorization: await accountAdminClient.authorizeFunctions({
        lineUserId,
        profileName: profile.name,
        functionNames
      })
    };
  } catch {
    return { available: false, authorization: emptyFunctionAuthorization() };
  }
}

function createTurnFunctionAuthorizer(
  accountAdminClient: AccountAdminClient,
  profile: BotProfileConfig,
  lineUserId: string | undefined
): {
  state(functionNames: readonly CapabilityName[]): Promise<FunctionAuthorizationState>;
  allowedFunctions(functionNames: readonly CapabilityName[]): Promise<readonly CapabilityName[]>;
  administrator(): boolean;
} {
  let authorization: Promise<FunctionAuthorizationState> | undefined;
  let resolvedState: FunctionAuthorizationState | undefined;
  const state = (functionNames: readonly CapabilityName[]): Promise<FunctionAuthorizationState> => {
    if (!authorization) {
      const restricted = new Set(profile.permissionRequiredFunctions);
      const requested = Array.from(
        new Set(functionNames.filter((functionName) => restricted.has(functionName)))
      );
      authorization = authorizeFunctions(accountAdminClient, profile, lineUserId, requested).then(
        (result) => {
          resolvedState = result;
          return result;
        }
      );
    }
    return authorization;
  };
  return {
    state,
    async allowedFunctions(functionNames) {
      const configured = new Set(profile.enabledFunctions);
      const restricted = new Set(profile.permissionRequiredFunctions);
      const requested = Array.from(
        new Set(functionNames.filter((functionName) => configured.has(functionName)))
      );
      const localReads = requested.filter(
        (functionName) =>
          !restricted.has(functionName) &&
          getFunctionDefinition(functionName)?.sideEffectLevel === "read"
      );
      const protectedFunctions = requested.filter(
        (functionName) => !localReads.includes(functionName)
      );
      if (protectedFunctions.length === 0) return localReads;

      const result = await authorizeFunctions(
        accountAdminClient,
        profile,
        lineUserId,
        protectedFunctions
      );
      resolvedState = result;
      if (!result.available || !result.authorization.active) return localReads;
      const explicitlyAllowed = new Set(result.authorization.allowedFunctions);
      return [
        ...localReads,
        ...protectedFunctions.filter((functionName) =>
          restricted.has(functionName)
            ? explicitlyAllowed.has(functionName)
            : result.authorization.administrator &&
              getFunctionDefinition(functionName)?.sideEffectLevel !== "read"
        )
      ];
    },
    administrator() {
      return Boolean(
        resolvedState?.available &&
        resolvedState.authorization.active &&
        resolvedState.authorization.administrator
      );
    }
  };
}

function adminAuthorizationFromFunctionState(state: FunctionAuthorizationState): {
  available: boolean;
  bound: boolean;
  allowed: boolean;
} {
  return {
    available: state.available,
    bound: state.authorization.bound,
    allowed: state.authorization.active && state.authorization.administrator
  };
}

function emptyFunctionAuthorization(): LineFunctionAuthorization {
  return {
    bound: false,
    active: false,
    administrator: false,
    allowedFunctions: []
  };
}

function applyAccountFunctionAuthorization(
  context: EffectiveAccessContext,
  configuredProfile: BotProfileConfig,
  accountState: FunctionAuthorizationState
): EffectiveAccessContext {
  const ceiling = new Set(configuredProfile.enabledFunctions);
  const restricted = new Set(configuredProfile.permissionRequiredFunctions);
  const allowed = new Set(accountState.authorization.allowedFunctions);
  const accountFunctions = configuredProfile.enabledFunctions.filter(
    (name) => restricted.has(name) && allowed.has(name)
  );
  return {
    ...context,
    profile: {
      ...context.profile,
      enabledFunctions: Array.from(
        new Set([
          ...context.profile.enabledFunctions.filter(
            (name) => ceiling.has(name) && (!restricted.has(name) || allowed.has(name))
          ),
          ...(context.authorized ? accountFunctions : [])
        ])
      )
    }
  };
}

function accountSurfacePresentation(
  profile: BotProfileConfig,
  state: FunctionAuthorizationState
): AccountSurfacePresentation {
  if (!profile.accountLink) return { status: "disabled" };
  if (!state.available) return { status: "unavailable" };
  if (!state.authorization.bound) return { status: "unbound" };
  if (!state.authorization.active) return { status: "inactive" };
  return { status: "active", account: state.authorization.account };
}

function requiresAdminAuthorization(
  command: ParsedAdminCommand,
  adminHandlers: AdminHandlerRegistry
): boolean {
  if (!isKnownAdminCommand(command.command, adminHandlers)) {
    return false;
  }
  if (command.command === "whoami" || command.command === "registry") {
    return false;
  }
  return command.command !== "help" || command.args[0]?.toLowerCase() === "admin";
}

async function adminAuthorizationReply(input: {
  event: LineEvent;
  authorization: { available: boolean; bound: boolean; allowed: boolean };
}): Promise<string> {
  if (!input.authorization.available) {
    return "目前無法確認管理權限，請稍後再試。";
  }
  if (input.authorization.bound) {
    return messages.adminUnauthorized;
  }
  if (input.event.source.type !== "user" || !input.event.source.userId) {
    return "請先在 1 對 1 對話中綁定 HHC 帳戶。";
  }
  return "請先傳送「登入 HHC 帳戶」完成登入／綁定，再重新執行管理操作。";
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

async function hasAttachmentTextIntake(
  profile: BotProfileConfig,
  event: LineEvent,
  sessionStore?: SessionStore
): Promise<boolean> {
  const text = event.message?.text;
  const requesterUserId = event.source.userId;
  if (
    event.type !== "message" ||
    event.message?.type !== "text" ||
    !text ||
    !requesterUserId ||
    !profile.enabledFunctions.includes("save_resource")
  ) {
    return false;
  }
  if (isUploadActivation(text)) return true;
  return Boolean(
    await sessionStore?.findPendingAttachment({
      profileName: profile.name,
      source: event.source,
      requesterUserId
    })
  );
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

async function emitAccountLinkFinalizedEvent(input: {
  routeObserver: RouteObserver | undefined;
  config: AppConfig;
  profile: BotProfileConfig;
  source: LineEvent["source"];
  requestId: string;
  status: LineBindingTerminalStatus;
  retry: boolean;
  durationMs: number;
}): Promise<void> {
  await emitRouteEvent(input.routeObserver, {
    kind: "route",
    profileName: input.profile.name,
    sourceType: input.source.type,
    requestId: input.requestId,
    provider: "keyword",
    outcome: "respond",
    action: "account_login",
    ok: input.status === "completed",
    retry: input.retry,
    durationMs: input.durationMs
  });
  await emitProductEvent(input.routeObserver, {
    eventName: "account_link_finalized",
    requestId: input.requestId,
    profileName: input.profile.name,
    source: input.source,
    hmacKey: input.config.observability?.hmacKey,
    action: "account_login",
    resultClass: input.status === "completed" ? "success" : "error",
    retry: input.retry,
    durationMs: input.durationMs
  });
}

async function replyTextBestEffort(
  client: LineReplyClient,
  replyToken: string,
  text: string,
  options?: LineReplyOptions
): Promise<boolean> {
  try {
    await client.replyText(replyToken, text, options);
    return true;
  } catch {
    return false;
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

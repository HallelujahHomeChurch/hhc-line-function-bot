import { randomUUID } from "node:crypto";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { createAdminActionRegistry } from "../actions/admin-registry.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { createSlotClarificationResult } from "../agent/slot-clarification.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createFunctionCompletionObserver } from "../application/turn/completion-observer.js";
import { createLineSdkIdentityClient, createLineSdkReplyClient } from "../clients/line.js";
import { createStaticAppDiagnostics } from "../diagnostics/dependencies.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import { messages } from "../messages.js";
import { InMemoryWebhookEventStore } from "../idempotency/webhook-event-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import {
  InMemoryFirstSuccessStore,
  type FirstSuccessStore
} from "../observability/first-success-store.js";
import { InMemoryRateLimiter } from "../rate-limit.js";
import type { ProfileRuntime } from "../runtime/profile-runtime.js";
import {
  createApp as createTransportApp,
  type AppDependencies
} from "../transport/line/webhook-routes.js";
import type { AppConfig, FunctionRouterPort } from "../types.js";
import type { AdminActionRouterPort, FunctionRegistry } from "../types.js";

export type TestAppDependencies = Partial<AppDependencies> & {
  router?: FunctionRouterPort;
  profileRuntime?: ProfileRuntime;
  adminActionRouter?: AdminActionRouterPort;
  functionRegistry?: FunctionRegistry;
  firstSuccessStore?: FirstSuccessStore;
};

export function createTestApp(config: AppConfig, overrides: TestAppDependencies = {}) {
  const accessStore = overrides.accessStore ?? new InMemoryAccessStore();
  const registrationInviteCodeStore =
    overrides.registrationInviteCodeStore ?? new InMemoryRegistrationInviteCodeStore();
  const lastErrorStore =
    overrides.lastErrorStore ?? new InMemoryLastErrorStore(config.lastErrors?.maxEntries ?? 20);
  const lastRouteStore =
    overrides.lastRouteStore ?? new InMemoryLastRouteStore(config.lastErrors?.maxEntries ?? 20);
  const agentTraceStore =
    overrides.agentTraceStore ?? new InMemoryAgentTraceStore(config.lastErrors?.maxEntries ?? 20);
  const conversationWindowStore =
    overrides.conversationWindowStore ?? new InMemoryConversationWindowStore();
  const sessionStore = overrides.sessionStore;
  const functionRegistry = overrides.functionRegistry ?? {};
  const textMessageHandlers = overrides.textMessageHandlers ?? {};
  const firstSuccessStore = overrides.firstSuccessStore ?? new InMemoryFirstSuccessStore();
  const defaultAccountAdminClient: AppDependencies["accountAdminClient"] = {
    async verifyPermission() {
      return false;
    },
    async authorizeAdministrator(lineUserId: string) {
      const allowed = config.profiles.some((profile) => profile.adminUserId === lineUserId);
      return { bound: allowed, allowed };
    },
    async authorizeFunctions({ lineUserId, functionNames }) {
      const administrator = config.profiles.some((profile) => profile.adminUserId === lineUserId);
      return {
        bound: administrator,
        active: administrator,
        administrator,
        allowedFunctions: administrator ? functionNames : []
      };
    },
    async verifyFunctionPermissions({ functionNames }) {
      return functionNames;
    },
    async createBinding() {
      return {
        bindingUrl: "https://account.alive.org.tw/line/bind#token=test",
        expiresAt: "2026-07-28T12:00:00Z"
      };
    },
    async finalizeBinding() {
      return { status: "completed" as const };
    },
    async updateOwnProfile({ firstName, lastName }) {
      return { firstName, lastName };
    }
  };
  const suppliedAccountAdminClient = overrides.accountAdminClient;
  const accountAdminClient: AppDependencies["accountAdminClient"] = {
    ...defaultAccountAdminClient,
    ...suppliedAccountAdminClient,
    authorizeFunctions:
      suppliedAccountAdminClient?.authorizeFunctions ??
      (async ({ lineUserId, functionNames }) => {
        const legacy = await (
          suppliedAccountAdminClient?.authorizeAdministrator ??
          defaultAccountAdminClient.authorizeAdministrator
        )(lineUserId);
        return {
          bound: legacy.bound,
          active: legacy.allowed,
          administrator: legacy.allowed,
          allowedFunctions: legacy.allowed ? functionNames : []
        };
      })
  };
  const completionObserver =
    overrides.completionObserver ??
    createFunctionCompletionObserver({
      accessStore,
      routeObserver: overrides.routeObserver,
      firstSuccessStore,
      observabilityHmacKey: config.observability?.hmacKey
    });
  const adminActionRegistry =
    overrides.adminActionRegistry ??
    createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes: config.access?.registrationInviteCodeTtlMinutes ?? 60,
      confirmationStore: overrides.confirmationStore,
      confirmationTtlMinutes: config.access?.confirmationTtlMinutes
    });
  const continuationRuntime =
    overrides.agentTurnRuntime ??
    createAgentTurnRuntime({
      functionRegistry,
      textMessageHandlers,
      adminActionRouter: overrides.adminActionRouter,
      adminActionRegistry,
      accessStore,
      sessionStore,
      agentRuntime: overrides.agentRuntime,
      traceStore: agentTraceStore,
      lastErrorStore,
      lastRouteStore,
      routeObserver: overrides.routeObserver,
      observabilityHmacKey: config.observability?.hmacKey,
      firstSuccessStore,
      completionObserver
    });
  const agentTurnRuntime = overrides.profileRuntime
    ? createProfileRuntimeTestAdapter(overrides.profileRuntime)
    : overrides.router
      ? createRouterTestRuntime(
          overrides.router,
          continuationRuntime,
          functionRegistry,
          sessionStore
        )
      : continuationRuntime;

  return createTransportApp(config, {
    adminActionRegistry,
    postbackHandlers: overrides.postbackHandlers ?? {},
    textMessageHandlers,
    adminHandlers: overrides.adminHandlers ?? {},
    createLineReplyClient: overrides.createLineReplyClient ?? createLineSdkReplyClient,
    createLineIdentityClient: overrides.createLineIdentityClient ?? createLineSdkIdentityClient,
    routeObserver: overrides.routeObserver,
    requestIdFactory: overrides.requestIdFactory ?? randomUUID,
    lastErrorStore,
    lastRouteStore,
    rateLimiter:
      overrides.rateLimiter ??
      new InMemoryRateLimiter(
        config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 }
      ),
    accessStore,
    registrationInviteCodeStore,
    diagnostics: overrides.diagnostics ?? createStaticAppDiagnostics(config),
    confirmationStore: overrides.confirmationStore,
    webhookEventStore: overrides.webhookEventStore ?? new InMemoryWebhookEventStore(),
    textGenerator: overrides.textGenerator,
    agentRuntime: overrides.agentRuntime,
    agentTurnRuntime,
    agentTraceStore,
    sessionStore,
    agentJobStore: overrides.agentJobStore ?? new InMemoryAgentJobStore(),
    conversationWindowStore,
    textFallbackGenerator: overrides.textFallbackGenerator,
    completionObserver,
    accountAdminClient,
    mediaSyncStore: overrides.mediaSyncStore
  });
}

function createProfileRuntimeTestAdapter(profileRuntime: ProfileRuntime) {
  return {
    handleTextTurn(
      input: Parameters<ReturnType<typeof createAgentTurnRuntime>["handleTextTurn"]>[0]
    ) {
      return profileRuntime.handleTextTurn({
        profile: input.profile,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName,
        requesterIsAdmin: input.requesterIsAdmin,
        configuredFunctions: input.configuredFunctions ? [...input.configuredFunctions] : undefined,
        authorizeFunctions: input.authorizeFunctions
          ? async (names) => [...(await input.authorizeFunctions!(names))]
          : undefined,
        accountAdministrator: input.accountAdministrator
      });
    }
  };
}

function createRouterTestRuntime(
  router: FunctionRouterPort,
  continuationRuntime: ReturnType<typeof createAgentTurnRuntime>,
  functionRegistry: FunctionRegistry,
  sessionStore: TestAppDependencies["sessionStore"]
) {
  return {
    async handleTextTurn(input: Parameters<typeof continuationRuntime.handleTextTurn>[0]) {
      const continuation = await continuationRuntime.handleTextTurn(input);
      if (continuation || input.allowRouting === false) return continuation;
      const route = await router.route({
        profileName: input.profile.name,
        text: input.event.message?.text ?? "",
        enabledFunctions: input.profile.enabledFunctions,
        source: input.event.source
      });
      if (!route) return { ok: true, replyText: messages.unsupported };
      if (route.type === "deny") return { ok: true, replyText: messages.unsupported };
      if (route.type === "respond") return { ok: true, replyText: messages.unsupported };
      const handler = functionRegistry[route.action];
      if (!handler) return { ok: true, replyText: messages.functionNotConfigured };
      const context = {
        profile: input.profile,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName,
        requesterIsAdmin: input.requesterIsAdmin
      };
      const arguments_ = normalizeFunctionArguments(route.action, route.arguments, {
        text: input.event.message?.text ?? ""
      });
      const clarification = await createSlotClarificationResult({
        sessionStore,
        action: route.action,
        arguments: arguments_,
        context,
        requestId: input.requestId,
        now: new Date()
      });
      return clarification ?? handler(arguments_, context);
    }
  };
}

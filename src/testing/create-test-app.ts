import { randomUUID } from "node:crypto";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { createAdminActionRegistry } from "../actions/admin-registry.js";
import type { ControlledAgentRouter } from "../agent/controlled-agent-router.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { createAgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { createControlledCompletionObserver } from "../application/turn/completion-observer.js";
import { createLineSdkIdentityClient, createLineSdkReplyClient } from "../clients/line.js";
import { createStaticAppDiagnostics } from "../diagnostics/dependencies.js";
import { MemoryInFlightStore } from "../in-flight/in-flight-store.js";
import { InMemoryWebhookEventStore } from "../idempotency/webhook-event-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../observability/last-route-store.js";
import {
  InMemoryFirstSuccessStore,
  type FirstSuccessStore
} from "../observability/first-success-store.js";
import { InMemoryRateLimiter } from "../rate-limit.js";
import {
  createApp as createTransportApp,
  type AppDependencies
} from "../transport/line/webhook-routes.js";
import type { AppConfig, FunctionRouterPort } from "../types.js";
import type { AdminActionRouterPort, FunctionRegistry } from "../types.js";
import type { InFlightStore } from "../in-flight/in-flight-store.js";

export type TestAppDependencies = Partial<AppDependencies> & {
  router?: FunctionRouterPort;
  adminActionRouter?: AdminActionRouterPort;
  functionRegistry?: FunctionRegistry;
  inFlightStore?: InFlightStore;
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
  const inFlightStore = overrides.inFlightStore ?? new MemoryInFlightStore();
  const agentTraceStore =
    overrides.agentTraceStore ?? new InMemoryAgentTraceStore(config.lastErrors?.maxEntries ?? 20);
  const conversationWindowStore =
    overrides.conversationWindowStore ?? new InMemoryConversationWindowStore();
  const controlledAgentRouter =
    overrides.controlledAgentRouter ??
    (overrides.router ? adaptLegacyRouter(overrides.router) : undefined);
  const functionRegistry = overrides.functionRegistry ?? {};
  const textMessageHandlers = overrides.textMessageHandlers ?? {};
  const firstSuccessStore = overrides.firstSuccessStore ?? new InMemoryFirstSuccessStore();
  const accountAdminClient = overrides.accountAdminClient ?? {
    async authorizeAdministrator(lineUserId: string) {
      const allowed = config.profiles.some((profile) => profile.adminUserId === lineUserId);
      return { bound: allowed, allowed };
    },
    async authorizeFunctions() {
      return {
        bound: false,
        active: false,
        administrator: false,
        allowedFunctions: []
      };
    },
    async createBinding() {
      return {
        bindingUrl: "https://account.alive.org.tw/line/bind#token=test",
        expiresAt: "2026-07-28T12:00:00Z"
      };
    },
    async finalizeBinding() {
      return { status: "completed" as const };
    }
  };
  const completionObserver =
    overrides.completionObserver ??
    createControlledCompletionObserver({
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
  const agentTurnRuntime =
    overrides.agentTurnRuntime ??
    createAgentTurnRuntime({
      functionRegistry,
      textMessageHandlers,
      adminActionRouter: overrides.adminActionRouter,
      adminActionRegistry,
      accessStore,
      inFlightStore,
      sessionStore: overrides.sessionStore,
      agentRuntime: overrides.agentRuntime,
      traceStore: agentTraceStore,
      lastErrorStore,
      lastRouteStore,
      routeObserver: overrides.routeObserver,
      textGenerator: overrides.textGenerator,
      textFallbackGenerator: overrides.textFallbackGenerator,
      conversationWindowStore,
      controlledAgentRouter,
      observabilityHmacKey: config.observability?.hmacKey,
      firstSuccessStore,
      completionObserver,
      timeZone: config.timeZone
    });

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
    sessionStore: overrides.sessionStore,
    agentJobStore: overrides.agentJobStore ?? new InMemoryAgentJobStore(),
    conversationWindowStore,
    textFallbackGenerator: overrides.textFallbackGenerator,
    controlledAgentRouter,
    completionObserver,
    accountAdminClient
  });
}

function adaptLegacyRouter(router: FunctionRouterPort): ControlledAgentRouter {
  return {
    async resolve(
      input: Parameters<NonNullable<AppDependencies["controlledAgentRouter"]>["resolve"]>[0]
    ) {
      const route = await router.route({
        profileName: input.profileName,
        text: input.text,
        enabledFunctions: [...input.enabledFunctions],
        source:
          input.sourceType === "group"
            ? { type: "group" as const, groupId: "test-group", userId: "test-user" }
            : { type: "user" as const, userId: "test-user" }
      });
      if (route.type === "deny") {
        return { disposition: "deny" as const, reasonCode: "planner_denied" };
      }
      if (route.type === "respond") {
        return { disposition: "chat" as const, reasonCode: "no_capability_evidence" };
      }
      return {
        disposition: "execute" as const,
        capability: route.action,
        arguments: route.arguments,
        reasonCode: "deterministic_explicit_intent"
      };
    }
  };
}

import type { AccessStore } from "../access/types.js";
import type { AdminActionRegistry } from "../actions/admin-registry.js";
import {
  enabledNaturalLanguageAdminActionNames,
  matchesGroupScopedNaturalLanguageAdminActionHint,
  matchesNaturalLanguageAdminActionHint
} from "../actions/catalog.js";
import { guardSystemRouteWithFunctionIntent } from "./function-intent-guard.js";
import { createSlotClarificationResult } from "./slot-clarification.js";
import { messages } from "../messages.js";
import { buildFunctionQuickReplies } from "../line-reply.js";
import { createControlledSmallTalkReply, smallTalkCategoryFromArguments } from "../small-talk.js";
import { createIntroReply } from "../intro.js";
import { createQueryClarificationReply } from "../query-clarification.js";
import { sanitizeActionTelemetryEvent } from "../observability/action-telemetry.js";
import type { LastErrorStore } from "../observability/last-error-store.js";
import type { LastRouteRecord, LastRouteStore } from "../observability/last-route-store.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import type { SessionStore } from "../state/session-store.js";
import type { InFlightKey, InFlightStore } from "../in-flight/in-flight-store.js";
import type { ContextManager, ConversationWindowStore } from "./context-manager.js";
import type {
  AdminActionRouterPort,
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  FunctionRouterPort,
  JsonRecord,
  LineEvent,
  ModelProviderLane,
  LineSource,
  ModelProviderName,
  RouteObserver,
  RouteObserverEvent,
  RouteProviderName,
  TextGenerationProvider,
  TextMessageHandlerRegistry
} from "../types.js";
import type { AgentRuntime } from "./agent-runtime.js";
import {
  type AgentTraceStore,
  type AgentTurnTraceRecord,
  type AgentTurnTraceStep
} from "./trace-store.js";

export interface AgentTurnRuntimeOptions {
  router: FunctionRouterPort;
  functionRegistry: FunctionRegistry;
  textMessageHandlers: TextMessageHandlerRegistry;
  adminActionRouter?: AdminActionRouterPort;
  adminActionRegistry?: AdminActionRegistry;
  accessStore?: AccessStore;
  inFlightStore: InFlightStore;
  sessionStore?: SessionStore;
  agentRuntime?: AgentRuntime;
  traceStore?: AgentTraceStore;
  lastErrorStore: LastErrorStore;
  lastRouteStore: LastRouteStore;
  routeObserver?: RouteObserver;
  textGenerator?: TextGenerationProvider;
  textFallbackGenerator?: TextGenerationProvider;
  contextManager?: ContextManager;
  conversationWindowStore?: ConversationWindowStore;
  now?: () => Date;
}

export interface AgentTextTurnInput {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  engagement?: string;
  allowRouting?: boolean;
}

export interface AgentTurnRuntime {
  handleTextTurn(input: AgentTextTurnInput): Promise<FunctionExecutionResult | undefined>;
}

const IN_FLIGHT_TTL_MS = 120_000;
const IN_FLIGHT_FUNCTIONS = new Set<FunctionName>([
  "find_ppt_slides",
  "find_pop_sheet_music",
  "query_service_schedule"
]);

export function createAgentTurnRuntime(options: AgentTurnRuntimeOptions): AgentTurnRuntime {
  const now = options.now ?? (() => new Date());

  async function recordTrace(
    input: AgentTextTurnInput,
    steps: AgentTurnTraceStep[]
  ): Promise<void> {
    if (!options.traceStore || steps.length === 0) {
      return;
    }
    const record: AgentTurnTraceRecord = {
      requestId: input.requestId,
      occurredAt: now().toISOString(),
      profileName: input.profile.name,
      sourceType: input.event.source.type,
      steps
    };
    await options.traceStore.record(record);
  }

  async function finish(
    input: AgentTextTurnInput,
    steps: AgentTurnTraceStep[],
    result: FunctionExecutionResult | undefined
  ): Promise<FunctionExecutionResult | undefined> {
    await recordTrace(input, steps);
    return result;
  }

  return {
    async handleTextTurn(input: AgentTextTurnInput): Promise<FunctionExecutionResult | undefined> {
      const steps: AgentTurnTraceStep[] = [];
      const text = input.event.message?.text ?? "";
      const context: FunctionHandlerContext = {
        profile: input.profile,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName
      };

      const preRoute = await options.agentRuntime?.handleTextBeforeRouting({
        text,
        context
      });
      if (preRoute) {
        steps.push({ phase: "pre_route_memory", outcome: "handled", ok: preRoute.ok });
        await emitRouteEvent(options.routeObserver, {
          kind: "text_handler",
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          requestId: input.requestId,
          handler: "agent_runtime",
          ok: preRoute.ok
        });
        return finish(input, steps, preRoute);
      }
      steps.push({ phase: "pre_route_memory", outcome: "miss" });

      const textMessageHandler = await matchingTextMessageHandler(
        input.event,
        input.profile,
        options.textMessageHandlers,
        input.requesterDisplayName
      );
      if (textMessageHandler) {
        const startedAt = Date.now();
        const result = await textMessageHandler.handler.handle(
          { text },
          {
            profile: input.profile,
            event: input.event,
            requestId: input.requestId,
            requesterDisplayName: input.requesterDisplayName
          }
        );
        steps.push({
          phase: "text_handler",
          outcome: textMessageHandler.name,
          ok: result?.ok,
          durationMs: elapsedMs(startedAt)
        });
        await emitRouteEvent(options.routeObserver, {
          kind: "text_handler",
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          requestId: input.requestId,
          handler: textMessageHandler.name,
          ok: result?.ok,
          durationMs: elapsedMs(startedAt)
        });
        if (result) {
          const textHandlerFunctionName = functionNameForAgentResource(
            result.agentResource?.resourceType
          );
          if (textHandlerFunctionName) {
            await options.agentRuntime?.afterFunctionResult({
              context,
              action: textHandlerFunctionName,
              arguments: {},
              result
            });
          }
        }
        return finish(input, steps, result);
      }

      if (input.allowRouting === false) {
        return undefined;
      }

      const queryClarification = createQueryClarificationReply(input.profile, text);
      if (queryClarification) {
        steps.push({ phase: "query_clarification", outcome: "handled", ok: true });
        return finish(input, steps, queryClarification);
      }

      const adminActionResult = await handleNaturalLanguageAdminAction({
        text,
        profile: input.profile,
        event: input.event,
        adminActionRouter: options.adminActionRouter,
        adminActionRegistry: options.adminActionRegistry,
        accessStore: options.accessStore,
        routeObserver: options.routeObserver,
        lastRouteStore: options.lastRouteStore,
        requestId: input.requestId,
        steps
      });
      if (adminActionResult) {
        return finish(input, steps, adminActionResult);
      }

      const runtimeContext = await buildRuntimeContext(options, input, text);
      if (runtimeContext) {
        steps.push({
          phase: "context",
          outcome: runtimeContext.compressed ? "compressed" : "full"
        });
      }

      const routeStartedAt = Date.now();
      let route;
      try {
        route = await options.router.route({
          profileName: input.profile.name,
          text,
          enabledFunctions: input.profile.enabledFunctions,
          source: input.event.source,
          runtimeContext: runtimeContext?.prompt
        });
      } catch (error) {
        await recordRuntimeError({
          store: options.lastErrorStore,
          input,
          phase: "router",
          error
        });
        steps.push({
          phase: "function_error",
          outcome: "router",
          errorName: error instanceof Error ? error.name : typeof error
        });
        return finish(input, steps, { ok: false, replyText: messages.requestFailed });
      }
      route = guardSystemRouteWithFunctionIntent(route, text, input.profile.enabledFunctions);

      const routeDurationMs = elapsedMs(routeStartedAt);
      steps.push({
        phase: "route",
        outcome: route.type,
        provider: route.provider,
        lane: route.lane,
        action: route.type === "execute" || route.type === "respond" ? route.action : undefined,
        reason: route.type === "deny" ? route.reason : undefined,
        query: route.type === "execute" ? queryMarker(route.arguments) : undefined,
        durationMs: routeDurationMs
      });
      await recordRoute({
        routeObserver: options.routeObserver,
        lastRouteStore: options.lastRouteStore,
        input,
        provider: route.provider,
        lane: route.lane,
        outcome: route.type,
        action: route.type === "execute" || route.type === "respond" ? route.action : undefined,
        reason: route.type === "deny" ? route.reason : undefined,
        confidence:
          route.type === "execute" || route.type === "respond" ? route.confidence : undefined,
        fallbackProvider: route.fallbackProvider,
        fallbackReason: route.fallbackReason,
        arguments: route.type === "execute" ? route.arguments : undefined,
        durationMs: routeDurationMs
      });

      if (route.type === "respond") {
        if (route.action === "introduce_bot") {
          const intro = createIntroReply(input.profile, text, {
            force: true,
            variant: introVariantRouteArgument(route.arguments)
          });
          return finish(input, steps, intro ?? { ok: false, replyText: messages.requestFailed });
        }
        if (route.action === "small_talk") {
          const result = await createControlledSmallTalkReply({
            profile: input.profile,
            text,
            category: smallTalkCategoryFromArguments(route.arguments),
            generator: options.textGenerator,
            fallbackGenerator: options.textFallbackGenerator
          });
          if (result.smallTalkTrace) {
            steps.push({
              phase: "small_talk",
              outcome: result.smallTalkTrace.outcome,
              provider: result.smallTalkTrace.provider,
              lane: result.smallTalkTrace.lane,
              reason: result.smallTalkTrace.reason
            });
          }
          return finish(input, steps, result);
        }
        return finish(input, steps, { ok: true, replyText: messages.unsupported });
      }

      if (route.type === "deny") {
        const quickReplies = buildFunctionQuickReplies(input.profile);
        return finish(input, steps, {
          ok: true,
          replyText:
            quickReplies.length > 0 ? messages.unsupportedWithSuggestions : messages.unsupported,
          quickReplies: quickReplies.length > 0 ? quickReplies : undefined
        });
      }

      const normalizedArguments = normalizeFunctionArguments(route.action, route.arguments, {
        text
      });
      const handler = options.functionRegistry[route.action];
      if (!handler) {
        return finish(input, steps, { ok: true, replyText: messages.functionNotConfigured });
      }

      const slotClarification = await createSlotClarificationResult({
        sessionStore: options.sessionStore,
        action: route.action,
        arguments: normalizedArguments,
        context,
        requestId: input.requestId,
        now: now()
      });
      if (slotClarification) {
        steps.push({
          phase: "slot_clarification",
          outcome: "handled",
          action: route.action,
          query: queryMarker(normalizedArguments)
        });
        return finish(input, steps, slotClarification);
      }

      const memoryAlias = await options.agentRuntime?.handleBeforeFunctionExecution({
        context,
        action: route.action,
        arguments: normalizedArguments
      });
      if (memoryAlias) {
        steps.push({
          phase: "memory_alias",
          outcome: "hit",
          action: route.action,
          ok: memoryAlias.ok,
          query: queryMarker(normalizedArguments)
        });
        await emitRouteEvent(options.routeObserver, {
          kind: "function_result",
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          requestId: input.requestId,
          action: route.action,
          ok: memoryAlias.ok,
          dedup: "agent_memory"
        });
        return finish(input, steps, memoryAlias);
      }
      steps.push({ phase: "memory_alias", outcome: "miss", action: route.action });

      const inFlight = buildInFlightKey(
        input.profile.name,
        input.event.source,
        route.action,
        normalizedArguments
      );
      if (inFlight) {
        const startResult = await options.inFlightStore.tryStart(inFlight.key, IN_FLIGHT_TTL_MS);
        if (startResult === "busy") {
          steps.push({
            phase: "in_flight",
            outcome: "busy",
            action: route.action,
            dedup: "busy",
            query: "present"
          });
          await emitRouteEvent(options.routeObserver, {
            kind: "function_result",
            profileName: input.profile.name,
            sourceType: input.event.source.type,
            requestId: input.requestId,
            action: route.action,
            ok: false,
            dedup: "busy",
            queryHash: inFlight.queryHash
          });
          return finish(input, steps, {
            ok: true,
            replyText: input.requesterDisplayName
              ? `${input.requesterDisplayName}，我還在找這個，等我一下就好。`
              : "我還在找這個，等我一下就好。"
          });
        }
        steps.push({
          phase: "in_flight",
          outcome: "started",
          action: route.action,
          dedup: "started"
        });
      }

      const functionStartedAt = Date.now();
      try {
        const result = await handler(normalizedArguments, context);
        await options.agentRuntime?.afterFunctionResult({
          context,
          action: route.action,
          arguments: normalizedArguments,
          result
        });
        const durationMs = elapsedMs(functionStartedAt);
        steps.push({
          phase: "function",
          outcome: "executed",
          action: route.action,
          ok: result.ok,
          query: queryMarker(normalizedArguments),
          durationMs
        });
        await emitRouteEvent(options.routeObserver, {
          kind: "function_result",
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          requestId: input.requestId,
          action: route.action,
          ok: result.ok,
          dedup: inFlight ? "started" : undefined,
          queryHash: inFlight?.queryHash,
          durationMs
        });
        await options.lastRouteStore.record({
          requestId: input.requestId,
          occurredAt: now().toISOString(),
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          phase: "function",
          action: route.action,
          ok: result.ok,
          durationMs
        });
        return finish(input, steps, result);
      } catch (error) {
        const durationMs = elapsedMs(functionStartedAt);
        await recordRuntimeError({
          store: options.lastErrorStore,
          input,
          phase: "function",
          action: route.action,
          error
        });
        steps.push({
          phase: "function_error",
          outcome: "function",
          action: route.action,
          ok: false,
          errorName: error instanceof Error ? error.name : typeof error,
          durationMs
        });
        await emitRouteEvent(options.routeObserver, {
          kind: "function_error",
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          requestId: input.requestId,
          action: route.action,
          ok: false,
          errorName: error instanceof Error ? error.name : typeof error,
          durationMs
        });
        await options.lastRouteStore.record({
          requestId: input.requestId,
          occurredAt: now().toISOString(),
          profileName: input.profile.name,
          sourceType: input.event.source.type,
          phase: "function",
          action: route.action,
          ok: false,
          errorName: error instanceof Error ? error.name : typeof error,
          durationMs
        });
        return finish(input, steps, { ok: false, replyText: messages.requestFailed });
      } finally {
        if (inFlight) {
          await releaseInFlight(options.inFlightStore, inFlight.key);
        }
      }
    }
  };
}

async function handleNaturalLanguageAdminAction(input: {
  text: string;
  profile: BotProfileConfig;
  event: LineEvent;
  adminActionRouter: AdminActionRouterPort | undefined;
  adminActionRegistry: AdminActionRegistry | undefined;
  accessStore: AccessStore | undefined;
  routeObserver: RouteObserver | undefined;
  lastRouteStore: LastRouteStore;
  requestId: string;
  steps: AgentTurnTraceStep[];
}): Promise<FunctionExecutionResult | undefined> {
  if (!matchesNaturalLanguageAdminActionHint(input.text) || !input.accessStore) {
    return undefined;
  }
  if (!(await isAdminUser(input.profile, input.event.source.userId, input.accessStore))) {
    return undefined;
  }
  if (
    input.event.source.type !== "user" &&
    !matchesGroupScopedNaturalLanguageAdminActionHint(input.text)
  ) {
    return { ok: true, replyText: "管理操作請到個人對話使用。" };
  }
  if (!input.adminActionRouter || !input.adminActionRegistry) {
    return { ok: true, replyText: adminNaturalLanguageUnsupportedReply() };
  }

  const routeStartedAt = Date.now();
  const route = await input.adminActionRouter.route({
    profileName: input.profile.name,
    text: input.text,
    enabledActions: enabledNaturalLanguageAdminActionNames(),
    source: input.event.source
  });
  const routeDurationMs = elapsedMs(routeStartedAt);
  input.steps.push({
    phase: "admin_action_route",
    outcome: route.type,
    provider: route.provider,
    action: route.type === "execute" ? route.action : undefined,
    reason: route.type === "deny" ? route.reason : undefined,
    durationMs: routeDurationMs
  });
  await emitRouteEvent(input.routeObserver, {
    kind: "admin_action_route",
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    requestId: input.requestId,
    provider: route.provider,
    lane: route.lane,
    outcome: route.type,
    action: route.type === "execute" ? route.action : undefined,
    reason: route.type === "deny" ? route.reason : undefined,
    confidence: route.type === "execute" ? route.confidence : undefined,
    fallbackProvider: route.type === "deny" ? route.fallbackProvider : undefined,
    fallbackReason: route.type === "deny" ? route.fallbackReason : undefined,
    durationMs: routeDurationMs
  });
  await input.lastRouteStore.record({
    requestId: input.requestId,
    occurredAt: new Date().toISOString(),
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    phase: "admin_route",
    provider: route.provider,
    outcome: route.type,
    action: route.type === "execute" ? route.action : undefined,
    reason: route.type === "deny" ? route.reason : undefined,
    fallbackProvider: route.type === "deny" ? route.fallbackProvider : undefined,
    fallbackReason: route.type === "deny" ? route.fallbackReason : undefined,
    durationMs: routeDurationMs
  });

  if (route.type === "deny") {
    return { ok: true, replyText: adminNaturalLanguageUnsupportedReply() };
  }

  const actionStartedAt = Date.now();
  const result = await input.adminActionRegistry.execute({
    action: route.action,
    profile: input.profile,
    event: input.event,
    arguments: route.arguments
  });
  const durationMs = elapsedMs(actionStartedAt);
  input.steps.push({
    phase: "admin_action_result",
    outcome: "executed",
    action: route.action,
    ok: result.ok,
    durationMs
  });
  await emitRouteEvent(input.routeObserver, {
    kind: "admin_action_result",
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    requestId: input.requestId,
    action: route.action,
    ok: result.ok,
    durationMs
  });
  await input.lastRouteStore.record({
    requestId: input.requestId,
    occurredAt: new Date().toISOString(),
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    phase: "admin_action",
    action: route.action,
    ok: result.ok,
    durationMs
  });
  return result;
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
    profile.adminUserId === userId ||
    (await accessStore.hasActivePrincipal(profile.name, "admin", userId))
  );
}

async function buildRuntimeContext(
  options: AgentTurnRuntimeOptions,
  input: AgentTextTurnInput,
  text: string
) {
  if (!options.contextManager) {
    return undefined;
  }
  const scope = {
    profileName: input.profile.name,
    sourceKey: sourceKey(input.event.source),
    requesterUserId: input.event.source.userId
  };
  const recentTurns = await options.conversationWindowStore?.recentTurns(scope, 6);
  const adminAllowed =
    options.accessStore && input.event.source.userId
      ? await isAdminUser(input.profile, input.event.source.userId, options.accessStore)
      : false;
  return options.contextManager.build({
    safety: {
      profileName: input.profile.name,
      sourceKey: scope.sourceKey,
      requesterUserId: input.event.source.userId,
      enabledFunctions: input.profile.enabledFunctions,
      adminAllowed,
      webAllowlistDecision: "not_requested"
    },
    currentMessage: text,
    recentTurns
  });
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

async function recordRoute(input: {
  routeObserver: RouteObserver | undefined;
  lastRouteStore: LastRouteStore;
  input: AgentTextTurnInput;
  provider: RouteProviderName;
  lane?: ModelProviderLane;
  outcome: "execute" | "respond" | "deny";
  action?: string;
  reason?: string;
  confidence?: number;
  fallbackProvider?: ModelProviderName;
  fallbackReason?: string;
  arguments?: JsonRecord;
  durationMs: number;
}) {
  await emitRouteEvent(input.routeObserver, {
    kind: "route",
    profileName: input.input.profile.name,
    sourceType: input.input.event.source.type,
    requestId: input.input.requestId,
    provider: input.provider,
    lane: input.lane,
    outcome: input.outcome,
    action: input.action,
    reason: input.reason,
    confidence: input.confidence,
    fallbackProvider: input.fallbackProvider,
    fallbackReason: input.fallbackReason,
    engagement: input.input.engagement,
    durationMs: input.durationMs
  });
  await input.lastRouteStore.record({
    requestId: input.input.requestId,
    occurredAt: new Date().toISOString(),
    profileName: input.input.profile.name,
    sourceType: input.input.event.source.type,
    phase: "route",
    provider: input.provider,
    lane: input.lane,
    outcome: input.outcome,
    action: input.action,
    reason: input.reason,
    fallbackProvider: input.fallbackProvider,
    fallbackReason: input.fallbackReason,
    ...(input.arguments ? summarizeRouteArguments(input.arguments) : {}),
    durationMs: input.durationMs
  });
}

async function recordRuntimeError(input: {
  store: LastErrorStore;
  input: AgentTextTurnInput;
  phase: "router" | "function";
  action?: FunctionName;
  error: unknown;
}) {
  await input.store.record({
    requestId: input.input.requestId,
    occurredAt: new Date().toISOString(),
    profileName: input.input.profile.name,
    sourceType: input.input.event.source.type,
    phase: input.phase,
    action: input.action,
    errorName: input.error instanceof Error ? input.error.name : typeof input.error,
    message: input.error instanceof Error ? input.error.message : String(input.error)
  });
}

function summarizeRouteArguments(args: JsonRecord): Pick<LastRouteRecord, "query" | "fileType"> {
  const fileType = args.fileType;
  return {
    query: queryMarker(args),
    fileType: typeof fileType === "string" ? fileType : undefined
  };
}

function queryMarker(args: JsonRecord): "present" | "empty" | "missing" {
  const query = args.query;
  if (typeof query !== "string") {
    return "missing";
  }
  return query.trim() ? "present" : "empty";
}

function functionNameForAgentResource(resourceType: string | undefined): FunctionName | undefined {
  switch (resourceType) {
    case "ppt_slide":
      return "find_ppt_slides";
    case "sheet_music":
      return "find_pop_sheet_music";
    default:
      return undefined;
  }
}

function buildInFlightKey(
  profileName: string,
  source: LineSource,
  action: FunctionName,
  args: JsonRecord
): { key: InFlightKey; queryHash: string } | undefined {
  if (!IN_FLIGHT_FUNCTIONS.has(action)) {
    return undefined;
  }
  const queryHash = hashDedupPayload(normalizeDedupPayload(args));
  return {
    queryHash,
    key: {
      profileName,
      sourceKey: sourceKey(source),
      action,
      queryHash
    }
  };
}

function normalizeDedupPayload(args: JsonRecord): string {
  const query = typeof args.query === "string" ? args.query.normalize("NFKC").trim() : "";
  const fileType = typeof args.fileType === "string" ? args.fileType.trim().toLowerCase() : "";
  const dateIntent = typeof args.dateIntent === "string" ? args.dateIntent.trim() : "";
  const meeting = typeof args.meeting === "string" ? args.meeting.trim() : "";
  const role = typeof args.role === "string" ? args.role.trim() : "";
  return JSON.stringify({ query, fileType, dateIntent, meeting, role });
}

async function releaseInFlight(store: InFlightStore, key: InFlightKey): Promise<void> {
  try {
    await store.release(key);
  } catch {
    // A failed cleanup should not turn a successful LINE reply into an error.
  }
}

function sourceKey(source: LineSource): string {
  switch (source.type) {
    case "group":
      return `group:${source.groupId ?? ""}`;
    case "room":
      return `room:${source.roomId ?? ""}`;
    case "user":
      return `user:${source.userId ?? ""}`;
    default:
      return `${source.type}:unknown`;
  }
}

function hashDedupPayload(payload: string): string {
  let hash = 0;
  for (let index = 0; index < payload.length; index += 1) {
    hash = Math.imul(31, hash) + payload.charCodeAt(index);
  }
  return Math.abs(hash).toString(16).slice(0, 16);
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

function introVariantRouteArgument(args: JsonRecord): "identity" | "capabilities" | undefined {
  const value = args.variant;
  return value === "identity" || value === "capabilities" ? value : undefined;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function adminNaturalLanguageUnsupportedReply(): string {
  return "目前還不能用自然語言執行這個管理操作，請使用 /help admin。";
}

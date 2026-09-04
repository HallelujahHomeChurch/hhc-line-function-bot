import type { AccessStore } from "../../access/types.js";
import type { AdminActionRegistry } from "../../actions/admin-registry.js";
import {
  enabledNaturalLanguageAdminActionNames,
  matchesGroupScopedNaturalLanguageAdminActionHint,
  matchesNaturalLanguageAdminActionHint
} from "../../actions/catalog.js";
import type { AgentRuntime } from "../../agent/agent-runtime.js";
import type {
  AgentTraceStore,
  AgentTurnTraceRecord,
  AgentTurnTraceStep
} from "../../agent/trace-store.js";
import { getFunctionDefinition } from "../../functions/definitions.js";
import { requestFailedMessage } from "../../messages.js";
import { sanitizeActionTelemetryEvent } from "../../observability/action-telemetry.js";
import type { FirstSuccessStore } from "../../observability/first-success-store.js";
import type { LastErrorStore } from "../../observability/last-error-store.js";
import type { LastRouteStore } from "../../observability/last-route-store.js";
import type { SessionStore } from "../../state/session-store.js";
import type { BotProfileConfig, FunctionName, LineEvent } from "../../types.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionRegistry,
  TextMessageHandlerRegistry
} from "../contracts/function-execution.js";
import type {
  AdminActionRouterPort,
  RouteObserver,
  RouteObserverEvent
} from "../contracts/routing.js";
import {
  createFunctionCompletionObserver,
  type FunctionCompletionObserver
} from "./completion-observer.js";
import { matchTextContinuation } from "./stages/text-continuation-stage.js";

export interface AgentTurnRuntimeOptions {
  functionRegistry: FunctionRegistry;
  textMessageHandlers: TextMessageHandlerRegistry;
  adminActionRouter?: AdminActionRouterPort;
  adminActionRegistry?: AdminActionRegistry;
  accessStore?: AccessStore;
  sessionStore?: SessionStore;
  agentRuntime?: AgentRuntime;
  traceStore?: AgentTraceStore;
  lastErrorStore: LastErrorStore;
  lastRouteStore: LastRouteStore;
  routeObserver?: RouteObserver;
  observabilityHmacKey?: string;
  firstSuccessStore?: FirstSuccessStore;
  completionObserver?: FunctionCompletionObserver;
  now?: () => Date;
}

export interface AgentTextTurnInput {
  profile: BotProfileConfig;
  configuredFunctions?: readonly FunctionName[];
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  engagement?: string;
  allowRouting?: boolean;
  authorizeFunctions?(functionNames: readonly FunctionName[]): Promise<readonly FunctionName[]>;
  accountAdministrator?(): boolean;
}

export interface AgentTurnRuntime {
  handleTextTurn(input: AgentTextTurnInput): Promise<FunctionExecutionResult | undefined>;
}

export function createAgentTurnRuntime(options: AgentTurnRuntimeOptions): AgentTurnRuntime {
  const now = options.now ?? (() => new Date());
  const completionObserver =
    options.completionObserver ??
    createFunctionCompletionObserver({
      accessStore: options.accessStore,
      routeObserver: options.routeObserver,
      firstSuccessStore: options.firstSuccessStore,
      observabilityHmacKey: options.observabilityHmacKey,
      now
    });

  return {
    async handleTextTurn(originalInput) {
      const input = await authorizePendingContinuation(options, withAccountAdmin(originalInput));
      const steps: AgentTurnTraceStep[] = [];
      const context: FunctionHandlerContext = {
        profile: input.profile,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName,
        requesterIsAdmin: input.requesterIsAdmin
      };
      const matched = await matchTextContinuation(
        input.event,
        input.profile,
        Object.fromEntries(
          Object.entries(options.textMessageHandlers).filter(
            ([, handler]) => handler.turnStage !== "attachment"
          )
        ),
        input.requesterDisplayName,
        input.requesterIsAdmin,
        input.authorizeFunctions,
        input.configuredFunctions
      );
      if (matched) {
        const startedAt = Date.now();
        try {
          const handlerContext = { ...context, profile: matched.profile };
          const result = await matched.handler.handle(
            { text: input.event.message?.text ?? "" },
            handlerContext
          );
          if (!result) return finish(options.traceStore, input, steps, undefined, now);
          const action = result.executedAction ?? matched.handler.capability;
          const durationMs = elapsedMs(startedAt);
          steps.push({
            phase: "text_handler",
            outcome: matched.name,
            action,
            ok: result.ok,
            durationMs
          });
          await emitRouteEvent(options.routeObserver, {
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
            await recordFunctionWriteAudit(
              options.accessStore,
              handlerContext,
              result.executedAction,
              result
            );
          }
          if (action && result.agentResource) {
            await options.agentRuntime?.afterFunctionResult({
              context: handlerContext,
              action,
              arguments: {},
              result
            });
          }
          const completed = result.executedAction
            ? await completionObserver.complete({
                context: handlerContext,
                action: result.executedAction,
                result,
                durationMs,
                clarificationCount: 0
              })
            : result;
          await options.lastRouteStore.record({
            requestId: input.requestId,
            occurredAt: now().toISOString(),
            profileName: input.profile.name,
            sourceType: input.event.source.type,
            phase: "function",
            action,
            ok: result.ok,
            durationMs
          });
          return finish(options.traceStore, input, steps, completed, now);
        } catch (error) {
          await options.lastErrorStore.record({
            requestId: input.requestId,
            occurredAt: now().toISOString(),
            profileName: input.profile.name,
            sourceType: input.event.source.type,
            phase: "function",
            action: matched.handler.capability,
            errorName: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error)
          });
          return { ok: false, replyText: requestFailedMessage(input.requestId) };
        }
      }

      if (input.allowRouting === false) return undefined;
      const adminResult = await handleNaturalLanguageAdminAction({
        text: input.event.message?.text ?? "",
        profile: input.profile,
        event: input.event,
        adminActionRouter: options.adminActionRouter,
        adminActionRegistry: options.adminActionRegistry,
        accessStore: options.accessStore,
        routeObserver: options.routeObserver,
        lastRouteStore: options.lastRouteStore,
        requestId: input.requestId,
        steps,
        requesterIsAdmin: input.requesterIsAdmin === true,
        now
      });
      return finish(options.traceStore, input, steps, adminResult, now);
    }
  };
}

async function authorizePendingContinuation(
  options: AgentTurnRuntimeOptions,
  input: AgentTextTurnInput
): Promise<AgentTextTurnInput> {
  if (!options.sessionStore || !input.authorizeFunctions) return input;
  const lookup = {
    profileName: input.profile.name,
    source: input.event.source,
    requesterUserId: input.event.source.userId
  };
  const [pendingFunction, pendingResolution] = await Promise.all([
    options.sessionStore.findPendingFunction(lookup),
    options.sessionStore.findPendingResolution(lookup)
  ]);
  const configured = new Set(
    input.configuredFunctions ?? [
      ...input.profile.enabledFunctions,
      ...input.profile.permissionRequiredFunctions
    ]
  );
  const requested = [pendingFunction?.action, pendingResolution?.capability].filter(
    (name): name is FunctionName => Boolean(name && configured.has(name))
  );
  if (!requested.length) return input;
  let allowed: readonly FunctionName[] = [];
  try {
    allowed = await input.authorizeFunctions(requested);
  } catch {
    // Restricted continuations fail closed.
  }
  return {
    ...input,
    profile: {
      ...input.profile,
      enabledFunctions: Array.from(
        new Set([
          ...input.profile.enabledFunctions,
          ...allowed.filter((name) => configured.has(name))
        ])
      )
    }
  };
}

function withAccountAdmin(input: AgentTextTurnInput): AgentTextTurnInput {
  return input.accountAdministrator?.() && !input.requesterIsAdmin
    ? { ...input, requesterIsAdmin: true }
    : input;
}

async function recordFunctionWriteAudit(
  accessStore: AccessStore | undefined,
  context: FunctionHandlerContext,
  action: FunctionName,
  result: FunctionExecutionResult
): Promise<void> {
  const definition = getFunctionDefinition(action);
  const actorUserId = context.event.source.userId;
  if (
    !accessStore ||
    !actorUserId ||
    !result.ok ||
    !definition ||
    definition.sideEffectLevel === "read"
  ) {
    return;
  }
  await accessStore.recordAudit({
    profileName: context.profile.name,
    actorUserId,
    action: `function.${definition.sideEffectLevel}.${result.writePhase ?? "preview"}`,
    targetType: "function",
    targetId: action,
    metadata: { sourceType: context.event.source.type }
  });
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
  requesterIsAdmin: boolean;
  now: () => Date;
}): Promise<FunctionExecutionResult | undefined> {
  if (!matchesNaturalLanguageAdminActionHint(input.text) || !input.accessStore) return undefined;
  if (!input.requesterIsAdmin) return undefined;
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
    durationMs: routeDurationMs
  });
  await input.lastRouteStore.record({
    requestId: input.requestId,
    occurredAt: input.now().toISOString(),
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    phase: "admin_route",
    provider: route.provider,
    outcome: route.type,
    action: route.type === "execute" ? route.action : undefined,
    reason: route.type === "deny" ? route.reason : undefined,
    durationMs: routeDurationMs
  });
  if (route.type === "deny") {
    return { ok: true, replyText: adminNaturalLanguageUnsupportedReply() };
  }

  const result = await input.adminActionRegistry.execute({
    action: route.action,
    profile: input.profile,
    event: input.event,
    arguments: route.arguments,
    requesterIsAdmin: true
  });
  input.steps.push({
    phase: "admin_action_result",
    outcome: "executed",
    action: route.action,
    ok: result.ok
  });
  await emitRouteEvent(input.routeObserver, {
    kind: "admin_action_result",
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    requestId: input.requestId,
    action: route.action,
    ok: result.ok
  });
  await input.lastRouteStore.record({
    requestId: input.requestId,
    occurredAt: input.now().toISOString(),
    profileName: input.profile.name,
    sourceType: input.event.source.type,
    phase: "admin_action",
    action: route.action,
    ok: result.ok
  });
  return result;
}

async function finish(
  traceStore: AgentTraceStore | undefined,
  input: AgentTextTurnInput,
  steps: AgentTurnTraceStep[],
  result: FunctionExecutionResult | undefined,
  now: () => Date
): Promise<FunctionExecutionResult | undefined> {
  if (traceStore && steps.length) {
    const record: AgentTurnTraceRecord = {
      requestId: input.requestId,
      occurredAt: now().toISOString(),
      profileName: input.profile.name,
      sourceType: input.event.source.type,
      steps
    };
    await traceStore.record(record);
  }
  return result;
}

async function emitRouteEvent(
  observer: RouteObserver | undefined,
  event: RouteObserverEvent
): Promise<void> {
  if (!observer) return;
  try {
    await observer(sanitizeActionTelemetryEvent(event) as RouteObserverEvent);
  } catch {
    // Observability must not change LINE webhook behavior.
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function adminNaturalLanguageUnsupportedReply(): string {
  return "目前還不能用自然語言執行這個管理操作，請使用 /help admin。";
}

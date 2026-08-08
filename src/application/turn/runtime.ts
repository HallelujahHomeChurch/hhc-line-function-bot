import type { AccessStore } from "../../access/types.js";
import type { AdminActionRegistry } from "../../actions/admin-registry.js";
import { projectEffectiveCapabilities } from "../capabilities/effective-capability-projection.js";
import {
  enabledNaturalLanguageAdminActionNames,
  matchesGroupScopedNaturalLanguageAdminActionHint,
  matchesNaturalLanguageAdminActionHint
} from "../../actions/catalog.js";
import { createSlotClarificationResult } from "../../agent/slot-clarification.js";
import type { ActiveTaskContext } from "../../agent/active-task.js";
import { applyActiveTaskTransition } from "../../agent/active-task-transition.js";
import type { ControlledAgentRouter } from "../../agent/controlled-agent-router.js";
import type { ValidatedAgentPlan } from "../../agent/plan-validator.js";
import { messages, requestFailedMessage } from "../../messages.js";
import {
  createControlledSmallTalkReply,
  smallTalkCategoryFromArguments,
  smallTalkCategoryFromText
} from "../../small-talk.js";
import { createIntroReply } from "../../intro.js";
import { sanitizeActionTelemetryEvent } from "../../observability/action-telemetry.js";
import { stateAgeBucket } from "../../observability/retrieval-diagnostics.js";
import { emitProductEvent } from "../../observability/product-events.js";
import type { FirstSuccessStore } from "../../observability/first-success-store.js";
import type { LastErrorStore } from "../../observability/last-error-store.js";
import type { LastRouteRecord, LastRouteStore } from "../../observability/last-route-store.js";
import { normalizeFunctionArguments } from "../../functions/argument-normalization.js";
import { argumentGroundingCounts } from "../../agent/argument-authority.js";
import { getFunctionDefinition } from "../../functions/definitions.js";
import { withRequesterDisplayName } from "../../requester-personalization.js";
import type { SessionStore } from "../../state/session-store.js";
import type { InFlightStore } from "../../in-flight/in-flight-store.js";
import type {
  ConversationWindowScope,
  ConversationWindowStore
} from "../../agent/context-manager.js";
import type {
  BotProfileConfig,
  FunctionName,
  JsonRecord,
  LineEvent,
  ModelProviderLane,
  ModelProviderName,
  RouteProviderName,
  TextGenerationProvider
} from "../../types.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionRegistry,
  TextMessageHandlerRegistry
} from "../contracts/function-execution.js";
import type {
  AdminActionRouterPort,
  RouteObserver,
  RouteObserverEvent,
  RouteResult
} from "../contracts/routing.js";
import type { AgentRuntime } from "../../agent/agent-runtime.js";
import {
  createCapabilityResolution,
  selectCapabilityResolutionCandidate
} from "../../agent/capability-resolution.js";
import { buildCapabilityCandidates } from "../../agent/capability-candidates.js";
import { projectAgentReply } from "../../agent/response-projector.js";
import {
  type AgentTraceStore,
  type AgentTurnTraceRecord,
  type AgentTurnTraceStep
} from "../../agent/trace-store.js";
import { resolveControlledPlan } from "./stages/controlled-plan-stage.js";
import { runCapabilityResolutionStage } from "./stages/capability-resolution-stage.js";
import { runAdminActionStage } from "./stages/admin-action-stage.js";
import {
  buildInFlightKey,
  IN_FLIGHT_TTL_MS,
  releaseInFlight,
  turnSourceKey
} from "./stages/function-execution-stage.js";
import { matchTextContinuation } from "./stages/text-continuation-stage.js";
import { runTurnStages } from "./coordinator.js";
import type { TurnStage, TurnStageName } from "./contracts.js";
import { applyResultGuidance, controlledResultStateForValidatorDeny } from "./result-guidance.js";
import {
  createControlledCompletionObserver,
  type ControlledCompletionObserver
} from "./completion-observer.js";

export interface AgentTurnRuntimeOptions {
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
  conversationWindowStore?: ConversationWindowStore;
  controlledAgentRouter?: ControlledAgentRouter;
  timeZone?: string;
  now?: () => Date;
  observabilityHmacKey?: string;
  firstSuccessStore?: FirstSuccessStore;
  completionObserver?: ControlledCompletionObserver;
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
    createControlledCompletionObserver({
      accessStore: options.accessStore,
      routeObserver: options.routeObserver,
      firstSuccessStore: options.firstSuccessStore,
      observabilityHmacKey: options.observabilityHmacKey,
      now
    });

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
      input = await applyContinuationFunctionAuthorization(options, input);
      input = withMemoizedAccountAdministrator(input);
      const steps: AgentTurnTraceStep[] = [];
      const text = input.event.message?.text ?? "";
      const context: FunctionHandlerContext = {
        profile: input.profile,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName,
        requesterIsAdmin: input.requesterIsAdmin
      };

      const continueStage = Symbol("continue_turn_stage");
      type StageActionResult = FunctionExecutionResult | undefined | typeof continueStage;
      const stage = (
        name: TurnStageName,
        run: () => Promise<StageActionResult>
      ): TurnStage<void, FunctionExecutionResult | undefined> => ({
        name,
        async run() {
          const result = await run();
          return result === continueStage ? { kind: "continue" } : { kind: "handled", result };
        }
      });
      let routingText = text;
      let routingFunctions: FunctionName[] = [...input.profile.enabledFunctions];
      let activeTask: ActiveTaskContext | undefined;
      let plannedRoute: RouteResult | undefined;
      let controlledContinuationAuthorized = false;

      const textContinuationStage = stage("text_continuation", async () => {
        const textMessageHandler = await matchTextContinuation(
          input.event,
          input.profile,
          options.textMessageHandlers,
          input.requesterDisplayName,
          input.requesterIsAdmin,
          input.authorizeFunctions,
          input.configuredFunctions
        );
        if (textMessageHandler) {
          input = withMemoizedAccountAdministrator(input);
          context.requesterIsAdmin = input.requesterIsAdmin;
          const handlerProfile = textMessageHandler.profile;
          const handlerContext: FunctionHandlerContext = {
            ...context,
            profile: handlerProfile
          };
          const startedAt = Date.now();
          const result = await textMessageHandler.handler.handle(
            { text },
            {
              profile: handlerProfile,
              event: input.event,
              requestId: input.requestId,
              requesterDisplayName: input.requesterDisplayName,
              requesterIsAdmin: input.requesterIsAdmin
            }
          );
          const durationMs = elapsedMs(startedAt);
          steps.push({
            phase: "text_handler",
            outcome: textMessageHandler.name,
            ok: result?.ok,
            durationMs
          });
          await emitRouteEvent(options.routeObserver, {
            kind: "text_handler",
            profileName: input.profile.name,
            sourceType: input.event.source.type,
            requestId: input.requestId,
            handler: textMessageHandler.name,
            ok: result?.ok,
            durationMs
          });
          let transitionFunctionName: FunctionName | undefined;
          if (result) {
            if (result.executedAction) {
              await recordFunctionWriteAudit(
                options.accessStore,
                handlerContext,
                result.executedAction,
                {},
                result
              );
            }
            const textHandlerFunctionName = functionNameForAgentResource(
              result.agentResource?.resourceType,
              handlerProfile.enabledFunctions
            );
            transitionFunctionName = result.executedAction ?? textHandlerFunctionName;
            if (transitionFunctionName) {
              const previousTask = await readActiveTask(options, input, true);
              if (options.traceStore) {
                steps.push({
                  phase: "active_task",
                  outcome: previousTask ? "present" : "missing",
                  action: previousTask?.currentCapability,
                  lifecycleOutcome: previousTask ? "read" : "missing"
                });
              }
              const lifecycleOutcome = await applyActiveTaskTransition({
                store: options.conversationWindowStore,
                scope: activeTaskScope(options.conversationWindowStore, input),
                capability: transitionFunctionName,
                enabledFunctions: handlerProfile.enabledFunctions,
                result,
                now: now(),
                ttlMs: activeTaskTtlMs(input.profile),
                previousTask
              });
              steps.push(resultEnvelopeTraceStep(result));
              steps.push({
                phase: "active_task",
                outcome: "transition",
                action: transitionFunctionName,
                lifecycleOutcome
              });
            }
            if (textHandlerFunctionName) {
              await options.agentRuntime?.afterFunctionResult({
                context: handlerContext,
                action: textHandlerFunctionName,
                arguments: {},
                result
              });
            }
          }
          const completedResult =
            result && transitionFunctionName
              ? await completionObserver.complete({
                  context: handlerContext,
                  action: transitionFunctionName,
                  result,
                  durationMs,
                  clarificationCount: 0
                })
              : result;
          return finish(input, steps, completedResult);
        }

        if (input.allowRouting === false) {
          return undefined;
        }
        return continueStage;
      });

      const capabilityResolutionStage = stage("capability_resolution", async () => {
        const resolutionStage = await runCapabilityResolutionStage({
          sessionStore: options.sessionStore,
          profile: input.profile,
          event: input.event,
          text
        });
        if (resolutionStage.kind === "handled") {
          steps.push({ phase: resolutionStage.tracePhase, outcome: "handled", ok: true });
          return finish(input, steps, resolutionStage.result);
        }
        routingText = resolutionStage.routingText;
        routingFunctions = resolutionStage.routingFunctions;
        return continueStage;
      });

      const adminActionStage = stage("admin_action", async () => {
        const adminStage = await runAdminActionStage(() =>
          handleNaturalLanguageAdminAction({
            text: routingText,
            profile: input.profile,
            event: input.event,
            adminActionRouter: options.adminActionRouter,
            adminActionRegistry: options.adminActionRegistry,
            accessStore: options.accessStore,
            routeObserver: options.routeObserver,
            lastRouteStore: options.lastRouteStore,
            requestId: input.requestId,
            steps,
            requesterIsAdmin: input.requesterIsAdmin === true
          })
        );
        if (adminStage.kind === "handled") {
          return finish(input, steps, adminStage.result);
        }
        return continueStage;
      });

      const controlledPlanStage = stage("controlled_plan", async () => {
        const routeStartedAt = Date.now();
        let plan: ValidatedAgentPlan;
        try {
          activeTask = await readActiveTask(options, input, true);
          if (options.traceStore) {
            steps.push({
              phase: "active_task",
              outcome: activeTask ? "present" : "missing",
              action: activeTask?.currentCapability,
              lifecycleOutcome: activeTask ? "read" : "missing",
              stateAgeBucket: activeTask ? stateAgeBucket(activeTask.createdAt, now()) : undefined
            });
          }
          plan = await resolveControlledPlan(
            options.controlledAgentRouter,
            input,
            routingText,
            activeTask,
            options.traceStore ? steps : undefined,
            routingFunctions
          );
          input = withMemoizedAccountAdministrator(input);
          context.requesterIsAdmin = input.requesterIsAdmin;
          if (
            (plan.disposition === "execute" || plan.disposition === "collect") &&
            !input.profile.enabledFunctions.includes(plan.capability)
          ) {
            const allowed = (await input.authorizeFunctions?.([plan.capability])) ?? [];
            if (allowed.includes(plan.capability)) {
              input = {
                ...input,
                profile: {
                  ...input.profile,
                  enabledFunctions: [...input.profile.enabledFunctions, plan.capability]
                }
              };
              context.profile = input.profile;
            } else {
              plan = { disposition: "deny", reasonCode: "function_disabled" };
            }
          }
        } catch {
          plan = { disposition: "clarify", reasonCode: "planner_unavailable" };
        }
        steps.push(controlledTraceStep(plan));
        if (plan.disposition === "collect") {
          const slotCollection = await createSlotClarificationResult({
            sessionStore: options.sessionStore,
            action: plan.capability,
            arguments: plan.arguments,
            context,
            requestId: input.requestId,
            now: now()
          });
          if (slotCollection) {
            steps.push({
              phase: "slot_clarification",
              outcome: "handled",
              action: plan.capability,
              query: queryMarker(plan.arguments)
            });
            await emitProductEvent(options.routeObserver, {
              eventName: "clarification_requested",
              requestId: input.requestId,
              profileName: input.profile.name,
              source: input.event.source,
              hmacKey: options.observabilityHmacKey,
              action: plan.capability,
              clarificationCount: 1
            });
            return finish(
              input,
              steps,
              applyResultGuidance({
                state: "missing_input",
                result: slotCollection,
                definition: getFunctionDefinition(plan.capability)
              })
            );
          }
          return finish(
            input,
            steps,
            controlledClarificationResult(
              {
                disposition: "clarify",
                capability: plan.capability,
                reasonCode: "missing_required_slot"
              },
              context
            )
          );
        }
        if (plan.disposition === "clarify") {
          if (plan.candidateCapabilities && plan.candidateCapabilities.length > 1) {
            const resolution = await createCapabilityResolution({
              sessionStore: options.sessionStore,
              id: input.requestId,
              profileName: input.profile.name,
              source: input.event.source,
              requesterUserId: input.event.source.userId,
              originalText: routingText,
              candidates: plan.candidateCapabilities,
              now: now()
            });
            if (resolution) {
              steps.push({ phase: "capability_resolution", outcome: "created", ok: true });
              return finish(input, steps, resolution);
            }
          }
          return finish(input, steps, controlledClarificationResult(plan, context));
        }
        controlledContinuationAuthorized =
          plan.disposition === "execute" && plan.reasonCode === "active_task_refinement";
        plannedRoute = controlledPlanToRoute(plan, input, routingText);
        const route = plannedRoute;

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
            if (introVariantRouteArgument(route.arguments) === "identity") {
              const result = await createControlledSmallTalkReply({
                profile: input.profile,
                text,
                category: "persona",
                generator: options.textGenerator,
                fallbackGenerator: options.textFallbackGenerator
              });
              return finish(input, steps, result);
            }
            const intro = createIntroReply(
              projectEffectiveCapabilities({
                context: {
                  profile: input.profile,
                  authorized: true,
                  requesterIsAdmin: Boolean(input.requesterIsAdmin),
                  sourceType:
                    input.event.source.type === "user"
                      ? "user"
                      : input.event.source.type === "group"
                        ? "group"
                        : "room"
                }
              }),
              text,
              {
                force: true,
                variant: introVariantRouteArgument(route.arguments),
                profile: input.profile
              }
            );
            return finish(
              input,
              steps,
              intro ?? { ok: false, replyText: requestFailedMessage(input.requestId) }
            );
          }
          if (route.action === "small_talk") {
            const category = smallTalkCategoryFromText(text);
            if (!category && input.profile.allowedProviders.length === 0) {
              return finish(input, steps, { ok: true, replyText: messages.providerFreeUnknown });
            }
            const result = await createControlledSmallTalkReply({
              profile: input.profile,
              text,
              category: category ?? smallTalkCategoryFromArguments(route.arguments),
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
          return finish(
            input,
            steps,
            applyResultGuidance({
              state: controlledResultStateForValidatorDeny(route.reason),
              result: { ok: true, replyText: "" }
            })
          );
        }
        return continueStage;
      });

      const functionExecutionStage = stage("function_execution", async () => {
        const route = plannedRoute;
        if (!route || route.type !== "execute") {
          throw new Error("Function execution stage requires an executable route");
        }
        const normalizedArguments = normalizeFunctionArguments(route.action, route.arguments, {
          text: routingText
        });
        steps.push({
          phase: "argument_grounding",
          outcome: "validated",
          action: route.action,
          ...argumentGroundingCounts(route.arguments, normalizedArguments)
        });
        const handler = options.functionRegistry[route.action];
        if (!handler) {
          return finish(
            input,
            steps,
            applyResultGuidance({
              state: "unavailable",
              result: { ok: true, replyText: messages.functionNotConfigured },
              definition: getFunctionDefinition(route.action)
            })
          );
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
          await emitProductEvent(options.routeObserver, {
            eventName: "clarification_requested",
            requestId: input.requestId,
            profileName: input.profile.name,
            source: input.event.source,
            hmacKey: options.observabilityHmacKey,
            action: route.action,
            clarificationCount: 1
          });
          return finish(
            input,
            steps,
            applyResultGuidance({
              state: "missing_input",
              result: slotClarification,
              definition: getFunctionDefinition(route.action)
            })
          );
        }

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
            await emitProductEvent(options.routeObserver, {
              eventName: "retry_observed",
              requestId: input.requestId,
              profileName: input.profile.name,
              source: input.event.source,
              hmacKey: options.observabilityHmacKey,
              action: route.action,
              retry: true
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
          const rawResult = await handler(normalizedArguments, {
            ...context,
            activeTask: controlledContinuationAuthorized ? activeTaskView(activeTask) : undefined
          });
          const controlledResult = projectAgentReply({
            capability: route.action,
            text: routingText,
            result: rawResult
          });
          {
            const lifecycleOutcome = await applyActiveTaskTransition({
              store: options.conversationWindowStore,
              scope: activeTaskScope(options.conversationWindowStore, input),
              capability: route.action,
              enabledFunctions: input.profile.enabledFunctions,
              result: controlledResult,
              now: now(),
              ttlMs: activeTaskTtlMs(input.profile),
              previousTask: activeTask
            });
            steps.push(resultEnvelopeTraceStep(controlledResult));
            steps.push({
              phase: "active_task",
              outcome: "transition",
              action: route.action,
              lifecycleOutcome
            });
          }
          await recordFunctionWriteAudit(
            options.accessStore,
            context,
            route.action,
            normalizedArguments,
            controlledResult
          );
          await options.agentRuntime?.afterFunctionResult({
            context,
            action: route.action,
            arguments: normalizedArguments,
            result: controlledResult
          });
          const durationMs = elapsedMs(functionStartedAt);
          const result = await completionObserver.complete({
            context,
            action: route.action,
            result: controlledResult,
            durationMs,
            clarificationCount: 0
          });
          const ownedResult = { ...result, executedAction: route.action };
          steps.push({
            phase: "function",
            outcome: "executed",
            action: route.action,
            ok: result.ok,
            query: queryMarker(normalizedArguments),
            durationMs,
            ...result.diagnostics
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
            durationMs,
            ...result.diagnostics
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
          return finish(input, steps, ownedResult);
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
          return finish(
            input,
            steps,
            applyResultGuidance({
              state: "error",
              result: {
                ok: false,
                replyText: requestFailedMessage(input.requestId)
              },
              definition: getFunctionDefinition(route.action)
            })
          );
        } finally {
          if (inFlight) {
            await releaseInFlight(options.inFlightStore, inFlight.key);
          }
        }
      });

      const outcome = await runTurnStages(
        [
          functionExecutionStage,
          adminActionStage,
          textContinuationStage,
          controlledPlanStage,
          capabilityResolutionStage
        ],
        undefined
      );
      return outcome.kind === "handled" ? outcome.result : undefined;
    }
  };
}

async function applyContinuationFunctionAuthorization(
  options: AgentTurnRuntimeOptions,
  input: AgentTextTurnInput
): Promise<AgentTextTurnInput> {
  if (!input.authorizeFunctions) {
    return input;
  }
  const restricted = new Set(input.profile.permissionRequiredFunctions);
  const effective = new Set(input.profile.enabledFunctions);
  const configured = new Set(
    input.configuredFunctions ?? [
      ...input.profile.enabledFunctions,
      ...input.profile.permissionRequiredFunctions
    ]
  );
  const lookup = {
    profileName: input.profile.name,
    source: input.event.source,
    requesterUserId: input.event.source.userId
  };
  const [
    pendingFunction,
    pendingAttachment,
    pendingResolution,
    pendingCapabilityResolution,
    activeTask
  ] = await Promise.all([
    options.sessionStore?.findPendingFunction(lookup),
    options.sessionStore?.findPendingAttachment(lookup),
    options.sessionStore?.findPendingResolution(lookup),
    options.sessionStore?.findPendingCapabilityResolution(lookup),
    readActiveTask(options, input, false)
  ]);
  const source = input.event.source.type;
  const hasContinuation = Boolean(
    pendingFunction ||
    pendingAttachment ||
    pendingResolution ||
    pendingCapabilityResolution ||
    activeTask
  );
  const explicitSwitchCandidates =
    hasContinuation && (source === "user" || source === "group")
      ? buildCapabilityCandidates({
          text: input.event.message?.text ?? "",
          enabledFunctions: [...configured],
          source,
          knowledgeSources: [],
          maxCandidates: 5
        }).map(({ capability }) => capability)
      : [];
  const selectedCapability = pendingCapabilityResolution
    ? selectCapabilityResolutionCandidate(
        pendingCapabilityResolution,
        input.event.message?.text ?? ""
      )?.capability
    : undefined;
  const requested = Array.from(
    new Set(
      [
        pendingFunction?.action,
        pendingAttachment?.action,
        pendingResolution?.capability,
        activeTask?.currentCapability,
        selectedCapability,
        ...explicitSwitchCandidates
      ].filter(
        (functionName): functionName is FunctionName =>
          functionName !== undefined &&
          configured.has(functionName) &&
          (restricted.has(functionName) || !effective.has(functionName))
      )
    )
  );
  if (requested.length === 0) return input;

  let allowed: readonly FunctionName[] = [];
  try {
    allowed = await input.authorizeFunctions(requested);
  } catch {
    // Restricted continuations fail closed; public capabilities remain available.
  }
  const allowedSet = new Set(allowed);
  const publicFunctions = input.profile.enabledFunctions.filter(
    (functionName) => !restricted.has(functionName)
  );
  return withMemoizedAccountAdministrator({
    ...input,
    profile: {
      ...input.profile,
      enabledFunctions: [
        ...publicFunctions,
        ...requested.filter((functionName) => allowedSet.has(functionName))
      ]
    }
  });
}

function withMemoizedAccountAdministrator(input: AgentTextTurnInput): AgentTextTurnInput {
  return input.accountAdministrator?.() && !input.requesterIsAdmin
    ? { ...input, requesterIsAdmin: true }
    : input;
}

async function recordFunctionWriteAudit(
  accessStore: AccessStore | undefined,
  context: FunctionHandlerContext,
  action: FunctionName,
  args: JsonRecord,
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
    action: `function.${definition.sideEffectLevel}.${result.writePhase ?? (args.confirm === true ? "commit" : "preview")}`,
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
}): Promise<FunctionExecutionResult | undefined> {
  if (!matchesNaturalLanguageAdminActionHint(input.text) || !input.accessStore) {
    return undefined;
  }

  if (!input.requesterIsAdmin) {
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
    arguments: route.arguments,
    requesterIsAdmin: input.requesterIsAdmin
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

function resultEnvelopeTraceStep(result: FunctionExecutionResult): AgentTurnTraceStep {
  const envelope = result.agentResult;
  return {
    phase: "result_envelope",
    resultStatus: envelope?.status ?? "unavailable",
    anchorCount: Object.keys(envelope?.anchors ?? {}).length,
    entityTypes: [...new Set((envelope?.entities ?? []).map(({ type }) => type))],
    ...result.diagnostics
  };
}

function controlledTraceStep(plan: ValidatedAgentPlan): AgentTurnTraceStep {
  return {
    phase: "controlled_route",
    outcome: plan.disposition,
    action:
      plan.disposition === "execute" ||
      plan.disposition === "collect" ||
      plan.disposition === "clarify"
        ? plan.capability
        : undefined,
    reason: plan.reasonCode
  };
}

function controlledPlanToRoute(
  plan: Exclude<ValidatedAgentPlan, { disposition: "clarify" | "collect" }>,
  input: AgentTextTurnInput,
  text: string
): RouteResult {
  if (plan.disposition === "chat") {
    return {
      type: "respond",
      action: "small_talk",
      arguments: { category: smallTalkCategoryFromText(text) },
      provider: "router",
      lane: "function_routing"
    };
  }
  if (plan.disposition === "deny") {
    return {
      type: "deny",
      reason: plan.reasonCode,
      provider: "router",
      lane: "function_routing"
    };
  }

  const definition = getFunctionDefinition(plan.capability);
  if (!input.profile.enabledFunctions.includes(plan.capability)) {
    return {
      type: "deny",
      reason: "function_disabled",
      provider: "router",
      lane: "function_routing"
    };
  }
  if (!definition?.allowedSources.includes(input.event.source.type as "user" | "group")) {
    return {
      type: "deny",
      reason: "source_not_allowed",
      provider: "router",
      lane: "function_routing"
    };
  }
  return {
    type: "execute",
    action: plan.capability,
    arguments: plan.arguments,
    provider: "router",
    lane: "function_routing"
  };
}

function controlledClarificationResult(
  plan: Extract<ValidatedAgentPlan, { disposition: "clarify" }>,
  context: FunctionHandlerContext
): FunctionExecutionResult {
  if (plan.reasonCode === "retrieval_unavailable") {
    return applyResultGuidance({
      state: "unavailable",
      result: {
        ok: true,
        replyText: withRequesterDisplayName(context, "暫時無法查詢，請稍後再試。")
      }
    });
  }
  const definition = plan.capability ? getFunctionDefinition(plan.capability) : undefined;
  const slot = definition?.requiredSlots[0];
  const replyText =
    definition?.clarificationPrompt ?? "請再告訴我想查哪個功能，以及要找的名稱、日期或主題。";
  const result = {
    ok: true,
    replyText: withRequesterDisplayName(context, replyText),
    quickReplies: slot?.quickReplies?.map((item) => ({
      label: item.label,
      action: { type: "message" as const, label: item.label, text: item.text }
    }))
  };
  return plan.reasonCode === "missing_required_slot"
    ? applyResultGuidance({
        state: "missing_input",
        result,
        definition
      })
    : result;
}

async function readActiveTask(
  options: AgentTurnRuntimeOptions,
  input: AgentTextTurnInput,
  clearInvalid: boolean
): Promise<ActiveTaskContext | undefined> {
  const scope = activeTaskScope(options.conversationWindowStore, input);
  if (!scope || !options.conversationWindowStore) return undefined;
  const task = await options.conversationWindowStore.activeTask(scope);
  if (!task) return undefined;
  const definition = getFunctionDefinition(task.currentCapability);
  const valid = Boolean(
    input.profile.enabledFunctions.includes(task.currentCapability) &&
    definition?.allowedSources.includes(input.event.source.type as "user" | "group")
  );
  if (valid) return task;
  if (clearInvalid) await options.conversationWindowStore.clearActiveTask(scope);
  return undefined;
}

function activeTaskScope(
  store: ConversationWindowStore | undefined,
  input: AgentTextTurnInput
): ConversationWindowScope | undefined {
  const source = turnSourceKey(input.event.source);
  const requesterUserId = input.event.source.userId;
  if (!store || !source || !requesterUserId) return undefined;
  return { profileName: input.profile.name, sourceKey: source, requesterUserId };
}

function activeTaskTtlMs(profile: BotProfileConfig): number {
  return Math.max(60, profile.agentRuntime?.taskFrameSeconds ?? 600) * 1000;
}

function activeTaskView(
  activeTask: ActiveTaskContext | undefined
): FunctionHandlerContext["activeTask"] {
  if (!activeTask) return undefined;
  return {
    capability: activeTask.currentCapability,
    anchors: { ...activeTask.anchors },
    references: activeTask.references ? { ...activeTask.references } : undefined,
    entities: activeTask.entities.map((entity) => ({
      ...entity,
      ...(entity.aliases ? { aliases: [...entity.aliases] } : {})
    })),
    supportedOperations: [...activeTask.supportedOperations]
  };
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

function functionNameForAgentResource(
  resourceType: string | undefined,
  enabledFunctions: FunctionName[]
): FunctionName | undefined {
  switch (resourceType) {
    case "ppt_slide":
      return "find_ppt_slides";
    case "sheet_music":
      return enabledFunctions.includes("find_sheet_music") ? "find_sheet_music" : undefined;
    case "general_resource":
      return enabledFunctions.includes("find_resource") ? "find_resource" : undefined;
    default:
      return undefined;
  }
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

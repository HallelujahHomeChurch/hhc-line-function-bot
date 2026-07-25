import type { ActiveTaskContext } from "../../../agent/active-task.js";
import type { ControlledAgentRouter } from "../../../agent/controlled-agent-router.js";
import type { ValidatedAgentPlan } from "../../../agent/plan-validator.js";
import { profileCapabilityHints } from "../../../agent/profile-capability-hints.js";
import type { AgentTurnTraceStep } from "../../../agent/trace-store.js";
import type { BotProfileConfig, FunctionName, LineEvent, LineSource } from "../../../types.js";

interface ControlledPlanInput {
  profile: BotProfileConfig;
  event: LineEvent;
}

export async function resolveControlledPlan(
  router: ControlledAgentRouter | undefined,
  input: ControlledPlanInput,
  text: string,
  activeTask: ActiveTaskContext | undefined,
  steps?: AgentTurnTraceStep[],
  enabledFunctions?: readonly FunctionName[]
): Promise<ValidatedAgentPlan> {
  if (!router) return { disposition: "clarify", reasonCode: "planner_unavailable" };
  try {
    const routerInput = {
      profileName: input.profile.name,
      text,
      enabledFunctions: enabledFunctions ?? input.profile.enabledFunctions,
      sourceType: input.event.source.type,
      sourceId: controlledSourceId(input.event.source),
      requesterUserId: input.event.source.userId,
      activeTask,
      capabilityHints: profileCapabilityHints(input.profile),
      maxCandidates: input.profile.controlledAgent?.maxCandidates ?? 3,
      minPlannerConfidence: input.profile.controlledAgent?.minPlannerConfidence ?? 0.65
    };
    return steps
      ? await router.resolve(routerInput, (step) => steps.push(step))
      : await router.resolve(routerInput);
  } catch {
    return { disposition: "clarify", reasonCode: "planner_unavailable" };
  }
}

function controlledSourceId(source: LineSource): string | undefined {
  if (source.type === "group") return source.groupId;
  if (source.type === "user") return source.userId;
  return undefined;
}

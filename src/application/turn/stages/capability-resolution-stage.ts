import { resumeCapabilityResolution } from "../../../agent/capability-resolution.js";
import { createQueryClarificationReply } from "../../../query-clarification.js";
import type { SessionStore } from "../../../state/session-store.js";
import type { BotProfileConfig, FunctionName, LineEvent } from "../../../types.js";
import type { FunctionExecutionResult } from "../../contracts/function-execution.js";

export type CapabilityResolutionStageResult =
  | {
      kind: "handled";
      result: FunctionExecutionResult;
      tracePhase: "capability_resolution" | "query_clarification";
    }
  | {
      kind: "continue";
      routingText: string;
      routingFunctions: FunctionName[];
    };

export async function runCapabilityResolutionStage(input: {
  sessionStore?: SessionStore;
  profile: BotProfileConfig;
  event: LineEvent;
  text: string;
}): Promise<CapabilityResolutionStageResult> {
  const resumedResolution = await resumeCapabilityResolution({
    sessionStore: input.sessionStore,
    profileName: input.profile.name,
    source: input.event.source,
    requesterUserId: input.event.source.userId,
    text: input.text,
    enabledFunctions: input.profile.enabledFunctions
  });
  if (resumedResolution.kind === "reply") {
    return {
      kind: "handled",
      result: resumedResolution.result,
      tracePhase: "capability_resolution"
    };
  }
  const routingText =
    resumedResolution.kind === "selected" ? resumedResolution.originalText : input.text;
  const routingFunctions =
    resumedResolution.kind === "selected"
      ? [resumedResolution.capability]
      : input.profile.enabledFunctions;
  const queryClarification =
    resumedResolution.kind === "selected"
      ? undefined
      : createQueryClarificationReply(input.profile, input.text);

  return queryClarification
    ? {
        kind: "handled",
        result: queryClarification,
        tracePhase: "query_clarification"
      }
    : { kind: "continue", routingText, routingFunctions };
}

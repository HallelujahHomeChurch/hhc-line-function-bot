import { getFunctionDefinition } from "../functions/definitions.js";
import type { FunctionExecutionResult, FunctionName } from "../types.js";
import { activeTaskFromResult } from "./active-task.js";
import type { ActiveTaskContext } from "./active-task.js";
import type { ConversationWindowScope, ConversationWindowStore } from "./context-manager.js";

export type ActiveTaskTransitionOutcome = "write" | "replace" | "preserve" | "clear";

const CONTINUATION_OPERATIONS = new Set(["continue", "refine", "advance", "view_full"]);

export async function applyActiveTaskTransition(input: {
  store?: ConversationWindowStore;
  scope?: ConversationWindowScope;
  capability: FunctionName;
  enabledFunctions?: readonly FunctionName[];
  result: FunctionExecutionResult;
  now: Date;
  ttlMs: number;
  previousTask?: ActiveTaskContext;
}): Promise<ActiveTaskTransitionOutcome> {
  if (
    !input.store ||
    !input.scope?.requesterUserId ||
    !input.result.ok ||
    input.result.agentResult?.status !== "success"
  ) {
    return "preserve";
  }

  const ttlMs = Math.max(1, input.ttlMs);
  const contractOperations = getFunctionDefinition(input.capability)?.agentCapability?.operations;
  const handoffTask = activeTaskFromHandoff(input);
  if (handoffTask) {
    await input.store.recordActiveTask({ scope: input.scope, task: handoffTask, ttlMs });
    return input.previousTask ? "replace" : "write";
  }
  const resultOperations = input.result.agentResult.supportedOperations ?? [];
  const continuable = Boolean(
    contractOperations?.some(
      (operation) => CONTINUATION_OPERATIONS.has(operation) && resultOperations.includes(operation)
    )
  );
  const next = continuable
    ? activeTaskFromResult(input.capability, input.result, input.now, ttlMs)
    : undefined;
  if (next) {
    await input.store.recordActiveTask({ scope: input.scope, task: next, ttlMs });
    return input.previousTask ? "replace" : "write";
  }
  await input.store.clearActiveTask(input.scope);
  return input.previousTask ? "clear" : "preserve";
}

function activeTaskFromHandoff(input: {
  capability: FunctionName;
  enabledFunctions?: readonly FunctionName[];
  result: FunctionExecutionResult;
  now: Date;
  ttlMs: number;
}): ActiveTaskContext | undefined {
  if (input.result.writePhase !== "commit") return undefined;
  const sourceContract = getFunctionDefinition(input.capability)?.agentCapability;
  const anchors = input.result.agentResult?.anchors ?? {};
  const handoff = sourceContract?.handoffs?.find(
    (candidate) =>
      candidate.on === "success" &&
      (!candidate.when ||
        Object.entries(candidate.when).every(([key, value]) => anchors[key] === value))
  );
  if (!handoff || !input.enabledFunctions?.includes(handoff.to)) return undefined;
  const targetContract = getFunctionDefinition(handoff.to)?.agentCapability;
  if (!targetContract) return undefined;
  const mappedAnchors = Object.fromEntries(
    Object.entries(handoff.map).flatMap(([targetKey, sourceKey]) =>
      anchors[sourceKey] === undefined ? [] : [[targetKey, anchors[sourceKey]]]
    )
  );
  const entityTypes = new Set(targetContract.entityTypes ?? []);
  return activeTaskFromResult(
    handoff.to,
    {
      ok: true,
      replyText: input.result.replyText,
      agentResult: {
        status: "success",
        replyText: input.result.agentResult?.replyText ?? input.result.replyText,
        anchors: mappedAnchors,
        entities: (input.result.agentResult?.entities ?? []).filter(({ type }) =>
          entityTypes.has(type)
        ),
        supportedOperations: targetContract.operations.filter((operation) =>
          CONTINUATION_OPERATIONS.has(operation)
        )
      }
    },
    input.now,
    input.ttlMs
  );
}

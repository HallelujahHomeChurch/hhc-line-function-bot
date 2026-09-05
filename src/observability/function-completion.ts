import type { CapabilityName } from "../capabilities/names.js";
import type { AccessStore } from "../access/types.js";
import { getFunctionDefinition, type FunctionDefinition } from "../capabilities/catalog.js";
import type { FirstSuccessScope, FirstSuccessStore } from "./first-success-store.js";
import { emitProductEvent, type ProductResultClass } from "./product-events.js";

import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  QuickReplyItem
} from "../application/contracts/function-execution.js";
import type { RouteObserver } from "../application/contracts/routing.js";
import { messages } from "../messages.js";

export type FunctionResultState =
  | "permission_denied"
  | "write_intent_required"
  | "unsupported"
  | "missing_input"
  | "ambiguous"
  | "not_found"
  | "unavailable"
  | "stale_allowed"
  | "success"
  | "error";

const helpQuickReply: QuickReplyItem = {
  label: "查看可用功能",
  action: {
    type: "message",
    label: "查看可用功能",
    text: "/help"
  }
};

const viewFullQuickReply: QuickReplyItem = {
  label: "查看完整結果",
  action: {
    type: "message",
    label: "查看完整結果",
    text: "查看完整結果"
  }
};

export function applyResultGuidance(input: {
  state: FunctionResultState;
  result: FunctionExecutionResult;
  definition?: FunctionDefinition;
  supportsViewFull?: boolean;
  staleAt?: string;
}): FunctionExecutionResult {
  switch (input.state) {
    case "permission_denied":
      return {
        ...input.result,
        replyText: messages.permissionDenied,
        quickReplies: [helpQuickReply]
      };
    case "write_intent_required":
      return {
        ...input.result,
        replyText: messages.explicitWriteIntentRequired,
        quickReplies: undefined
      };
    case "unsupported":
      return {
        ...input.result,
        replyText: messages.unsupported,
        quickReplies: undefined
      };
    case "missing_input": {
      const prompt =
        input.result.replyText.trim() ||
        input.definition?.clarificationPrompt ||
        messages.missingInputNextAction;
      return {
        ...input.result,
        replyText: includesRequest(prompt)
          ? prompt
          : `${prompt}\n${messages.missingInputNextAction}`,
        quickReplies: firstQuickReply(input.result)
      };
    }
    case "ambiguous":
      return input.result;
    case "not_found":
      return {
        ...input.result,
        replyText: messages.notFoundGuidance,
        quickReplies: undefined
      };
    case "unavailable":
      return {
        ...input.result,
        replyText: messages.unavailableGuidance,
        quickReplies: undefined
      };
    case "stale_allowed":
      return {
        ...input.result,
        replyText: [
          input.result.replyText,
          `資料時間：${input.staleAt ?? "較早的可用版本"}。${messages.staleGuidance}`
        ]
          .filter(Boolean)
          .join("\n"),
        quickReplies: undefined
      };
    case "error":
      return {
        ...input.result,
        replyText: input.result.replyText.trim() || messages.requestFailed,
        quickReplies: undefined
      };
    case "success":
      if (!input.supportsViewFull || input.result.quickReplies) {
        return input.result;
      }
      return {
        ...input.result,
        quickReplies: [viewFullQuickReply]
      };
  }
}

function firstQuickReply(result: FunctionExecutionResult): QuickReplyItem[] | undefined {
  const first = result.quickReplies?.[0];
  return first ? [first] : undefined;
}

function includesRequest(value: string): boolean {
  return value.includes("請");
}

const FIRST_SUCCESS_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface FunctionCompletionInput {
  context: FunctionHandlerContext;
  action: CapabilityName;
  result: FunctionExecutionResult;
  durationMs?: number;
  clarificationCount?: number;
}

export interface FunctionCompletionObserver {
  complete(input: FunctionCompletionInput): Promise<FunctionExecutionResult>;
}

export function createFunctionCompletionObserver(options: {
  accessStore?: AccessStore;
  routeObserver?: RouteObserver;
  firstSuccessStore?: FirstSuccessStore;
  observabilityHmacKey?: string;
  now?: () => Date;
}): FunctionCompletionObserver {
  const now = options.now ?? (() => new Date());

  return {
    async complete(input) {
      const result = guideFunctionResult(input.result, input.action);
      const resultClass = productResultClass(result);

      await recordGroupSuccessSummary(
        options.accessStore,
        input.context,
        input.action,
        resultClass,
        now()
      );

      const requestId = input.context.requestId;
      if (!requestId) {
        return result;
      }

      await emitProductEvent(options.routeObserver, {
        eventName: "function_completed",
        requestId,
        profileName: input.context.profile.name,
        source: input.context.event.source,
        hmacKey: options.observabilityHmacKey,
        action: input.action,
        resultClass,
        durationMs: input.durationMs,
        clarificationCount: input.clarificationCount
      });
      if (resultClass === "success") {
        await recordFirstSuccess({
          store: options.firstSuccessStore,
          observer: options.routeObserver,
          context: input.context,
          action: input.action,
          hmacKey: options.observabilityHmacKey
        });
      }
      if (result.writePhase) {
        await emitProductEvent(options.routeObserver, {
          eventName: result.writePhase === "commit" ? "write_committed" : "write_previewed",
          requestId,
          profileName: input.context.profile.name,
          source: input.context.event.source,
          hmacKey: options.observabilityHmacKey,
          action: input.action,
          resultClass,
          durationMs: input.durationMs
        });
      }

      return result;
    }
  };
}

export function productResultClass(result: FunctionExecutionResult): ProductResultClass {
  if (!result.ok) return "error";
  return result.agentResult?.status ?? "success";
}

function guideFunctionResult(
  result: FunctionExecutionResult,
  action: CapabilityName
): FunctionExecutionResult {
  const definition = getFunctionDefinition(action);
  return applyResultGuidance({
    state: functionResultState(result),
    result,
    definition,
    supportsViewFull:
      result.agentResult?.status === "success" &&
      definition?.agentCapability?.operations?.includes("view_full"),
    staleAt: result.diagnostics?.dataAsOf
  });
}

function functionResultState(result: FunctionExecutionResult): FunctionResultState {
  if (!result.ok) return "error";
  if (result.diagnostics?.freshnessStatus === "stale_allowed") return "stale_allowed";
  return result.agentResult?.status ?? "success";
}

async function recordFirstSuccess(input: {
  store?: FirstSuccessStore;
  observer?: RouteObserver;
  context: FunctionHandlerContext;
  action: CapabilityName;
  hmacKey?: string;
}): Promise<void> {
  const scope = firstSuccessScope(input.context);
  if (!input.store || !scope || !input.context.requestId) {
    return;
  }
  try {
    const result = await input.store.tryMark(scope, FIRST_SUCCESS_TTL_MS);
    if (result !== "first") {
      return;
    }
    await emitProductEvent(input.observer, {
      eventName: "first_success",
      requestId: input.context.requestId,
      profileName: input.context.profile.name,
      source: input.context.event.source,
      hmacKey: input.hmacKey,
      action: input.action,
      resultClass: "success"
    });
  } catch {
    // First-success measurement is best-effort and must never change the reply.
  }
}

function firstSuccessScope(context: FunctionHandlerContext): FirstSuccessScope | undefined {
  const source = context.event.source;
  const requesterUserId = source.userId;
  const sourceId =
    source.type === "group" ? source.groupId : source.type === "user" ? source.userId : undefined;
  if ((source.type !== "group" && source.type !== "user") || !sourceId || !requesterUserId) {
    return undefined;
  }
  return {
    profileName: context.profile.name,
    sourceType: source.type,
    sourceId,
    requesterUserId
  };
}

async function recordGroupSuccessSummary(
  accessStore: AccessStore | undefined,
  context: FunctionHandlerContext,
  action: CapabilityName,
  resultClass: ProductResultClass,
  occurredAt: Date
): Promise<void> {
  const groupId = context.event.source.groupId;
  if (
    !accessStore ||
    context.event.source.type !== "group" ||
    !groupId ||
    resultClass !== "success"
  ) {
    return;
  }
  try {
    await accessStore.recordPrincipalSuccess({
      profileName: context.profile.name,
      type: "group",
      principalId: groupId,
      functionName: action,
      occurredAt: occurredAt.toISOString()
    });
  } catch {
    // Group success summaries are observational and must never change the reply.
  }
}

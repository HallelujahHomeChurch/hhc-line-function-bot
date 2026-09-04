import type { FunctionExecutionResult, QuickReplyItem } from "../contracts/function-execution.js";
import type { FunctionDefinition } from "../../functions/definitions.js";
import { messages } from "../../messages.js";

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

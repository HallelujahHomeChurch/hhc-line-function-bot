import { getFunctionDefinition, type FunctionRequiredSlot } from "../functions/definitions.js";
import { isGenericSlotValue } from "../functions/generic-slot.js";
import { withRequesterDisplayName } from "../requester-personalization.js";
import { canCreateRequesterScopedSession } from "../state/session-safety.js";
import type { SessionStore } from "../state/session-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionName,
  JsonRecord,
  QuickReplyItem
} from "../types.js";

const PENDING_FUNCTION_TTL_MS = 10 * 60 * 1000;

export interface CreateSlotClarificationOptions {
  sessionStore: SessionStore | undefined;
  action: FunctionName;
  arguments: JsonRecord;
  context: FunctionHandlerContext;
  requestId: string;
  now: Date;
}

export function findMissingRequiredSlot(
  action: FunctionName,
  args: JsonRecord
): FunctionRequiredSlot | undefined {
  const definition = getFunctionDefinition(action);
  if (!definition) {
    return undefined;
  }
  return definition.requiredSlots.find((slot) => slotMissing(slot, args));
}

export async function createSlotClarificationResult(
  options: CreateSlotClarificationOptions
): Promise<FunctionExecutionResult | undefined> {
  if (!options.sessionStore) {
    return undefined;
  }
  const missingSlot = findMissingRequiredSlot(options.action, options.arguments);
  if (!missingSlot) {
    return undefined;
  }
  if (!canCreateRequesterScopedSession(options.context.event.source)) {
    return undefined;
  }

  await options.sessionStore.set({
    id: options.requestId,
    type: "pending_function",
    action: options.action,
    profileName: options.context.profile.name,
    requesterUserId: options.context.event.source.userId,
    source: options.context.event.source,
    arguments: options.arguments,
    expiresAt: new Date(options.now.getTime() + PENDING_FUNCTION_TTL_MS).toISOString()
  });

  return {
    ok: true,
    replyText: withRequesterDisplayName(options.context, missingSlot.prompt),
    quickReplies: missingSlot.quickReplies?.map(toMessageQuickReply)
  };
}

export function applyPendingSlotAnswer(
  action: FunctionName,
  args: JsonRecord,
  answer: string
): JsonRecord {
  if (
    action === "save_schedule_memory" ||
    action === "save_schedule" ||
    action === "save_memory" ||
    action === "save_resource"
  ) {
    return {
      ...args,
      confirm: /^(保存|確認|確定|好|可以|存)$/u.test(answer.trim()),
      cancel: /^(取消|不要|先不要|不用)$/u.test(answer.trim()),
      query: answer
    };
  }

  const missingSlot = findMissingRequiredSlot(action, args);
  if (!missingSlot) {
    return {
      ...args,
      query: answer,
      originalQuery: answer
    };
  }

  return {
    ...args,
    [missingSlot.argument]: answer,
    ...(missingSlot.argument === "query" ? { originalQuery: answer } : {})
  };
}

function slotMissing(slot: FunctionRequiredSlot, args: JsonRecord): boolean {
  return !stringArgument(args, slot.argument) || isGenericSlotValue(slot, args);
}

function stringArgument(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toMessageQuickReply(item: { label: string; text: string }): QuickReplyItem {
  return {
    label: item.label,
    action: {
      type: "message",
      label: item.label,
      text: item.text
    }
  };
}

import { messages } from "../messages.js";
import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import {
  applyPendingSlotAnswer,
  createSlotClarificationResult,
  isPendingFunctionControlAnswer
} from "../agent/slot-clarification.js";
import { canCreateRequesterScopedSession } from "../state/session-safety.js";
import type { SessionStore } from "../state/session-store.js";
import type {
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord,
  TextMessageContext,
  TextMessageHandler
} from "../types.js";
import { normalizeFunctionArguments } from "./argument-normalization.js";

const PENDING_FUNCTION_TTL_MS = 10 * 60 * 1000;

export interface StorePendingFunctionOptions {
  sessionStore: SessionStore;
  requestId: string;
  action: FunctionName;
  arguments: JsonRecord;
  context: FunctionHandlerContext;
  now: Date;
}

export interface PendingFunctionTextMessageOptions {
  sessionStore: SessionStore;
  functions: FunctionRegistry;
}

export async function storePendingFunctionQuery(
  options: StorePendingFunctionOptions
): Promise<void> {
  if (!canCreateRequesterScopedSession(options.context.event.source)) {
    return;
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
}

export function createPendingFunctionTextMessageHandler(
  options: PendingFunctionTextMessageOptions
): TextMessageHandler {
  return {
    turnStage: "pending_function",
    matches: async (request, context) => {
      if (!request.text.trim()) return false;
      const pendingAttachment = await options.sessionStore.findPendingAttachment({
        profileName: context.profile.name,
        source: context.event.source,
        requesterUserId: context.event.source.userId
      });
      if (pendingAttachment) return false;
      const pending = await findPendingFunction(options.sessionStore, context);
      if (!pending) return false;
      if (isPendingFunctionControlAnswer(request.text)) return true;
      if (explicitFunctionSwitch(request.text, pending.action, context)) {
        await options.sessionStore.delete(pending.id);
        return false;
      }
      return true;
    },

    handle: async (request, context) => {
      const pending = await findPendingFunction(options.sessionStore, context);
      if (!pending) {
        return undefined;
      }

      await options.sessionStore.delete(pending.id);

      if (!context.profile.enabledFunctions.includes(pending.action)) {
        return { ok: true, replyText: messages.functionNotConfigured };
      }

      const handler = options.functions[pending.action];
      if (!handler) {
        return { ok: true, replyText: messages.functionNotConfigured };
      }

      const answer = request.text.trim();
      if (/^(?:取消|不要|先不要|不用)$/u.test(answer)) {
        return { ok: true, replyText: "已取消這次操作。" };
      }
      const normalizedArguments = normalizeFunctionArguments(
        pending.action,
        applyPendingSlotAnswer(pending.action, pending.arguments, answer),
        { text: answer }
      );
      const requestId = context.requestId ?? pending.id;
      const slotCollection = await createSlotClarificationResult({
        sessionStore: options.sessionStore,
        action: pending.action,
        arguments: normalizedArguments,
        context: {
          profile: context.profile,
          event: context.event,
          requestId,
          requesterDisplayName: context.requesterDisplayName,
          requesterIsAdmin: context.requesterIsAdmin
        },
        requestId,
        now: new Date()
      });
      if (slotCollection) return slotCollection;

      const result = await handler(normalizedArguments, {
        profile: context.profile,
        event: context.event,
        requestId: context.requestId,
        requesterDisplayName: context.requesterDisplayName,
        requesterIsAdmin: context.requesterIsAdmin
      });
      return {
        ...result,
        executedAction: pending.action,
        writePhase: normalizedArguments.confirm === true ? "commit" : "preview"
      };
    }
  };
}

function explicitFunctionSwitch(
  text: string,
  pendingAction: FunctionName,
  context: TextMessageContext
): boolean {
  const source = context.event.source.type;
  if (source !== "user" && source !== "group") return false;
  return buildCapabilityCandidates({
    text,
    enabledFunctions: context.profile.enabledFunctions,
    source,
    knowledgeSources: [],
    maxCandidates: 5
  }).some(({ capability, reason }) => capability !== pendingAction && reason === "explicit_intent");
}

function findPendingFunction(sessionStore: SessionStore, context: TextMessageContext) {
  return sessionStore.findPendingFunction({
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId
  });
}

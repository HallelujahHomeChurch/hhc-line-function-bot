import { messages } from "../messages.js";
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
    matches: async (request, context) =>
      Boolean(request.text.trim()) &&
      Boolean(await findPendingFunction(options.sessionStore, context)),

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
      const normalizedArguments = normalizeFunctionArguments(
        pending.action,
        {
          ...pending.arguments,
          query: answer,
          originalQuery: answer
        },
        { text: answer }
      );
      return handler(normalizedArguments, { profile: context.profile, event: context.event });
    }
  };
}

function findPendingFunction(sessionStore: SessionStore, context: TextMessageContext) {
  return sessionStore.findPendingFunction({
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId
  });
}

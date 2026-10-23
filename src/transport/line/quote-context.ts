import type { QuoteContext, QuoteScope, QuoteStore } from "../../quotes/types.js";
import type { ProfileRuntime } from "../../runtime/profile-runtime.js";
import type { LineEvent, LineReplyClient } from "../../types.js";

export async function prepareQuoteContext(input: {
  store: QuoteStore;
  runtime: ProfileRuntime;
  scope: QuoteScope;
  event: LineEvent;
  line: LineReplyClient;
  clearConversation?: () => Promise<void>;
  deferRequest?: boolean;
}): Promise<{ context: QuoteContext; line: LineReplyClient } | undefined> {
  const { store, runtime, scope, event } = input;
  const reset = /^(?:\/reset|忘記這段對話)$/u.test(event.message?.text?.trim() ?? "");
  if (reset) {
    await store.reset(scope);
  }
  const turn = await store.begin({
    ...scope,
    messageId: event.message?.id,
    quotedMessageId: event.message?.quotedMessageId,
    text: input.deferRequest ? undefined : event.message?.text,
    timestamp: event.timestamp,
    ...(input.deferRequest ? { deferRequest: true } : {})
  });
  if (!turn) return undefined;
  if (turn.clearCheckpoint) {
    await runtime.clearContext?.(scope);
    await input.clearConversation?.();
    await store.acknowledgeClear(turn.token);
  }
  const context: QuoteContext = {
    token: turn.token,
    quoted: turn.quoted,
    replyProjection: { kind: "conversation" },
    cleared: turn.clearCheckpoint && !reset,
    isCurrent: () => store.isCurrent(turn.token)
  };
  if (input.deferRequest) {
    context.admitRequest = async () => {
      if (!(await context.isCurrent())) return false;
      const admitted = await store.begin({
        ...scope,
        messageId: event.message?.id,
        quotedMessageId: event.message?.quotedMessageId,
        text: event.message?.text,
        timestamp: event.timestamp,
        expectedGeneration: turn.token.generation,
        expectedQuoted: turn.quoted
      });
      if (!admitted) return false;
      Object.assign(turn.token, admitted.token);
      turn.requestText = admitted.requestText;
      return true;
    };
  }
  return {
    context,
    line: {
      async replyText(...args) {
        if (!(await context.isCurrent())) return;
        const result = await input.line.replyText(...args);
        // LINE has accepted the reply; an index failure must never resend it.
        if (result) {
          await (
            context.replyProjection
              ? store.recordReply(turn, result.sentMessages, context.replyProjection)
              : store.recordReply(turn, result.sentMessages)
          ).catch(() => undefined);
          // A running agent may hold the thread lock beyond LINE's inline reply budget.
          void Promise.resolve()
            .then(() =>
              runtime.recordDeliveredReply?.({
                scope,
                quoteContext: context,
                messages: result.sentMessages
              })
            )
            .catch(() => undefined);
        }
        return result;
      }
    }
  };
}

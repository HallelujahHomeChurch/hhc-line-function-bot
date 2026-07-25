import { orderTurnHandlers } from "../../../agent/turn-state-machine.js";
import type { BotProfileConfig, LineEvent, TextMessageHandlerRegistry } from "../../../types.js";

export async function matchTextContinuation(
  event: LineEvent,
  profile: BotProfileConfig,
  textMessageHandlers: TextMessageHandlerRegistry,
  requesterDisplayName?: string,
  requesterIsAdmin?: boolean
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) {
    return undefined;
  }
  for (const { name, handler } of orderTurnHandlers(textMessageHandlers)) {
    if (
      await handler.matches({ text }, { profile, event, requesterDisplayName, requesterIsAdmin })
    ) {
      return { name, handler };
    }
  }
  return undefined;
}

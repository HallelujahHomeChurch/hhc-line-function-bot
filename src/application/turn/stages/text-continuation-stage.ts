import { orderTurnHandlers } from "../../../agent/turn-state-machine.js";
import type {
  BotProfileConfig,
  FunctionName,
  LineEvent,
  TextMessageHandlerRegistry
} from "../../../types.js";

export async function matchTextContinuation(
  event: LineEvent,
  profile: BotProfileConfig,
  textMessageHandlers: TextMessageHandlerRegistry,
  requesterDisplayName?: string,
  requesterIsAdmin?: boolean,
  authorizeFunctions?: (functionNames: readonly FunctionName[]) => Promise<readonly FunctionName[]>
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) {
    return undefined;
  }
  for (const { name, handler } of orderTurnHandlers(textMessageHandlers)) {
    const restrictedCapability =
      handler.capability && profile.permissionRequiredFunctions.includes(handler.capability)
        ? handler.capability
        : undefined;
    const matchProfile =
      restrictedCapability && !profile.enabledFunctions.includes(restrictedCapability)
        ? {
            ...profile,
            enabledFunctions: [...profile.enabledFunctions, restrictedCapability]
          }
        : profile;
    if (
      await handler.matches(
        { text },
        { profile: matchProfile, event, requesterDisplayName, requesterIsAdmin }
      )
    ) {
      if (restrictedCapability) {
        let allowed: readonly FunctionName[] = [];
        try {
          allowed = (await authorizeFunctions?.([restrictedCapability])) ?? [];
        } catch {
          // A restricted text entrance fails closed without blocking later public handlers.
        }
        if (!allowed.includes(restrictedCapability)) continue;
      }
      return { name, handler, profile: matchProfile };
    }
  }
  return undefined;
}

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
  authorizeFunctions?: (functionNames: readonly FunctionName[]) => Promise<readonly FunctionName[]>,
  configuredFunctions: readonly FunctionName[] = [
    ...profile.enabledFunctions,
    ...profile.permissionRequiredFunctions
  ]
) {
  const text = event.message?.text;
  if (event.type !== "message" || event.message?.type !== "text" || !text) {
    return undefined;
  }
  for (const { name, handler } of orderTurnHandlers(textMessageHandlers)) {
    const protectedCapability =
      handler.capability &&
      configuredFunctions.includes(handler.capability) &&
      (profile.permissionRequiredFunctions.includes(handler.capability) ||
        !profile.enabledFunctions.includes(handler.capability))
        ? handler.capability
        : undefined;
    const matchProfile =
      protectedCapability && !profile.enabledFunctions.includes(protectedCapability)
        ? {
            ...profile,
            enabledFunctions: [...profile.enabledFunctions, protectedCapability]
          }
        : profile;
    if (
      await handler.matches(
        { text },
        { profile: matchProfile, event, requesterDisplayName, requesterIsAdmin }
      )
    ) {
      if (protectedCapability) {
        let allowed: readonly FunctionName[] = [];
        try {
          allowed = (await authorizeFunctions?.([protectedCapability])) ?? [];
        } catch {
          // A restricted text entrance fails closed without blocking later public handlers.
        }
        if (!allowed.includes(protectedCapability)) continue;
      }
      return { name, handler, profile: matchProfile };
    }
  }
  return undefined;
}

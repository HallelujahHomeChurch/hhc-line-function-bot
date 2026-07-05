import { getFunctionDefinition } from "./functions/definitions.js";
import type { BotProfileConfig, QuickReplyItem } from "./types.js";

export function buildFunctionQuickReplies(profile: BotProfileConfig): QuickReplyItem[] {
  return profile.enabledFunctions
    .map((name) => getFunctionDefinition(name))
    .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
    .map((definition) => ({
      label: definition.quickReply.label,
      action: {
        type: "message" as const,
        label: definition.quickReply.label,
        text: definition.quickReply.command
      }
    }));
}

export function buildPostbackQuickReply(
  label: string,
  data: string,
  displayText = label
): QuickReplyItem {
  return {
    label,
    action: {
      type: "postback",
      label,
      data,
      displayText
    }
  };
}

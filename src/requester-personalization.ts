import type { LineEvent, LineIdentityClient } from "./types.js";

export interface RequesterPersonalizationContext {
  requesterDisplayName?: string;
}

export function withRequesterDisplayName(
  context: RequesterPersonalizationContext,
  text: string
): string {
  const displayName = sanitizeRequesterDisplayName(context.requesterDisplayName);
  return displayName ? `${displayName}，${text}` : text;
}

export async function resolveRequesterDisplayName(
  identity: LineIdentityClient,
  event: LineEvent
): Promise<string | undefined> {
  if (!isSharedConversation(event) || !event.source.userId) {
    return undefined;
  }

  try {
    return sanitizeRequesterDisplayName(await identity.getUserDisplayName(event.source.userId));
  } catch {
    return undefined;
  }
}

function isSharedConversation(event: LineEvent): boolean {
  return event.source.type === "group" || event.source.type === "room";
}

function sanitizeRequesterDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  return Array.from(normalized).slice(0, 24).join("");
}

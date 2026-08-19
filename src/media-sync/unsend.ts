import type { PostgresMediaSyncStore } from "./store.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

export type MediaSyncLifecycleAction = { type: "unsend"; sourceKey: string };

export function mediaSyncLifecycleAction(
  profile: BotProfileConfig,
  event: LineEvent
): MediaSyncLifecycleAction | undefined {
  if (
    profile.name !== "helper" ||
    event.source.type !== "group" ||
    !boundedOpaque(event.source.groupId)
  ) {
    return undefined;
  }
  if (event.type !== "unsend" || !boundedOpaque(event.unsend?.messageId)) return undefined;
  return { type: "unsend", sourceKey: mediaSyncSourceKey(profile.name, event.unsend.messageId) };
}

export async function applyMediaSyncLifecycle(
  action: MediaSyncLifecycleAction,
  store: PostgresMediaSyncStore
): Promise<void> {
  await store.tombstoneSource(action.sourceKey);
}

export function mediaSyncSourceKey(profileName: string, messageId: string): string {
  return `line:${profileName}:${messageId}`;
}

function boundedOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

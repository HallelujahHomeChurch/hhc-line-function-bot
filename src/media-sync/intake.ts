import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

import type { PendingAttachmentSession, SessionStore } from "../state/session-store.js";
import type { BotProfileConfig, LineEvent, LineMessage } from "../types.js";
import type { PostgresMediaSyncStore } from "./store.js";
import type { MediaSyncMediaKind } from "./types.js";
import { mediaSyncSourceKey } from "./unsend.js";

const MANUAL_SESSION_TTL_MS = 10 * 60 * 1000;
const MEDIA_KINDS = new Set<MediaSyncMediaKind>(["image", "video", "audio", "file"]);

export async function prepareMediaSyncIntake(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  store: PostgresMediaSyncStore;
  sessionStore?: SessionStore;
  now: Date;
}): Promise<{ eligible: boolean; manual?: boolean; workId?: string; sourceKey?: string }> {
  const message = eligibleMessage(input.profile, input.event);
  const groupId = input.event.source.groupId;
  if (!message || !groupId) return { eligible: false };
  const binding = await input.store.findActiveBinding({
    profileName: input.profile.name,
    groupId
  });
  if (!binding) return { eligible: false };

  const sourceKey = mediaSyncSourceKey(input.profile.name, message.id);
  const result = await input.store.createIngest({
    sourceKey,
    profileName: input.profile.name,
    messageId: message.id,
    groupId,
    collectionId: binding.collectionId,
    displayName: displayName(message, input.event.timestamp ?? input.now.getTime()),
    mediaKind: message.type,
    expectedMime: expectedMime(message)
  });
  if (result.tombstoned) {
    return { eligible: true, manual: false, sourceKey };
  }

  let manual = false;
  if (
    input.sessionStore &&
    input.event.source.userId &&
    input.profile.enabledFunctions.includes("save_resource")
  ) {
    const promotion = await input.sessionStore.promoteUploadIntent(
      pendingAttachment(input.profile, input.event, message, sourceKey, input.now)
    );
    if (promotion) {
      try {
        manual = await input.store.attachManualIntent({
          sourceKey,
          destinationId: promotion.pending.id,
          requesterUserId: promotion.pending.requesterUserId!
        });
      } catch (error) {
        await input.sessionStore.restoreUploadIntentPromotion(promotion);
        throw error;
      }
      if (!manual) await input.sessionStore.restoreUploadIntentPromotion(promotion);
    }
  }
  return {
    eligible: true,
    manual,
    sourceKey,
    workId: result.ingest.workId
  };
}

function eligibleMessage(
  profile: BotProfileConfig,
  event: LineEvent
): (LineMessage & { id: string; type: MediaSyncMediaKind }) | undefined {
  if (profile.name !== "helper" || event.type !== "message" || event.source.type !== "group") {
    return undefined;
  }
  const message = event.message;
  if (
    !message?.id ||
    !MEDIA_KINDS.has(message.type as MediaSyncMediaKind) ||
    (message.contentProvider?.type !== undefined && message.contentProvider.type !== "line")
  ) {
    return undefined;
  }
  return message as LineMessage & { id: string; type: MediaSyncMediaKind };
}

function pendingAttachment(
  profile: BotProfileConfig,
  event: LineEvent,
  message: LineMessage & { id: string; type: MediaSyncMediaKind },
  sourceKey: string,
  now: Date
): PendingAttachmentSession {
  return {
    id: `media-sync-${createHash("sha256").update(sourceKey).digest("hex")}`,
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_opt_in",
    profileName: profile.name,
    requesterUserId: event.source.userId,
    mediaSyncSourceKey: sourceKey,
    source: event.source,
    attachment: {
      messageId: message.id,
      messageType: message.type,
      fileName: message.fileName,
      fileSize: message.fileSize
    },
    expiresAt: new Date(now.getTime() + MANUAL_SESSION_TTL_MS).toISOString()
  };
}

function displayName(
  message: LineMessage & { id: string; type: MediaSyncMediaKind },
  timestamp: number
) {
  const declared = message.fileName?.trim();
  if (declared && !hasControlCharacters(declared)) {
    const safe = basename(declared);
    if (safe && Buffer.byteLength(safe) <= 255) return safe;
  }
  const suffix = createHash("sha256").update(message.id).digest("hex").slice(0, 8);
  return `${message.type}-${new Date(timestamp).toISOString().replaceAll(/[:.]/gu, "-")}-${suffix}${fallbackExtension(message.type)}`;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function expectedMime(message: LineMessage & { type: MediaSyncMediaKind }): string {
  const extension = extname(message.fileName ?? "").toLowerCase();
  const byExtension: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": message.type === "video" ? "video/ogg" : "audio/ogg",
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".lpdeck": "application/vnd.librepresenter.presentation+json"
  };
  return (
    byExtension[extension] ??
    {
      image: "image/jpeg",
      video: "video/mp4",
      audio: "audio/mp4",
      file: "application/octet-stream"
    }[message.type]
  );
}

function fallbackExtension(kind: MediaSyncMediaKind): string {
  return { image: ".jpg", video: ".mp4", audio: ".m4a", file: ".bin" }[kind];
}

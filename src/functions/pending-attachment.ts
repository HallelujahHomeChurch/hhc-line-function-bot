import { canCreateRequesterScopedSession } from "../state/session-safety.js";
import type { PendingAttachmentSession, SessionStore } from "../state/session-store.js";
import type { FunctionHandlerContext, LineMessage, QuickReplyItem } from "../types.js";

const PENDING_ATTACHMENT_TTL_MS = 10 * 60 * 1000;

export interface StorePendingAttachmentOptions {
  sessionStore: SessionStore;
  requestId: string;
  context: FunctionHandlerContext;
  message: LineMessage;
  now: Date;
}

export async function storePendingAttachment(
  options: StorePendingAttachmentOptions
): Promise<PendingAttachmentSession | undefined> {
  if (!canCreateRequesterScopedSession(options.context.event.source)) {
    return undefined;
  }
  if (!isSupportedAttachment(options.message)) {
    return undefined;
  }

  const session: PendingAttachmentSession = {
    id: options.requestId,
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_opt_in",
    profileName: options.context.profile.name,
    requesterUserId: options.context.event.source.userId,
    source: options.context.event.source,
    attachment: {
      messageId: options.message.id,
      messageType: options.message.type,
      fileName: options.message.fileName,
      fileSize: options.message.fileSize
    },
    expiresAt: new Date(options.now.getTime() + PENDING_ATTACHMENT_TTL_MS).toISOString()
  };
  await options.sessionStore.set(session);
  return session;
}

export function pendingAttachmentPrompt(message: LineMessage): {
  replyText: string;
  quickReplies: QuickReplyItem[];
} {
  const label = message.type === "image" ? "圖片" : "檔案";
  const fileName = message.fileName?.trim();
  return {
    replyText: [
      `收到${label}${fileName ? `：${fileName}` : ""}。`,
      "要我幫忙保存這個檔案嗎？",
      "在你確認保存前，我不會下載或上傳這個檔案。"
    ].join("\n"),
    quickReplies: [
      { label: "是", action: { type: "message", label: "是", text: "是" } },
      { label: "否", action: { type: "message", label: "否", text: "否" } }
    ]
  };
}

export function isSupportedAttachment(message: LineMessage | undefined): message is LineMessage & {
  id: string;
  type: "image" | "file";
} {
  return Boolean(message?.id && (message.type === "image" || message.type === "file"));
}

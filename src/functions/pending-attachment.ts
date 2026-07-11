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
    stage: "awaiting_purpose",
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
      "請說明這個檔案要存成什麼用途，例如：投影片、流行歌譜、詩歌歌譜或教會資料。",
      "在你說明用途並確認前，我不會保存或上傳這個檔案。"
    ].join("\n"),
    quickReplies: [
      { label: "投影片", action: { type: "message", label: "投影片", text: "存成投影片" } },
      {
        label: "流行歌譜",
        action: { type: "message", label: "流行歌譜", text: "存成流行歌譜" }
      },
      {
        label: "詩歌歌譜",
        action: { type: "message", label: "詩歌歌譜", text: "存成詩歌歌譜" }
      },
      {
        label: "教會資料",
        action: { type: "message", label: "教會資料", text: "存成教會資料" }
      }
    ]
  };
}

export function isSupportedAttachment(message: LineMessage | undefined): message is LineMessage & {
  id: string;
  type: "image" | "file";
} {
  return Boolean(message?.id && (message.type === "image" || message.type === "file"));
}

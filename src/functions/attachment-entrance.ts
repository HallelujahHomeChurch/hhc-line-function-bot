import type { SessionStore } from "../state/session-store.js";
import type { BotProfileConfig, FunctionExecutionResult, LineEvent } from "../types.js";
import {
  isSupportedAttachment,
  pendingAttachmentPrompt,
  storePendingAttachment
} from "./pending-attachment.js";
import { consumeUploadIntent } from "./upload-intent.js";

export async function handleAttachmentMessage(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  sessionStore?: SessionStore;
  maxAttachmentBytes: number;
  now: Date;
}): Promise<FunctionExecutionResult | undefined> {
  if (!isSupportedAttachment(input.event.message)) {
    return { ok: true, replyText: "目前只支援圖片或檔案附件。" };
  }
  if (input.event.source.type === "group") {
    if (!input.sessionStore) return undefined;
    const uploadIntent = await consumeUploadIntent(
      input.sessionStore,
      input.profile.name,
      input.event.source
    );
    if (!uploadIntent || !input.profile.enabledFunctions.includes("save_resource")) {
      return undefined;
    }
  }
  if (!input.profile.enabledFunctions.includes("save_resource")) {
    return { ok: true, replyText: "目前沒有開放保存檔案。" };
  }
  if (!input.sessionStore) {
    return { ok: true, replyText: "目前無法保存檔案，請稍後再試。" };
  }
  if (
    input.event.message.fileSize !== undefined &&
    input.event.message.fileSize > input.maxAttachmentBytes
  ) {
    return { ok: true, replyText: "檔案太大，無法保存。" };
  }

  const stored = await storePendingAttachment({
    sessionStore: input.sessionStore,
    requestId: input.requestId,
    context: {
      profile: input.profile,
      event: input.event,
      requestId: input.requestId,
      requesterDisplayName: input.requesterDisplayName
    },
    message: input.event.message,
    now: input.now
  });

  if (!stored) {
    return { ok: true, replyText: "目前無法建立檔案保存流程，請改用直接訊息再試一次。" };
  }

  const prompt = pendingAttachmentPrompt(input.event.message);
  return {
    ok: true,
    replyText: prompt.replyText,
    quickReplies: prompt.quickReplies
  };
}

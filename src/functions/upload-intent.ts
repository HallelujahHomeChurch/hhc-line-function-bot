import { randomUUID } from "node:crypto";

import type { SessionStore, UploadIntentSession } from "../state/session-store.js";
import type { LineSource, TextMessageHandler } from "../types.js";

const UPLOAD_INTENT_TTL_MS = 2 * 60 * 1000;

export function isUploadActivation(text: string): boolean {
  return /^\s*小哈[，,、：:\s]*(?:我要|要|幫我)(?:上傳|存|保存)檔案[。.!！?？\s]*$/u.test(
    text.normalize("NFKC")
  );
}

export async function createUploadIntent(input: {
  sessionStore: SessionStore;
  requestId: string;
  profileName: string;
  source: LineSource;
  now: Date;
}): Promise<UploadIntentSession | undefined> {
  if (input.source.type !== "group" || !input.source.userId) return undefined;
  const session: UploadIntentSession = {
    id: input.requestId,
    type: "upload_intent",
    profileName: input.profileName,
    requesterUserId: input.source.userId,
    source: input.source,
    expiresAt: new Date(input.now.getTime() + UPLOAD_INTENT_TTL_MS).toISOString()
  };
  await input.sessionStore.set(session);
  return session;
}

export function consumeUploadIntent(
  store: SessionStore,
  profileName: string,
  source: LineSource
): Promise<UploadIntentSession | undefined> {
  return store.takeUploadIntent({ profileName, source, requesterUserId: source.userId });
}

export function createUploadIntentTextMessageHandler(input: {
  sessionStore: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}): TextMessageHandler {
  const now = input.now ?? (() => new Date());
  return {
    turnStage: "attachment",
    matches: async (request, context) =>
      context.event.source.type === "group" &&
      context.profile.enabledFunctions.includes("save_resource") &&
      isUploadActivation(request.text),
    handle: async (_request, context) => {
      const stored = await createUploadIntent({
        sessionStore: input.sessionStore,
        requestId: context.requestId ?? input.requestIdFactory?.() ?? randomUUID(),
        profileName: context.profile.name,
        source: context.event.source,
        now: now()
      });
      return stored
        ? { ok: true, replyText: "請在兩分鐘內上傳一個圖片或檔案。" }
        : { ok: true, replyText: "目前無法建立檔案上傳流程，請稍後再試。" };
    }
  };
}

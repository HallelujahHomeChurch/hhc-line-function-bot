import { createHash, randomUUID } from "node:crypto";
import { buildPostbackQuickReply } from "../../line-reply.js";
import type { SessionStore } from "../../state/session-store.js";
import { sourceKey } from "./postbacks.js";
import type { LineEvent, LineReplyClient } from "../../types.js";

// LINE message actions are indistinguishable from ambient text; use scoped one-shot postbacks.
export function groupReplyClient(
  client: LineReplyClient,
  sessions: SessionStore | undefined,
  profileName: string,
  event: LineEvent
): LineReplyClient {
  if (event.source.type !== "group") return client;
  return {
    async replyText(token, text, options) {
      const choices = options?.quickReplies?.filter((item) => item.action.type === "message");
      if (!choices?.length) return client.replyText(token, text, options);
      if (!sessions || !event.source.userId)
        return client.replyText(token, `${text}\n請引用回覆這則訊息，或重新明確呼叫我。`);
      const id = randomUUID();
      const texts = choices.map((item) => (item.action.type === "message" ? item.action.text : ""));
      await sessions.set({
        id,
        type: "group_reply",
        profileName,
        source: event.source,
        requesterUserId: event.source.userId,
        texts,
        stateKey: await stateKey(sessions, profileName, event),
        expiresAt: new Date(Date.now() + 120_000).toISOString()
      });
      return client.replyText(token, text, {
        ...options,
        quickReplies: options!.quickReplies!.map((item) =>
          item.action.type === "message"
            ? buildPostbackQuickReply(
                item.label,
                new URLSearchParams({
                  action: "group_reply",
                  id,
                  choice: String(choices.indexOf(item))
                }).toString()
              )
            : item
        )
      });
    }
  };
}

export async function takeGroupReply(
  sessions: SessionStore | undefined,
  profileName: string,
  event: LineEvent
): Promise<LineEvent | undefined> {
  const data = new URLSearchParams(event.postback?.data);
  const id = data.get("id");
  const choice = data.get("choice");
  if (!sessions || !id || !choice || !/^\d{1,2}$/.test(choice)) return undefined;
  const current = await sessions.get(id);
  if (
    current?.type !== "group_reply" ||
    current.profileName !== profileName ||
    current.requesterUserId !== event.source.userId ||
    sourceKey(current.source) !== sourceKey(event.source) ||
    Date.parse(current.expiresAt) <= Date.now() ||
    current.texts[Number(choice)] === undefined ||
    current.stateKey !== (await stateKey(sessions, profileName, event))
  )
    return undefined;
  const taken = await sessions.take(id);
  if (taken?.type !== "group_reply") return undefined;
  return {
    ...event,
    type: "message",
    postback: undefined,
    message: { type: "text", text: taken.texts[Number(choice)] }
  };
}

async function stateKey(
  sessions: SessionStore,
  profileName: string,
  event: LineEvent
): Promise<string> {
  const scope = { profileName, source: event.source, requesterUserId: event.source.userId };
  const state = await Promise.all([
    sessions.findPendingAttachment(scope),
    sessions.findActionReview(scope),
    sessions.findPptSelection(scope)
  ]);
  // Preserve the v1 hash slots so existing internal-choice buttons stay valid.
  return createHash("sha256")
    .update(JSON.stringify([...state, null, null]))
    .digest("hex");
}

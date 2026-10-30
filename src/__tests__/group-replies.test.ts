import { describe, expect, it, vi } from "vitest";
import { groupReplyClient, takeGroupReply } from "../transport/line/group-replies.js";
import type { LineReplyClient } from "../types.js";
import { InMemorySessionStore } from "../state/session-store.js";

const event = {
  type: "message",
  source: { type: "group", groupId: "synthetic-group", userId: "synthetic-user" }
};
describe("scoped group message buttons", () => {
  it("replaces message actions with requester-bound, expiring, single-use postbacks", async () => {
    const sessions = new InMemorySessionStore();
    const replyText = vi.fn<LineReplyClient["replyText"]>(async () => undefined);
    await groupReplyClient({ replyText }, sessions, "helper", event).replyText(
      "synthetic",
      "請選擇",
      {
        quickReplies: [{ label: "一", action: { type: "message", label: "一", text: "1" } }]
      }
    );
    const options = replyText.mock.calls[0]![2]!;
    const action = options.quickReplies![0]!.action;
    expect(action.type).toBe("postback");
    if (action.type !== "postback") throw new Error("expected postback");
    const click = { ...event, type: "postback", postback: { data: action.data } };
    expect(
      await takeGroupReply(sessions, "helper", {
        ...click,
        source: { ...event.source, userId: "other" }
      })
    ).toBeUndefined();
    expect(await takeGroupReply(sessions, "main", click)).toBeUndefined();
    expect(await takeGroupReply(sessions, "helper", click)).toMatchObject({
      type: "message",
      message: { text: "1" }
    });
    expect(await takeGroupReply(sessions, "helper", click)).toBeUndefined();
  });
  it("rejects a button after its owning draft changes", async () => {
    const sessions = new InMemorySessionStore();
    const replyText = vi.fn<LineReplyClient["replyText"]>(async () => undefined);
    await groupReplyClient({ replyText }, sessions, "helper", event).replyText(
      "synthetic",
      "請選擇",
      {
        quickReplies: [{ label: "一", action: { type: "message", label: "一", text: "1" } }]
      }
    );
    const action = replyText.mock.calls[0]![2]!.quickReplies![0]!.action;
    if (action.type !== "postback") throw new Error("expected postback");
    await sessions.set({
      id: "new-upload",
      type: "pending_attachment",
      profileName: "helper",
      source: event.source,
      requesterUserId: event.source.userId,
      attachment: { messageId: "new-file", messageType: "file" },
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    expect(
      await takeGroupReply(sessions, "helper", {
        ...event,
        type: "postback",
        postback: { data: action.data }
      })
    ).toBeUndefined();
  });
});

import { createHash } from "node:crypto";
import { groupContinuationReply } from "../line-reply.js";
import { describe, expect, it, vi } from "vitest";
import { groupReplyClient, takeGroupReply } from "../transport/line/group-replies.js";
import type { LineReplyClient } from "../types.js";
import { InMemorySessionStore } from "../state/session-store.js";

const event = {
  type: "message",
  source: { type: "group", groupId: "synthetic-group", userId: "synthetic-user" }
};
describe("scoped group message buttons", () => {
  it("accepts a pre-retirement internal button with its original five-slot state hash", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "pre-retirement",
      type: "group_reply",
      profileName: "helper",
      source: event.source,
      requesterUserId: event.source.userId,
      texts: ["1"],
      stateKey: createHash("sha256")
        .update(JSON.stringify([null, null, null, null, null]))
        .digest("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const click = {
      ...event,
      type: "postback",
      postback: { data: "action=group_reply&id=pre-retirement&choice=0" }
    };
    expect(
      await takeGroupReply(sessions, "helper", {
        ...click,
        source: { ...event.source, userId: "other" }
      })
    ).toBeUndefined();
    expect(await takeGroupReply(sessions, "helper", click)).toMatchObject({
      message: { text: "1" }
    });
    expect(await takeGroupReply(sessions, "helper", click)).toBeUndefined();
  });

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

it("renders finite domain choices as scoped-safe text, never as approval", () => {
  const result = {
    ok: true,
    replyText: "請選擇角色。",
    agentResult: {
      status: "ambiguous" as const,
      replyText: "請選擇角色。",
      clarification: { prompt: "請選擇角色。", choices: ["司琴", "確認"] }
    }
  };
  const reply = groupContinuationReply(result, "group");
  expect(reply.quickReplies?.map((item) => item.action)).toEqual([
    { type: "message", label: "司琴", text: "選擇：司琴" },
    { type: "message", label: "確認", text: "選擇：確認" }
  ]);
  expect(groupContinuationReply(result, "user")).toBe(result);
});
it("adds guidance only to missing-input or question replies, preserving previews and existing buttons", () => {
  const result = {
    ok: true,
    replyText: "請輸入這份檔案的名稱。",
    writePreparation: "needs_input" as const
  };
  expect(groupContinuationReply(result, "group").replyText).toContain("引用回覆");
  expect(groupContinuationReply({ ok: true, replyText: "完成。" }, "group").replyText).toBe(
    "完成。"
  );
  const preview = { ...result, writePhase: "preview" as const };
  expect(groupContinuationReply(preview, "group")).toBe(preview);
  const guided = groupContinuationReply(result, "group");
  expect(groupContinuationReply(guided, "group")).toBe(guided);
});

import { describe, expect, it, vi } from "vitest";

import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { FunctionHandler, TextMessageContext } from "../types.js";

const scheduleText = "七/10五黃弘家族2\n七/17五世緯家園";

function context(): TextMessageContext {
  return {
    profile: {
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "secret",
      channelAccessToken: "token",
      allowDirectUser: true,
      allowRooms: false,
      allowedMessageTypes: ["text"],
      groupRequireWakeWord: true,
      wakeKeywords: ["小哈"],
      acceptMention: true,
      enabledFunctions: ["save_schedule"]
    },
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: scheduleText }
    },
    requestId: "answer-request"
  };
}

describe("pending function answers", () => {
  it("fills missing schedule content before interpreting save confirmation", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await sessionStore.set({
      id: "pending-save",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { content: "" },
      expiresAt: "2026-07-10T00:10:00.000Z"
    });
    const saveSchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "preview"
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_schedule: saveSchedule }
    });

    const result = await handler.handle({ text: scheduleText }, context());

    expect(result?.replyText).toBe("preview");
    expect(saveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ content: scheduleText }),
      expect.any(Object)
    );
  });

  it("preserves requester admin authority when a pending write is confirmed", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await sessionStore.set({
      id: "pending-admin-write",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { operation: "delete_entry", entryId: "entry-1", confirm: true },
      expiresAt: "2026-07-10T00:10:00.000Z"
    });
    const saveSchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "deleted"
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_schedule: saveSchedule }
    });

    const result = await handler.handle({ text: "保存" }, { ...context(), requesterIsAdmin: true });

    expect(result?.writePhase).toBe("commit");
    expect(saveSchedule).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ requesterIsAdmin: true })
    );
  });

  it("collects every required slot before calling a multi-slot handler", async () => {
    const sessionStore = new InMemorySessionStore({
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    await sessionStore.set({
      id: "pending-resource",
      type: "pending_function",
      action: "save_resource",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { url: "" },
      expiresAt: "2026-07-10T00:10:00.000Z"
    });
    const saveResource = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "saved"
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_resource: saveResource }
    });
    const resourceContext: TextMessageContext = {
      ...context(),
      profile: { ...context().profile, enabledFunctions: ["save_resource"] },
      event: {
        ...context().event,
        message: { type: "text", text: "https://example.org/slides" }
      }
    };

    const result = await handler.handle({ text: "https://example.org/slides" }, resourceContext);

    expect(result?.replyText).toBe("這是投影片還是歌譜？");
    expect(saveResource).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({
      total: 1,
      byType: { pending_function: 1 }
    });

    const typeResult = await handler.handle({ text: "投影片" }, resourceContext);
    expect(typeResult?.replyText).toBe("請提供這份資源的名稱。");
    expect(saveResource).not.toHaveBeenCalled();

    const titleResult = await handler.handle({ text: "青年聚會投影片" }, resourceContext);
    expect(titleResult?.replyText).toBe("saved");
    expect(saveResource).toHaveBeenCalledWith(
      {
        url: "https://example.org/slides",
        resourceType: "ppt_slide",
        title: "青年聚會投影片"
      },
      expect.any(Object)
    );
  });

  it("cancels a pending collection without treating the cancellation as content", async () => {
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "pending-cancel",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { content: "" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const saveSchedule = vi.fn<FunctionHandler>();
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_schedule: saveSchedule }
    });

    const result = await handler.handle({ text: "取消" }, context());

    expect(result?.replyText).toBe("已取消這次操作。");
    expect(saveSchedule).not.toHaveBeenCalled();
    await expect(sessionStore.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("releases a pending collection when the requester explicitly switches functions", async () => {
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "pending-switch",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { content: "" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: {}
    });
    const switchContext: TextMessageContext = {
      ...context(),
      profile: {
        ...context().profile,
        enabledFunctions: ["save_schedule", "find_sheet_music"]
      }
    };

    await expect(handler.matches({ text: "查歌譜 奇異恩典" }, switchContext)).resolves.toBe(false);
    await expect(sessionStore.summary()).resolves.toMatchObject({ total: 0 });
  });
});

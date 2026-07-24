import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { createSaveScheduleHandler } from "../functions/schedule-memory.js";
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

  it("keeps a bare confirmation with the current pending write when generic memory is enabled", async () => {
    const sessionStore = new InMemorySessionStore();
    await sessionStore.set({
      id: "pending-schedule-confirmation",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: {
        content: scheduleText,
        scheduleType: "morning_prayer_family",
        confirm: true
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const saveSchedule = vi.fn<FunctionHandler>().mockResolvedValue({
      ok: true,
      replyText: "已保存"
    });
    const saveMemory = vi.fn<FunctionHandler>();
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_schedule: saveSchedule, save_memory: saveMemory }
    });
    const confirmationContext: TextMessageContext = {
      ...context(),
      profile: {
        ...context().profile,
        enabledFunctions: ["save_schedule", "save_memory"]
      }
    };

    await expect(handler.matches({ text: "保存" }, confirmationContext)).resolves.toBe(true);
    const result = await handler.handle({ text: "保存" }, confirmationContext);

    expect(result?.replyText).toBe("已保存");
    expect(saveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ content: scheduleText, confirm: true, query: "保存" }),
      expect.any(Object)
    );
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("does not let a pending URL collection consume an attachment confirmation", async () => {
    const sessionStore = new InMemorySessionStore();
    vi.spyOn(sessionStore, "findPendingFunction").mockResolvedValue({
      id: "pending-url",
      type: "pending_function",
      action: "save_resource",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { url: "" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    vi.spyOn(sessionStore, "findPendingAttachment").mockResolvedValue({
      id: "pending-attachment",
      type: "pending_attachment",
      action: "save_resource",
      stage: "awaiting_confirmation",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      attachment: { messageId: "line-message-id", messageType: "file" },
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const saveResource = vi.fn<FunctionHandler>();
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { save_resource: saveResource }
    });
    const attachmentContext: TextMessageContext = {
      ...context(),
      profile: { ...context().profile, enabledFunctions: ["save_resource"] }
    };

    await expect(handler.matches({ text: "保存" }, attachmentContext)).resolves.toBe(false);
    expect(saveResource).not.toHaveBeenCalled();
  });

  it("persists a collected schedule after confirmation and makes exact and next queries available", async () => {
    const now = new Date("2026-07-14T12:31:00.000Z");
    const sessionStore = new InMemorySessionStore({ now: () => now });
    const memoryStore = new InMemoryAgentMemoryStore({ now: () => now });
    const schedule = ["七/14二中平家族", "七/16四仙履奇緣", "七/17五世緯家園"].join("\n");
    await sessionStore.set({
      id: "pending-schedule-content",
      type: "pending_function",
      action: "save_schedule",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      arguments: { content: "" },
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
    const saveSchedule = createSaveScheduleHandler({
      memoryStore,
      sessionStore,
      now: () => now,
      requestIdFactory: () => "pending-schedule-confirmation"
    });
    const handler = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: {
        save_schedule: saveSchedule,
        save_memory: vi.fn<FunctionHandler>()
      }
    });
    const fullContext: TextMessageContext = {
      ...context(),
      profile: {
        ...context().profile,
        enabledFunctions: ["query_schedule", "save_schedule", "save_memory"]
      }
    };

    const preview = await handler.handle({ text: schedule }, fullContext);
    expect(preview?.replyText).toContain("要保存嗎");
    await expect(handler.matches({ text: "保存" }, fullContext)).resolves.toBe(true);
    const committed = await handler.handle({ text: "保存" }, fullContext);
    expect(committed?.replyText).toContain("已保存 3 筆晨更家族服事");

    const query = createQueryScheduleHandler({
      memoryStore,
      now: () => now,
      timeZone: "Asia/Taipei"
    });
    const exact = await query(
      {
        query: "7/14晨更服事家族是誰",
        dateIntent: "specific_date",
        specificDate: "2026-07-14"
      },
      fullContext
    );
    const next = await query(
      { query: "下一場晨更服事", dateIntent: "next_meeting", meeting: "晨更" },
      fullContext
    );

    expect(exact.replyText).toContain("中平家族");
    expect(next.replyText).toContain("7月17日");
    expect(next.replyText).toContain("世緯家園");
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

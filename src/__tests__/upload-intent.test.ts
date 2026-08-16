import { describe, expect, it } from "vitest";

import {
  createUploadIntent,
  consumeUploadIntent,
  createUploadIntentTextMessageHandler,
  isUploadActivation
} from "../functions/upload-intent.js";
import { isSupportedAttachment } from "../functions/pending-attachment.js";
import { InMemorySessionStore } from "../state/session-store.js";

describe("group upload intent", () => {
  it("keeps legacy attachment handling limited to images and files", () => {
    expect(isSupportedAttachment({ type: "image", id: "image-1" })).toBe(true);
    expect(isSupportedAttachment({ type: "file", id: "file-1" })).toBe(true);
    expect(isSupportedAttachment({ type: "video", id: "video-1" })).toBe(false);
    expect(isSupportedAttachment({ type: "audio", id: "audio-1" })).toBe(false);
  });
  it("accepts only an explicit activation phrase", () => {
    expect(isUploadActivation("小哈我要上傳檔案")).toBe(true);
    expect(isUploadActivation("這張圖片很好看")).toBe(false);
  });

  it("is requester scoped and consumed only once", async () => {
    const store = new InMemorySessionStore({ now: () => new Date("2026-07-15T10:00:00Z") });
    await createUploadIntent({
      sessionStore: store,
      requestId: "intent-1",
      profileName: "helper",
      source: { type: "group", groupId: "G1", userId: "U1" },
      now: new Date("2026-07-15T10:00:00Z")
    });

    await expect(
      consumeUploadIntent(store, "helper", { type: "group", groupId: "G1", userId: "U2" })
    ).resolves.toBeUndefined();
    await expect(
      consumeUploadIntent(store, "helper", { type: "group", groupId: "G1", userId: "U1" })
    ).resolves.toMatchObject({ id: "intent-1" });
    await expect(
      consumeUploadIntent(store, "helper", { type: "group", groupId: "G1", userId: "U1" })
    ).resolves.toBeUndefined();
  });

  it("promotes one upload intent into the same pending attachment idempotently", async () => {
    const store = new InMemorySessionStore({ now: () => new Date("2026-07-15T10:00:00Z") });
    await createUploadIntent({
      sessionStore: store,
      requestId: "intent-promote",
      profileName: "helper",
      source: { type: "group", groupId: "G1", userId: "U1" },
      now: new Date("2026-07-15T10:00:00Z")
    });
    const pending = {
      id: "pending-media-1",
      type: "pending_attachment" as const,
      action: "save_resource" as const,
      stage: "awaiting_opt_in" as const,
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group" as const, groupId: "G1", userId: "U1" },
      attachment: { messageId: "message-1", messageType: "video" as const },
      expiresAt: "2026-07-15T10:10:00.000Z"
    };

    const promotion = await store.promoteUploadIntent(pending);
    expect(promotion).toEqual({
      pending,
      replaced: expect.objectContaining({ id: "intent-promote", type: "upload_intent" })
    });
    await expect(store.restoreUploadIntentPromotion(promotion!)).resolves.toBe(true);
    await expect(
      consumeUploadIntent(store, "helper", { type: "group", groupId: "G1", userId: "U1" })
    ).resolves.toMatchObject({ id: "intent-promote" });

    await store.set({
      id: "intent-promote-2",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "U1",
      source: pending.source,
      expiresAt: "2026-07-15T10:02:00.000Z"
    });
    const owner = await store.promoteUploadIntent(pending);
    const duplicate = await store.promoteUploadIntent(pending);
    expect(owner).toMatchObject({ pending, replaced: { id: "intent-promote-2" } });
    expect(duplicate).toEqual({ pending });
    await expect(store.restoreUploadIntentPromotion(duplicate!)).resolves.toBe(false);
    await expect(store.restoreUploadIntentPromotion(owner!)).resolves.toBe(true);
    await expect(
      consumeUploadIntent(store, "helper", { type: "group", groupId: "G1", userId: "U1" })
    ).resolves.toMatchObject({ id: "intent-promote-2" });
    await store.set(pending);
    await expect(
      store.findPendingAttachment({
        profileName: "helper",
        source: pending.source,
        requesterUserId: "U1"
      })
    ).resolves.toEqual(pending);
  });

  it("creates the two-minute intent through the group activation text handler", async () => {
    const store = new InMemorySessionStore({ now: () => new Date("2026-07-15T10:00:00Z") });
    const handler = createUploadIntentTextMessageHandler({
      sessionStore: store,
      now: () => new Date("2026-07-15T10:00:00Z"),
      requestIdFactory: () => "upload-1"
    });
    const context = {
      requestId: "upload-1",
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text" as const, "file" as const],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["save_resource" as const]
      },
      event: {
        type: "message" as const,
        source: { type: "group" as const, groupId: "G1", userId: "U1" },
        message: { type: "text" as const, text: "小哈我要上傳檔案" }
      }
    };

    await expect(handler.matches({ text: "小哈我要上傳檔案" }, context)).resolves.toBe(true);
    await expect(handler.handle({ text: "小哈我要上傳檔案" }, context)).resolves.toMatchObject({
      replyText: "請在兩分鐘內上傳一個圖片或檔案。"
    });
    await expect(
      store.takeUploadIntent({
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ expiresAt: "2026-07-15T10:02:00.000Z" });
  });

  it("turns the same activation into direct-chat attachment guidance without group intent state", async () => {
    const store = new InMemorySessionStore({ now: () => new Date("2026-07-15T10:00:00Z") });
    const handler = createUploadIntentTextMessageHandler({ sessionStore: store });
    const context = {
      requestId: "upload-direct",
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text" as const, "file" as const],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["save_resource" as const]
      },
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "U1" },
        message: { type: "text" as const, text: "小哈我要上傳檔案" }
      }
    };

    await expect(handler.matches({ text: "小哈我要上傳檔案" }, context)).resolves.toBe(true);
    await expect(handler.handle({ text: "小哈我要上傳檔案" }, context)).resolves.toMatchObject({
      replyText: "請直接上傳一個圖片或檔案。"
    });
    await expect(
      store.takeUploadIntent({
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
  });
});

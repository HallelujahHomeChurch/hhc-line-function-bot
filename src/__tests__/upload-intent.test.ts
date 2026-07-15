import { describe, expect, it } from "vitest";

import {
  createUploadIntent,
  consumeUploadIntent,
  createUploadIntentTextMessageHandler,
  isUploadActivation
} from "../functions/upload-intent.js";
import { InMemorySessionStore } from "../state/session-store.js";

describe("group upload intent", () => {
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
});

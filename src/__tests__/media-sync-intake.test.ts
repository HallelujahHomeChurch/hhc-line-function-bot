import { describe, expect, it, vi } from "vitest";

import { prepareMediaSyncIntake } from "../media-sync/intake.js";
import { handleAttachmentMessage } from "../functions/attachment-entrance.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

const profile: BotProfileConfig = {
  name: "helper",
  webhookPath: "/api/line/webhook/helper",
  channelSecret: "secret",
  channelAccessToken: "token",
  allowDirectUser: true,
  allowRooms: false,
  allowedMessageTypes: ["text", "image", "video", "audio", "file"],
  groupRequireWakeWord: true,
  wakeKeywords: ["小哈"],
  acceptMention: true,
  enabledFunctions: ["save_resource"],
  permissionRequiredFunctions: [],
  adminDirectOnly: true,
  directAccessPolicy: "managed",
  groupAccessPolicy: "managed"
};

function event(message: LineEvent["message"]): LineEvent {
  return {
    type: "message",
    timestamp: 1_787_100_000_000,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    message
  };
}

function store(overrides: Partial<PostgresMediaSyncStore> = {}): PostgresMediaSyncStore {
  return {
    findActiveBinding: vi.fn().mockResolvedValue({
      profileName: "helper",
      groupId: "group-1",
      collectionId: "collection-1"
    }),
    createIngest: vi.fn().mockResolvedValue({
      created: true,
      ingest: { workId: "work-1" }
    }),
    attachManualIntent: vi.fn().mockResolvedValue(true),
    ...overrides
  } as unknown as PostgresMediaSyncStore;
}

describe("media sync webhook intake", () => {
  it("ignores non-LINE content providers before touching durable state", async () => {
    const mediaStore = store();

    await expect(
      prepareMediaSyncIntake({
        profile,
        event: event({
          id: "message-external",
          type: "image",
          contentProvider: { type: "external", originalContentUrl: "https://example.com/a.jpg" }
        }),
        store: mediaStore,
        now: new Date("2026-08-16T12:00:00.000Z")
      })
    ).resolves.toEqual({ eligible: false });
    expect(mediaStore.findActiveBinding).not.toHaveBeenCalled();
    expect(mediaStore.createIngest).not.toHaveBeenCalled();
  });

  it("records one collection publication and promotes a matching manual intent", async () => {
    const mediaStore = store();
    const sessions = new InMemorySessionStore({
      now: () => new Date("2026-08-16T12:00:00.000Z")
    });
    await sessions.set({
      id: "upload-intent-1",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "user-1",
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      expiresAt: "2026-08-16T12:02:00.000Z"
    });

    await expect(
      prepareMediaSyncIntake({
        profile,
        event: event({
          id: "message-1",
          type: "video",
          contentProvider: { type: "line" }
        }),
        store: mediaStore,
        sessionStore: sessions,
        now: new Date("2026-08-16T12:00:00.000Z")
      })
    ).resolves.toMatchObject({ eligible: true, manual: true });
    expect(mediaStore.createIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: "line:helper:message-1",
        groupId: "group-1",
        collectionId: "collection-1",
        mediaKind: "video"
      })
    );
    expect(mediaStore.attachManualIntent).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: "user-1" })
    );
    await expect(
      sessions.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "group-1", userId: "user-1" },
        requesterUserId: "user-1"
      })
    ).resolves.toMatchObject({
      attachment: { messageId: "message-1", messageType: "video" }
    });
  });

  it("reuses the promoted pending attachment in the existing manual entrance", async () => {
    const mediaStore = store();
    const sessions = new InMemorySessionStore({
      now: () => new Date("2026-08-16T12:00:00.000Z")
    });
    const source = { type: "group" as const, groupId: "group-1", userId: "user-1" };
    await sessions.set({
      id: "upload-intent-2",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "user-1",
      source,
      expiresAt: "2026-08-16T12:02:00.000Z"
    });
    const incoming = event({
      id: "message-manual",
      type: "file",
      fileName: "slides.pptx"
    });
    await prepareMediaSyncIntake({
      profile,
      event: incoming,
      store: mediaStore,
      sessionStore: sessions,
      now: new Date("2026-08-16T12:00:00.000Z")
    });

    await expect(
      handleAttachmentMessage({
        profile,
        event: incoming,
        requestId: "legacy-request",
        sessionStore: sessions,
        maxAttachmentBytes: 25 * 1024 * 1024,
        now: new Date("2026-08-16T12:00:00.000Z")
      })
    ).resolves.toMatchObject({ replyText: expect.stringContaining("要我幫忙保存") });
    await expect(
      sessions.findPendingAttachment({
        profileName: "helper",
        source,
        requesterUserId: "user-1"
      })
    ).resolves.toMatchObject({ id: expect.stringMatching(/^media-sync-/u) });
  });

  it("keeps bound automatic intake independent from save_resource", async () => {
    const mediaStore = store();

    await expect(
      prepareMediaSyncIntake({
        profile: { ...profile, enabledFunctions: [] },
        event: event({ id: "message-2", type: "image", contentProvider: { type: "line" } }),
        store: mediaStore,
        now: new Date("2026-08-16T12:00:00.000Z")
      })
    ).resolves.toMatchObject({ eligible: true, manual: false });
    expect(mediaStore.createIngest).toHaveBeenCalledOnce();
  });

  it.each(["image", "file", "video", "audio"] as const)(
    "preserves the original upload intent when tombstoned %s intake is redelivered",
    async (messageType) => {
      const mediaStore = store({
        createIngest: vi.fn().mockResolvedValue({ created: false, tombstoned: true })
      });
      const sessions = new InMemorySessionStore({
        now: () => new Date("2026-08-16T12:00:00.000Z")
      });
      const source = { type: "group" as const, groupId: "group-1", userId: "user-1" };
      await sessions.set({
        id: `upload-tombstoned-${messageType}`,
        type: "upload_intent",
        profileName: "helper",
        requesterUserId: "user-1",
        source,
        expiresAt: "2026-08-16T12:02:00.000Z"
      });

      await expect(
        prepareMediaSyncIntake({
          profile,
          event: event({ id: `message-tombstoned-${messageType}`, type: messageType }),
          store: mediaStore,
          sessionStore: sessions,
          now: new Date("2026-08-16T12:00:00.000Z")
        })
      ).resolves.toEqual({
        eligible: true,
        manual: false,
        sourceKey: `line:helper:message-tombstoned-${messageType}`
      });
      await expect(
        sessions.findPendingAttachment({
          profileName: "helper",
          source,
          requesterUserId: "user-1"
        })
      ).resolves.toBeUndefined();
      await expect(
        sessions.takeUploadIntent({
          profileName: "helper",
          source,
          requesterUserId: "user-1"
        })
      ).resolves.toMatchObject({ id: `upload-tombstoned-${messageType}` });
      expect(mediaStore.createIngest).toHaveBeenCalledWith(expect.any(Object));
    }
  );

  it("restores the upload intent when a concurrent tombstone wins the manual fence", async () => {
    const mediaStore = store({
      attachManualIntent: vi.fn().mockResolvedValue(false)
    } as Partial<PostgresMediaSyncStore>);
    const sessions = new InMemorySessionStore({
      now: () => new Date("2026-08-16T12:00:00.000Z")
    });
    const source = { type: "group" as const, groupId: "group-1", userId: "user-1" };
    await sessions.set({
      id: "upload-concurrent-tombstone",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "user-1",
      source,
      expiresAt: "2026-08-16T12:02:00.000Z"
    });

    await expect(
      prepareMediaSyncIntake({
        profile,
        event: event({ id: "message-concurrent-tombstone", type: "image" }),
        store: mediaStore,
        sessionStore: sessions,
        now: new Date("2026-08-16T12:00:00.000Z")
      })
    ).resolves.toMatchObject({ eligible: true, manual: false, workId: "work-1" });
    await expect(
      sessions.findPendingAttachment({
        profileName: "helper",
        source,
        requesterUserId: "user-1"
      })
    ).resolves.toBeUndefined();
    await expect(
      sessions.takeUploadIntent({
        profileName: "helper",
        source,
        requesterUserId: "user-1"
      })
    ).resolves.toMatchObject({ id: "upload-concurrent-tombstone" });
  });
});

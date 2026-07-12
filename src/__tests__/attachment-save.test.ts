import { describe, expect, it, vi } from "vitest";

import { InMemoryCatalogStore, type CatalogSourceRecord } from "../catalog/store.js";
import { createPendingAttachmentTextMessageHandler } from "../functions/attachment-save.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  GraphDriveClient,
  LineContentClient,
  TextMessageHandler,
  VirusScanner
} from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const pptxSha256 = "5702eec1ac8168696925fa05d9c3c0d9cc46153618daebfdad8a551907968dea";

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text", "file"],
    groupRequireWakeWord: true,
    wakeKeywords: ["xiaoha"],
    acceptMention: true,
    enabledFunctions: ["save_resource"]
  };
}

function context(text: string, requestId = "req-text"): FunctionHandlerContext {
  return {
    requestId,
    profile: profile(),
    event: {
      type: "message",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", text }
    }
  };
}

async function seedPendingAttachment(
  sessionStore: InMemorySessionStore,
  input: { fileName?: string; sizeBytes?: number } = {}
) {
  await sessionStore.set({
    id: "pending-attachment-1",
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_purpose",
    profileName: "helper",
    requesterUserId: "U1",
    source: { type: "group", groupId: "C1", userId: "U1" },
    attachment: {
      messageId: "file-1",
      messageType: "file",
      fileName: input.fileName ?? "OriginalDeck.pptx",
      fileSize: input.sizeBytes ?? pptxBytes.byteLength
    },
    expiresAt: "2026-07-11T10:10:00.000Z"
  });
}

async function setup(
  options: {
    scannerStatus?: "clean" | "infected" | "unavailable";
    pptWriteCapabilities?: string[];
  } = {}
): Promise<{
  sessionStore: InMemorySessionStore;
  catalog: InMemoryCatalogStore;
  graph: GraphDriveClient;
  lineContent: LineContentClient;
  scanner: VirusScanner;
  handler: TextMessageHandler;
  pptSource: CatalogSourceRecord;
}> {
  const sessionStore = new InMemorySessionStore({
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  const catalog = new InMemoryCatalogStore();
  const lineContent: LineContentClient = {
    getMessageContent: vi.fn().mockResolvedValue({
      data: pptxBytes,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    })
  };
  const graph: GraphDriveClient = {
    listFolderChildren: vi.fn(),
    createSharingLink: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue({
      id: "uploaded-ppt",
      driveId: "drive-1",
      name: "SundayDeck.pptx",
      path: "SundayDeck.pptx"
    })
  };
  const scanner: VirusScanner = {
    scan: vi.fn().mockResolvedValue({ status: options.scannerStatus ?? "clean" })
  };
  const handler = createPendingAttachmentTextMessageHandler({
    sessionStore,
    catalog,
    lineContent,
    graph,
    scanner,
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  const pptSource = await catalog.upsertSource({
    profileName: "helper",
    sourceKey: "ppt_slides",
    adapterType: "onedrive",
    domain: "presentation",
    defaultItemKind: "ppt_slide",
    rootLocation: { driveId: "drive-1", folderItemId: "ppt-root" },
    enabled: true,
    syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
    capabilities: {
      read: ["helper"],
      write: options.pptWriteCapabilities ?? ["helper:ppt_slide:write"]
    }
  });
  return { sessionStore, catalog, graph, lineContent, scanner, handler, pptSource };
}

describe("attachment save pipeline", () => {
  it("validates a pending attachment and creates a confirmation preview without uploading", async () => {
    const { sessionStore, catalog, graph, lineContent, scanner, handler } = await setup();
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck"));

    expect(result?.quickReplies).toHaveLength(2);
    expect(result?.replyText).toContain("OriginalDeck.pptx");
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(
      catalog.searchItems({ profileName: "helper", query: "SundayDeck", itemKinds: ["ppt_slide"] })
    ).resolves.toHaveLength(0);
    const pending = await sessionStore.findPendingAttachment({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      requesterUserId: "U1"
    });
    expect(pending).toMatchObject({
      stage: "awaiting_confirmation",
      target: { sourceKey: "ppt_slides", itemKind: "ppt_slide", title: "SundayDeck" }
    });
    expect(pending).not.toHaveProperty("preview");
  });

  it("fails closed when virus scanning is unavailable", async () => {
    const { sessionStore, catalog, graph, handler } = await setup({ scannerStatus: "unavailable" });
    await seedPendingAttachment(sessionStore);

    await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck"));
    const result = await handler.handle({ text: "保存" }, context("保存"));

    expect(result?.ok).toBe(true);
    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(
      catalog.searchItems({ profileName: "helper", query: "SundayDeck", itemKinds: ["ppt_slide"] })
    ).resolves.toHaveLength(0);
  });

  it("uploads to OneDrive and upserts catalog only after confirmation", async () => {
    const { sessionStore, catalog, graph, lineContent, scanner, handler } = await setup();
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result).toMatchObject({ executedAction: "save_resource" });
    expect(lineContent.getMessageContent).toHaveBeenCalledTimes(1);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(graph.uploadFile).toHaveBeenCalledWith(
      "drive-1",
      "ppt-root",
      "SundayDeck.pptx",
      pptxBytes,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    await expect(
      catalog.searchItems({ profileName: "helper", query: "SundayDeck", itemKinds: ["ppt_slide"] })
    ).resolves.toMatchObject([
      {
        title: "SundayDeck",
        itemKind: "ppt_slide",
        storageRef: { provider: "graph", driveId: "drive-1", itemId: "uploaded-ppt" }
      }
    ]);
  });

  it("refuses attachment publish when the target source has no write capability", async () => {
    const { sessionStore, graph, handler } = await setup({ pptWriteCapabilities: [] });
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck"));

    expect(result?.ok).toBe(true);
    expect(result?.quickReplies).toBeUndefined();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("does not upload a duplicate attachment when the same title and hash already exist", async () => {
    const { sessionStore, catalog, graph, handler, pptSource } = await setup();
    await catalog.upsertItem({
      sourceId: pptSource.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "SundayDeck",
      path: "SundayDeck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      sizeBytes: pptxBytes.byteLength,
      sha256: pptxSha256,
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "existing-ppt" }
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result?.ok).toBe(true);
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses same-title attachments with different file hashes", async () => {
    const { sessionStore, catalog, graph, handler, pptSource } = await setup();
    await catalog.upsertItem({
      sourceId: pptSource.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "SundayDeck",
      path: "SundayDeck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      sizeBytes: pptxBytes.byteLength,
      sha256: "different-sha",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "existing-ppt" }
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "ppt SundayDeck" }, context("ppt SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result?.ok).toBe(true);
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });
});

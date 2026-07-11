import { describe, expect, it, vi } from "vitest";

import { InMemoryCatalogStore } from "../catalog/store.js";
import { createPendingAttachmentTextMessageHandler } from "../functions/attachment-save.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  GraphDriveClient,
  LineContentClient,
  VirusScanner
} from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);

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
    wakeKeywords: ["小哈"],
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
      fileName: input.fileName ?? "原始檔名.pptx",
      fileSize: input.sizeBytes ?? pptxBytes.byteLength
    },
    expiresAt: "2026-07-11T10:10:00.000Z"
  });
}

function setup(
  options: {
    scannerStatus?: "clean" | "infected" | "unavailable";
    content?: { data: Uint8Array; contentType?: string };
    pptWriteCapabilities?: string[];
  } = {}
) {
  const sessionStore = new InMemorySessionStore({
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  const catalog = new InMemoryCatalogStore();
  const lineContent: LineContentClient = {
    getMessageContent: vi.fn().mockResolvedValue({
      data: options.content?.data ?? pptxBytes,
      contentType:
        options.content?.contentType ??
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    })
  };
  const graph: GraphDriveClient = {
    listFolderChildren: vi.fn(),
    createSharingLink: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue({
      id: "uploaded-ppt",
      driveId: "drive-1",
      name: "主日敬拜.pptx",
      path: "主日敬拜.pptx"
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
    sources: [
      {
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
      },
      {
        profileName: "helper",
        sourceKey: "xiaoha_database",
        adapterType: "manual",
        domain: "general",
        defaultItemKind: "church_document",
        rootLocation: {
          driveId: "drive-1",
          documentFolderItemId: "doc-root",
          imageFolderItemId: "image-root",
          otherFolderItemId: "other-root"
        },
        enabled: true,
        syncPolicy: { mode: "manual" },
        capabilities: { read: ["helper"], write: ["helper:church_database:write"] }
      }
    ],
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  return { sessionStore, catalog, lineContent, graph, scanner, handler };
}

describe("attachment save pipeline", () => {
  it("validates a pending attachment and creates a confirmation preview without uploading", async () => {
    const { sessionStore, catalog, graph, handler } = setup();
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜")
    );

    expect(result?.replyText).toContain("請確認要保存這個檔案");
    expect(result?.replyText).toContain("主日敬拜.pptx");
    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(
      catalog.searchItems({ profileName: "helper", query: "主日敬拜", itemKinds: ["ppt_slide"] })
    ).resolves.toHaveLength(0);
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      stage: "awaiting_confirmation",
      target: { sourceKey: "ppt_slides", itemKind: "ppt_slide", title: "主日敬拜" },
      preview: { fileName: "主日敬拜.pptx", sizeBytes: pptxBytes.byteLength }
    });
  });

  it("fails closed when virus scanning is unavailable", async () => {
    const { sessionStore, catalog, graph, handler } = setup({ scannerStatus: "unavailable" });
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜")
    );

    expect(result?.replyText).toContain("掃毒服務目前不可用");
    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(
      catalog.searchItems({ profileName: "helper", query: "主日敬拜", itemKinds: ["ppt_slide"] })
    ).resolves.toHaveLength(0);
  });

  it("uploads to OneDrive and upserts catalog only after confirmation", async () => {
    const { sessionStore, catalog, graph, handler } = setup();
    await seedPendingAttachment(sessionStore);
    await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜", "req-preview")
    );

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result).toMatchObject({ executedAction: "save_resource" });
    expect(result?.replyText).toContain("已保存：主日敬拜");
    expect(graph.uploadFile).toHaveBeenCalledWith(
      "drive-1",
      "ppt-root",
      "主日敬拜.pptx",
      pptxBytes,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    await expect(
      catalog.searchItems({ profileName: "helper", query: "主日敬拜", itemKinds: ["ppt_slide"] })
    ).resolves.toMatchObject([
      {
        title: "主日敬拜",
        itemKind: "ppt_slide",
        storageRef: { provider: "graph", driveId: "drive-1", itemId: "uploaded-ppt" }
      }
    ]);
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
  });

  it("stores generic church documents in the Xiaoha database document folder with 90-day retention", async () => {
    const { sessionStore, catalog, graph, handler } = setup({
      content: { data: pdfBytes, contentType: "application/pdf" }
    });
    await seedPendingAttachment(sessionStore, {
      fileName: "週報.pdf",
      sizeBytes: pdfBytes.byteLength
    });
    await handler.handle(
      { text: "保存到小哈資料庫 主日週報" },
      context("保存到小哈資料庫 主日週報", "req-preview")
    );

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result).toMatchObject({ executedAction: "save_resource" });
    expect(graph.uploadFile).toHaveBeenCalledWith(
      "drive-1",
      "doc-root",
      "主日週報.pdf",
      pdfBytes,
      "application/pdf"
    );
    await expect(
      catalog.searchItems({
        profileName: "helper",
        query: "主日週報",
        itemKinds: ["church_document"],
        allowedSourceKeys: ["xiaoha_database"]
      })
    ).resolves.toMatchObject([
      {
        title: "主日週報",
        itemKind: "church_document",
        domain: "general",
        expiresAt: "2026-10-09T10:00:00.000Z"
      }
    ]);
  });

  it("refuses attachment publish when the target source has no write capability", async () => {
    const { sessionStore, graph, handler } = setup({ pptWriteCapabilities: [] });
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜")
    );

    expect(result?.replyText).toContain("目標資料夾沒有開放寫入");
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("does not upload a duplicate attachment when the same title and hash already exist", async () => {
    const { sessionStore, catalog, graph, handler } = setup();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: { driveId: "drive-1", folderItemId: "ppt-root" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "主日敬拜",
      path: "主日敬拜.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      sizeBytes: pptxBytes.byteLength,
      sha256: "5702eec1ac8168696925fa05d9c3c0d9cc46153618daebfdad8a551907968dea",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "existing-ppt" }
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜", "req-preview")
    );

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result?.replyText).toContain("已經有相同檔案");
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses same-title attachments with different file hashes", async () => {
    const { sessionStore, catalog, graph, handler } = setup();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: { driveId: "drive-1", folderItemId: "ppt-root" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
    });
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "主日敬拜",
      path: "主日敬拜.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      sizeBytes: pptxBytes.byteLength,
      sha256: "different-sha",
      storageRef: { provider: "graph", driveId: "drive-1", itemId: "existing-ppt" }
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle(
      { text: "存成投影片 主日敬拜" },
      context("存成投影片 主日敬拜", "req-preview")
    );

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result?.replyText).toContain("已經有同名檔案");
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });
});

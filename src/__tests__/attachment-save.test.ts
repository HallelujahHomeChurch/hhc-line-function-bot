import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore, type AgentJobRecord } from "../agent/jobs.js";
import { InMemoryAttachmentScanQueue } from "../attachments/scan-queue.js";
import {
  InMemoryAttachmentScanWorkStore,
  type AttachmentScanWorkStore
} from "../attachments/scan-work-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { createPendingAttachmentTextMessageHandler } from "../functions/attachment-save.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  GraphDriveClient,
  LineContentClient,
  TextMessageHandler
} from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

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
  input: {
    fileName?: string;
    sizeBytes?: number;
    stage?: "awaiting_opt_in" | "awaiting_purpose" | "awaiting_title" | "awaiting_confirmation";
  } = {}
) {
  await sessionStore.set({
    id: "pending-attachment-1",
    type: "pending_attachment",
    action: "save_resource",
    stage: input.stage ?? "awaiting_purpose",
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
    pptWriteCapabilities?: string[];
  } = {}
): Promise<{
  sessionStore: InMemorySessionStore;
  catalog: InMemoryCatalogStore;
  agentJobStore: RecordingAgentJobStore;
  scanWorkStore: InMemoryAttachmentScanWorkStore;
  scanQueue: InMemoryAttachmentScanQueue;
  graph: GraphDriveClient;
  lineContent: LineContentClient;
  handler: TextMessageHandler;
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
  const agentJobStore = new RecordingAgentJobStore({
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  const scanWorkStore = new InMemoryAttachmentScanWorkStore({
    jobStore: agentJobStore,
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  const scanQueue = new InMemoryAttachmentScanQueue();
  const handler = createPendingAttachmentTextMessageHandler({
    sessionStore,
    catalog,
    agentJobStore,
    scanWorkStore,
    scanQueue,
    now: () => new Date("2026-07-11T10:00:00.000Z")
  });
  await catalog.upsertSource({
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
  for (const source of [
    {
      sourceKey: "pop_sheet_music",
      domain: "sheet_music",
      defaultItemKind: "pop_sheet",
      folderItemId: "pop-root"
    },
    {
      sourceKey: "hymn_sheet_music",
      domain: "sheet_music",
      defaultItemKind: "hymn_sheet",
      folderItemId: "hymn-root"
    },
    {
      sourceKey: "xiaoha_database",
      domain: "general",
      defaultItemKind: "church_document",
      folderItemId: "xiaoha-root"
    }
  ]) {
    await catalog.upsertSource({
      profileName: "helper",
      sourceKey: source.sourceKey,
      adapterType: "onedrive",
      domain: source.domain,
      defaultItemKind: source.defaultItemKind,
      rootLocation: { driveId: "drive-1", folderItemId: source.folderItemId },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper"], write: [`helper:${source.defaultItemKind}:write`] }
    });
  }
  return {
    sessionStore,
    catalog,
    agentJobStore,
    scanWorkStore,
    scanQueue,
    graph,
    lineContent,
    handler
  };
}

describe("attachment save pipeline", () => {
  it("asks for explicit opt-in before offering the four attachment purposes", async () => {
    const { sessionStore, graph, lineContent, handler } = await setup();
    await seedPendingAttachment(sessionStore, { stage: "awaiting_opt_in" });

    const result = await handler.handle({ text: "是" }, context("是"));

    expect(result?.replyText).toContain("保存成哪一種用途");
    expect(result?.quickReplies?.map((item) => item.label)).toEqual([
      "投影片",
      "流行歌譜",
      "詩歌歌譜",
      "小哈資料庫"
    ]);
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ stage: "awaiting_purpose" });
  });

  it("cancels an attachment at the opt-in stage without downloading it", async () => {
    const { sessionStore, lineContent, handler } = await setup();
    await seedPendingAttachment(sessionStore, { stage: "awaiting_opt_in" });

    const result = await handler.handle({ text: "否" }, context("否"));

    expect(result?.replyText).toContain("不保存");
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toBeUndefined();
  });

  it("collects purpose and title separately before creating the preview", async () => {
    const { sessionStore, graph, lineContent, handler } = await setup();
    await seedPendingAttachment(sessionStore);

    const purpose = await handler.handle({ text: "投影片" }, context("投影片"));
    expect(purpose?.replyText).toBe("請輸入這份檔案的名稱。");
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      stage: "awaiting_title",
      destination: { sourceKey: "ppt_slides", itemKind: "ppt_slide" }
    });

    const preview = await handler.handle(
      { text: "七月主日流程" },
      context("七月主日流程", "req-title")
    );
    expect(preview?.replyText).toContain("名稱：七月主日流程");
    expect(preview?.quickReplies?.map((item) => item.label)).toEqual(["保存", "取消"]);
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it.each([
    ["流行歌譜", "pop_sheet_music", "pop_sheet"],
    ["詩歌歌譜", "hymn_sheet_music", "hymn_sheet"],
    ["小哈資料庫", "xiaoha_database", "church_document"],
    ["教會資料", "xiaoha_database", "church_document"]
  ])("maps %s to its writable destination", async (answer, sourceKey, itemKind) => {
    const { sessionStore, handler } = await setup();
    await seedPendingAttachment(sessionStore);

    await handler.handle({ text: answer }, context(answer));

    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      stage: "awaiting_title",
      destination: { sourceKey, itemKind }
    });
  });

  it("requires a non-empty title", async () => {
    const { sessionStore, handler } = await setup();
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片"));

    const result = await handler.handle({ text: "   " }, context("   "));

    expect(result?.replyText).toBe("請輸入這份檔案的名稱。");
    await expect(
      sessionStore.findPendingAttachment({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ stage: "awaiting_title" });
  });

  it("validates a pending attachment and creates a confirmation preview without uploading", async () => {
    const { sessionStore, catalog, graph, lineContent, handler } = await setup();
    await seedPendingAttachment(sessionStore);

    await handler.handle({ text: "投影片" }, context("投影片"));
    const result = await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-title"));

    expect(result?.quickReplies).toHaveLength(2);
    expect(result?.replyText).toContain("OriginalDeck.pptx");
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
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

  it("does not show missing filename or unknown size for a LINE image", async () => {
    const { sessionStore, handler } = await setup();
    await sessionStore.set({
      id: "pending-image",
      type: "pending_attachment",
      action: "save_resource",
      stage: "awaiting_purpose",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1", userId: "U1" },
      attachment: { messageId: "image-1", messageType: "image" },
      expiresAt: "2026-07-11T10:10:00.000Z"
    });

    await handler.handle({ text: "小哈資料庫" }, context("小哈資料庫"));
    const preview = await handler.handle({ text: "活動照片" }, context("活動照片"));

    expect(preview?.replyText).toContain("來源：LINE 圖片");
    expect(preview?.replyText).not.toMatch(/未提供|未知/u);
  });

  it("creates requester-scoped pending job and opaque work only after final confirmation", async () => {
    const { sessionStore, agentJobStore, scanWorkStore, scanQueue, graph, lineContent, handler } =
      await setup();
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result).toMatchObject({
      executedAction: "save_resource",
      writePhase: "commit",
      quickReplies: [
        {
          label: "查看結果",
          action: { type: "postback", data: expect.stringContaining("action=agent_job_result") }
        }
      ]
    });
    expect(scanQueue.workIds).toHaveLength(1);
    const claimed = await scanWorkStore.claim(scanQueue.workIds[0]!);
    expect(claimed).toMatchObject({
      status: "claimed",
      jobId: agentJobStore.lastCreated?.id,
      lineMessageId: "file-1",
      scope: {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      },
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        title: "SundayDeck"
      }
    });
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U2"
      })
    ).resolves.toBeUndefined();
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("atomically takes final confirmation so concurrent replies enqueue only once", async () => {
    const { sessionStore, scanQueue, graph, handler } = await setup();
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const results = await Promise.all([
      handler.handle({ text: "保存" }, context("保存", "req-confirm-1")),
      handler.handle({ text: "保存" }, context("保存", "req-confirm-2"))
    ]);

    expect(scanQueue.workIds).toHaveLength(1);
    expect(graph.uploadFile).not.toHaveBeenCalled();
    expect(results.map((result) => result?.replyText).join("\n")).toContain("查看結果");
    expect(results.map((result) => result?.replyText).join("\n")).toContain("已經在處理或已完成");
  });

  it("fails closed when an ambiguous queue response has no durable outbox", async () => {
    const { sessionStore, catalog, agentJobStore, scanWorkStore, graph } = await setup();
    const handler = createPendingAttachmentTextMessageHandler({
      sessionStore,
      catalog,
      agentJobStore,
      scanWorkStore,
      scanQueue: {
        enqueue: async (workId) => {
          await scanWorkStore.claim(workId);
          throw new Error("response lost after acceptance");
        }
      },
      now: () => new Date("2026-07-11T10:00:00.000Z")
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result?.replyText).toContain("遇到問題");
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("reports retry scheduling only when the persisted work has a durable dispatcher", async () => {
    const { sessionStore, catalog, agentJobStore, scanWorkStore, graph } = await setup();
    const durableStore = Object.assign(scanWorkStore, {
      supportsDurableEnqueueRetry: true as const
    });
    const handler = createPendingAttachmentTextMessageHandler({
      sessionStore,
      catalog,
      agentJobStore,
      scanWorkStore: durableStore,
      scanQueue: {
        enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable before send"))
      },
      now: () => new Date("2026-07-11T10:00:00.000Z")
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result?.replyText).toContain("自動重試");
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ status: "pending" });
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses attachment publish when the target source has no write capability", async () => {
    const { sessionStore, graph, handler } = await setup({ pptWriteCapabilities: [] });
    await seedPendingAttachment(sessionStore);

    const result = await handler.handle({ text: "投影片" }, context("投影片"));

    expect(result?.ok).toBe(true);
    expect(result?.quickReplies).toBeUndefined();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("marks the requester-scoped job failed when queue handoff fails", async () => {
    const { sessionStore, agentJobStore, scanWorkStore, graph, lineContent } = await setup();
    const catalog = new InMemoryCatalogStore();
    await catalog.upsertSource({
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
    const handler = createPendingAttachmentTextMessageHandler({
      sessionStore,
      catalog,
      agentJobStore,
      scanWorkStore,
      scanQueue: {
        enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable"))
      },
      now: () => new Date("2026-07-11T10:00:00.000Z")
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result?.replyText).toContain("遇到問題");
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("marks the requester-scoped job failed and does not enqueue when work persistence fails", async () => {
    const { sessionStore, agentJobStore, catalog, graph, lineContent } = await setup();
    const scanQueue = new InMemoryAttachmentScanQueue();
    const scanWorkStore: AttachmentScanWorkStore = {
      supportsDurableEnqueueRetry: false,
      create: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      markEnqueued: vi.fn(),
      listPendingEnqueue: vi.fn(),
      claim: vi.fn(),
      cancelPendingEnqueue: vi.fn(),
      terminalStatus: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn()
    };
    const handler = createPendingAttachmentTextMessageHandler({
      sessionStore,
      catalog,
      agentJobStore,
      scanWorkStore,
      scanQueue,
      now: () => new Date("2026-07-11T10:00:00.000Z")
    });
    await seedPendingAttachment(sessionStore);
    await handler.handle({ text: "投影片" }, context("投影片", "req-purpose"));
    await handler.handle({ text: "SundayDeck" }, context("SundayDeck", "req-preview"));

    const result = await handler.handle({ text: "yes" }, context("yes", "req-confirm"));

    expect(result?.replyText).toContain("遇到問題");
    expect(scanQueue.workIds).toHaveLength(0);
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });
});

class RecordingAgentJobStore extends InMemoryAgentJobStore {
  lastCreated?: AgentJobRecord;

  override async createPending(
    input: Parameters<InMemoryAgentJobStore["createPending"]>[0]
  ): Promise<AgentJobRecord> {
    this.lastCreated = await super.createPending(input);
    return this.lastCreated;
  }
}

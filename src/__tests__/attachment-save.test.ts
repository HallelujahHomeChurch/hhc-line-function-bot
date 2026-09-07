import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore, type AgentJobRecord } from "../agent/jobs.js";
import { InMemoryAttachmentScanQueue } from "../attachments/scan-queue.js";
import {
  InMemoryAttachmentScanWorkStore,
  type AttachmentScanWorkStore
} from "../attachments/scan-work-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import {
  createPendingAttachmentDraftHandler,
  createPendingAttachmentPostbackHandler,
  createPendingAttachmentTextMessageHandler
} from "../transport/line/attachment-intake.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { handleAttachmentIntake } from "../transport/line/attachment-intake.js";
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
    enabledFunctions: ["save_resource"],
    permissionRequiredFunctions: []
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
    mediaSyncSourceKey?: string;
  } = {}
) {
  await sessionStore.set({
    id: "pending-attachment-1",
    type: "pending_attachment",
    action: "save_resource",
    stage: input.stage ?? "awaiting_purpose",
    profileName: "helper",
    requesterUserId: "U1",
    mediaSyncSourceKey: input.mediaSyncSourceKey,
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
  mediaSyncStore: { confirmManualPublication: ReturnType<typeof vi.fn> };
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
  const mediaSyncStore = {
    confirmManualPublication: vi.fn().mockResolvedValue(true)
  };
  const handler = createPendingAttachmentTextMessageHandler({
    sessionStore,
    catalog,
    agentJobStore,
    scanWorkStore,
    scanQueue,
    mediaSyncStore: mediaSyncStore as never,
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
    handler,
    mediaSyncStore
  };
}

describe("attachment save pipeline", () => {
  it("keeps an unrelated group attachment silent without entering a text handler", async () => {
    const pendingAttachment = {
      matches: vi.fn(async () => false),
      handle: vi.fn()
    };
    const uploadActivation = {
      matches: vi.fn(async () => false),
      handle: vi.fn()
    };
    const result = await handleAttachmentIntake({
      profile: profile(),
      event: {
        type: "message",
        source: { type: "group", groupId: "C1", userId: "U1" },
        message: { id: "file-unrelated", type: "file", fileName: "notes.pdf" }
      },
      requestId: "req-unrelated",
      sessionStore: new InMemorySessionStore(),
      maxAttachmentBytes: 25 * 1024 * 1024,
      now: new Date("2026-07-11T10:00:00.000Z"),
      textHandlers: [uploadActivation, pendingAttachment]
    });

    expect(result).toBeUndefined();
    expect(pendingAttachment.matches).not.toHaveBeenCalled();
    expect(uploadActivation.matches).not.toHaveBeenCalled();
  });

  it("confirms the existing media-sync work without creating another scan or download", async () => {
    const { sessionStore, agentJobStore, scanWorkStore, scanQueue, mediaSyncStore, handler } =
      await setup();
    const createScanWork = vi.spyOn(scanWorkStore, "create");
    await seedPendingAttachment(sessionStore, {
      stage: "awaiting_confirmation",
      mediaSyncSourceKey: "line:helper:message-1"
    });
    const pending = await sessionStore.findPendingAttachment({
      profileName: "helper",
      source: { type: "group", groupId: "C1", userId: "U1" },
      requesterUserId: "U1"
    });
    await sessionStore.set({
      ...pending!,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck",
        declaredFileName: "OriginalDeck.pptx"
      }
    });

    const result = await handler.handle({ text: "保存" }, context("保存", "req-confirm"));

    expect(result?.replyText).toContain("查看結果");
    expect(result?.quickReplies).toHaveLength(1);
    expect(mediaSyncStore.confirmManualPublication).toHaveBeenCalledWith({
      sourceKey: "line:helper:message-1",
      destinationId: "pending-attachment-1",
      requesterUserId: "U1",
      jobId: agentJobStore.lastCreated!.id,
      manualSourceKey: "ppt_slides",
      manualItemKind: "ppt_slide",
      manualDomain: "presentation",
      manualTitle: "SundayDeck"
    });
    expect(createScanWork).not.toHaveBeenCalled();
    expect(scanQueue.workIds).toEqual([]);
  });

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
    expect(preview?.quickReplies?.map((item) => item.label)).toEqual(["保存附件", "取消"]);
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
    expect(result?.replyText).toContain("下載、驗證並掃毒");
    expect(result?.replyText).toContain("保存並發布");
    expect(result?.replyText).not.toContain("OneDrive");
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
      },
      expiresAt: "2026-07-11T11:30:00.000Z"
    });
    await expect(
      agentJobStore.get(agentJobStore.lastCreated!.id, {
        profileName: "helper",
        sourceKey: "group:C1",
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({
      status: "pending",
      expiresAt: "2026-07-11T11:30:00.000Z"
    });
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

describe("helper attachment conversation", () => {
  it("keeps unrelated text out of the title and edits only explicit draft arguments", async () => {
    const fixture = await setup();
    await seedPendingAttachment(fixture.sessionStore);
    const draft = createPendingAttachmentDraftHandler({
      ...fixture,
      now: () => new Date("2026-07-11T10:00:00Z")
    });
    await expect(
      fixture.handler.matches({ text: "先查服事表" }, context("先查服事表"))
    ).resolves.toBe(false);
    await expect(draft({ purpose: "投影片" }, context("用途是投影片"))).resolves.toMatchObject({
      replyText: "請輸入這份檔案的名稱。"
    });
    await expect(draft({ title: "主日簡報" }, context("名稱是主日簡報"))).resolves.toMatchObject({
      replyText: expect.stringContaining("名稱：主日簡報")
    });
    await expect(draft({ title: "修正版" }, context("改名"))).resolves.toMatchObject({
      replyText: expect.stringContaining("名稱：修正版")
    });
    await expect(fixture.handler.matches({ text: "確認" }, context("確認"))).resolves.toBe(false);
    await expect(fixture.handler.matches({ text: "保存附件" }, context("保存附件"))).resolves.toBe(
      false
    );
    expect(fixture.lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(fixture.graph.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects stale preview buttons and atomically consumes only the reviewed snapshot", async () => {
    const fixture = await setup();
    await seedPendingAttachment(fixture.sessionStore);
    const draft = createPendingAttachmentDraftHandler({
      ...fixture,
      now: () => new Date("2026-07-11T10:00:00Z")
    });
    const approve = createPendingAttachmentPostbackHandler(fixture);
    const old = await draft({ purpose: "投影片", title: "原名稱" }, context("name"));
    const updated = await draft({ title: "新名稱" }, context("edit"));
    const request = (result: typeof old) => {
      const action = result.quickReplies![0]!.action;
      if (action.type !== "postback") throw new Error("expected_postback");
      return {
        action: "confirm_attachment",
        params: Object.fromEntries(new URLSearchParams(action.data))
      };
    };
    await expect(approve(request(old), context("approve"))).resolves.toMatchObject({
      replyText: expect.stringContaining("已失效")
    });
    const lookup = {
      profileName: "helper",
      source: context("").event.source,
      requesterUserId: "U1"
    };
    const snapshot = (await fixture.sessionStore.findPendingAttachment(lookup))!;
    await expect(
      fixture.sessionStore.takePendingAttachment(lookup, { ...snapshot, expiresAt: "wrong" })
    ).resolves.toBeUndefined();
    await expect(approve(request(updated), context("approve"))).resolves.toMatchObject({
      writePhase: "commit"
    });
    await expect(approve(request(updated), context("again"))).resolves.toMatchObject({
      replyText: expect.stringContaining("已失效")
    });
  });

  it("requires opt-in, rejects unknown fields and isolates requesters", async () => {
    const fixture = await setup();
    await seedPendingAttachment(fixture.sessionStore, { stage: "awaiting_opt_in" });
    const draft = createPendingAttachmentDraftHandler(fixture);
    await expect(draft({ title: "Test" }, context("name"))).resolves.toMatchObject({
      replyText: expect.stringContaining("要我幫忙保存")
    });
    await expect(draft({ purpose: "任意路徑" } as never, context("bad"))).resolves.toMatchObject({
      ok: false
    });
    const other = context("read");
    other.event.source.userId = "U2";
    await expect(draft({}, other)).resolves.toMatchObject({ ok: false });
  });
});

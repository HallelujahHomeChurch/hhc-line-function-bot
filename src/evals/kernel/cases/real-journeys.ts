import { InMemoryAgentMemoryStore } from "../../../agent/memory-store.js";
import { InMemoryAgentJobStore } from "../../../agent/jobs.js";
import type { AgentPlanner } from "../../../agent/planner.js";
import { InMemoryAttachmentScanQueue } from "../../../attachments/scan-queue.js";
import { InMemoryAttachmentScanWorkStore } from "../../../attachments/scan-work-store.js";
import { InMemoryCatalogStore, type CatalogDomain } from "../../../catalog/store.js";
import {
  createRetrieveMemoryHandler,
  createSaveMemoryHandler
} from "../../../functions/agent-memory-functions.js";
import { handleAttachmentMessage } from "../../../functions/attachment-entrance.js";
import { createPendingAttachmentTextMessageHandler } from "../../../functions/attachment-save.js";
import { createFindPopSheetMusicHandler } from "../../../functions/find-pop-sheet-music.js";
import { createFindPptSlidesHandler } from "../../../functions/find-ppt-slides.js";
import { createFindResourceHandler } from "../../../functions/find-resource.js";
import { createPendingFunctionTextMessageHandler } from "../../../functions/pending-function.js";
import { createQueryKnowledgeHandler } from "../../../functions/query-knowledge.js";
import { createUploadIntentTextMessageHandler } from "../../../functions/upload-intent.js";
import { InMemoryKnowledgeStore } from "../../../knowledge/store.js";
import { InMemorySessionStore } from "../../../state/session-store.js";
import type {
  AgentPlanRecord,
  BotProfileConfig,
  FunctionName,
  FunctionRegistry,
  GraphDriveClient
} from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelCaseObservation,
  KernelJourney,
  RecurrenceFamily
} from "../contracts.js";
import { createKernelRuntimeHarness } from "../runtime-harness.js";

const NOW = "2026-07-16T08:00:00.000Z";

export const REAL_JOURNEY_KERNEL_CASES: KernelAcceptanceCase[] = [
  realCatalogJourney("ppt", "find_ppt_slides", "presentation", "ppt_slide", ".pptx"),
  realCatalogJourney("sheet_music", "find_sheet_music", "sheet_music", "pop_sheet", ".pdf"),
  realCatalogJourney("resource", "find_resource", "general", "general_resource", ".pdf"),
  realKnowledgeJourney(),
  realMemoryJourney(),
  realWriteJourney(),
  realProviderUnavailableJourney("ppt", "find_ppt_slides"),
  realProviderUnavailableJourney("sheet_music", "find_sheet_music"),
  realAttachmentJourney(),
  realGroupAttachmentWithoutIntentJourney()
];

function realCatalogJourney(
  journey: Extract<KernelJourney, "ppt" | "sheet_music" | "resource">,
  capability: Extract<FunctionName, "find_ppt_slides" | "find_sheet_music" | "find_resource">,
  domain: CatalogDomain,
  itemKind: string,
  extension: string
): KernelAcceptanceCase {
  const id = `kernel-v1/${journey}/real-handler@1`;
  return acceptanceCase(id, journey, "stale_result_replay", async (context) => {
    const catalog = new InMemoryCatalogStore();
    const source = await catalog.upsertSource({
      profileName: "helper",
      sourceKey: `real_${journey}`,
      adapterType: "onedrive",
      domain,
      defaultItemKind: itemKind,
      rootLocation: { driveId: "drive", folderItemId: "folder" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15, allowedExtensions: [extension] },
      capabilities: { read: ["helper", capability], write: [] }
    });
    await catalog.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: source.revision,
      publishedAt: context.now().toISOString(),
      items: [
        {
          sourceId: source.id,
          itemKind,
          domain,
          title: "synthetic",
          extension,
          storageRef: { provider: "graph", driveId: "drive", itemId: `${journey}_item` }
        }
      ]
    });
    const graph = graphClient();
    const functions: FunctionRegistry = {
      [capability]:
        capability === "find_ppt_slides"
          ? createFindPptSlidesHandler({
              graph,
              catalog,
              driveId: "drive",
              folderItemId: "folder",
              allowedExtensions: ["pptx"],
              defaultIncludePdf: false,
              now: context.now
            })
          : capability === "find_sheet_music"
            ? createFindPopSheetMusicHandler({
                graph,
                catalog,
                driveId: "drive",
                folderItemId: "folder",
                allowedExtensions: ["pdf"],
                now: context.now
              })
            : createFindResourceHandler({ catalog, graph, now: context.now })
    };
    const harness = createKernelRuntimeHarness({
      now: context.now,
      profile: profile([capability]),
      functionRegistry: functions,
      planner: planner(capability, { query: "synthetic" })
    });
    const [result] = await harness.runTurns([
      { text: journeyText(journey), requesterUserId: "U_SYNTHETIC_1", requestId: id }
    ]);
    return { passed: result?.resultStatus === "success", elapsedMs: result?.elapsedMs ?? 9_000 };
  });
}

function realKnowledgeJourney(): KernelAcceptanceCase {
  const id = "kernel-v1/knowledge/real-handler@1";
  return acceptanceCase(id, "knowledge", "required_slot_misrouted", async (context) => {
    const store = new InMemoryKnowledgeStore(context.now);
    const source = await store.upsertSource({
      profileName: "helper",
      sourceKey: "real_knowledge",
      displayName: "測試知識",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.test/root",
      enabled: true,
      aliases: ["測試知識"],
      topics: ["synthetic"],
      sampleQueries: ["查知識 synthetic"]
    });
    await store.replaceDocument({
      sourceId: source.id,
      externalId: "doc",
      title: "測試文件",
      url: "https://example.test/doc",
      nodes: [],
      chunks: [{ headingPath: ["內容"], ordinal: 0, content: "synthetic answer", contentHash: "h" }]
    });
    await store.updateSource({
      profileName: "helper",
      sourceKey: "real_knowledge",
      syncStatus: "ready",
      lastSyncedAt: NOW
    });
    const functions: FunctionRegistry = { query_knowledge: createQueryKnowledgeHandler({ store }) };
    const harness = createKernelRuntimeHarness({
      now: context.now,
      profile: profile(["query_knowledge"]),
      functionRegistry: functions,
      planner: planner("query_knowledge", { query: "synthetic" })
    });
    const [result] = await harness.runTurns([
      { text: "查知識 synthetic", requesterUserId: "U_SYNTHETIC_1", requestId: id }
    ]);
    return { passed: result?.resultStatus === "success", elapsedMs: result?.elapsedMs ?? 9_000 };
  });
}

function realMemoryJourney(): KernelAcceptanceCase {
  const id = "kernel-v1/memory/real-handler@1";
  return acceptanceCase(id, "memory", "role_follow_up_lost", async (context) => {
    const memoryStore = new InMemoryAgentMemoryStore({ now: context.now });
    await memoryStore.saveTextMemory({
      profileName: "helper",
      source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_1" },
      createdBy: "U_SYNTHETIC_1",
      visibility: "private",
      title: "synthetic",
      content: "synthetic answer",
      query: "synthetic",
      expiresAt: new Date(context.now().getTime() + 60_000).toISOString()
    });
    const functions: FunctionRegistry = {
      retrieve_memory: createRetrieveMemoryHandler({ memoryStore })
    };
    const harness = createKernelRuntimeHarness({
      now: context.now,
      profile: profile(["retrieve_memory"]),
      functionRegistry: functions,
      planner: planner("retrieve_memory", { query: "synthetic" })
    });
    const [result] = await harness.runTurns([
      { text: "查我記住的資訊 synthetic", requesterUserId: "U_SYNTHETIC_1", requestId: id }
    ]);
    return { passed: result?.resultStatus === "success", elapsedMs: result?.elapsedMs ?? 9_000 };
  });
}

function realWriteJourney(): KernelAcceptanceCase {
  const id = "kernel-v1/write/real-preview-confirm@1";
  return acceptanceCase(id, "write", "pending_write_confirmation_escape", async (context) => {
    const memoryStore = new InMemoryAgentMemoryStore({ now: context.now });
    const sessionStore = new InMemorySessionStore({ now: context.now });
    const saveMemory = createSaveMemoryHandler({ memoryStore, sessionStore, now: context.now });
    const functions: FunctionRegistry = { save_memory: saveMemory };
    const harness = createKernelRuntimeHarness({
      now: context.now,
      profile: profile(["save_memory"]),
      functionRegistry: functions,
      textMessageHandlers: {
        pending_function: createPendingFunctionTextMessageHandler({ sessionStore, functions })
      },
      sessionStore,
      planner: planner("save_memory", { query: "synthetic payload", content: "synthetic payload" })
    });
    const results = await harness.runTurns([
      {
        text: "幫我記住 synthetic payload",
        requesterUserId: "U_SYNTHETIC_1",
        requestId: `${id}-preview`
      },
      { text: "保存", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-confirm` }
    ]);
    const saved = await memoryStore.searchTextMemories({
      profileName: "helper",
      source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_1" },
      requesterUserId: "U_SYNTHETIC_1",
      query: "synthetic",
      limit: 3
    });
    return {
      passed: results[0]?.replyText?.includes("要保存嗎") === true && saved.length === 1,
      elapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0)
    };
  });
}

function realProviderUnavailableJourney(
  journey: Extract<KernelJourney, "ppt" | "sheet_music">,
  capability: Extract<FunctionName, "find_ppt_slides" | "find_sheet_music">
): KernelAcceptanceCase {
  const id = `kernel-v1/${journey}/real-handler-unavailable@1`;
  return {
    id,
    version: 1,
    journey,
    recurrenceFamily: "unavailable_presented_as_not_found",
    boundary: "adapter_retrieval",
    async run(context) {
      const graph: GraphDriveClient = {
        listFolderChildren: async () => {
          throw new Error("provider_down");
        },
        createSharingLink: async () => "unused"
      };
      const functions: FunctionRegistry = {
        [capability]:
          capability === "find_ppt_slides"
            ? createFindPptSlidesHandler({
                graph,
                driveId: "drive",
                folderItemId: "folder",
                allowedExtensions: ["pptx"],
                defaultIncludePdf: false,
                now: context.now
              })
            : createFindPopSheetMusicHandler({
                graph,
                driveId: "drive",
                folderItemId: "folder",
                allowedExtensions: ["pdf"],
                recursive: false,
                now: context.now
              })
      };
      const harness = createKernelRuntimeHarness({
        now: context.now,
        profile: profile([capability]),
        functionRegistry: functions,
        planner: planner(capability, { query: "synthetic" })
      });
      const [result] = await harness.runTurns([
        { text: journeyText(journey), requesterUserId: "U_SYNTHETIC_1", requestId: id }
      ]);
      const passed = result?.resultStatus === "unavailable";
      return {
        ...observation(
          id,
          "unavailable_presented_as_not_found",
          passed,
          result?.elapsedMs ?? 9_000
        ),
        unavailableEligible: true,
        unavailableMisclassified: !passed
      };
    }
  };
}

function realAttachmentJourney(): KernelAcceptanceCase {
  const id = "kernel-v1/write/real-attachment-lifecycle@1";
  return acceptanceCase(id, "write", "group_requester_scope_leak", async (context) => {
    const sessionStore = new InMemorySessionStore({ now: context.now });
    const catalog = new InMemoryCatalogStore();
    await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: { driveId: "drive", folderItemId: "folder" },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["helper", "find_ppt_slides"], write: ["helper:ppt_slide:write"] }
    });
    const agentJobStore = new InMemoryAgentJobStore({ now: context.now });
    const scanWorkStore = new InMemoryAttachmentScanWorkStore({
      jobStore: agentJobStore,
      now: context.now
    });
    const scanQueue = new InMemoryAttachmentScanQueue();
    const pendingAttachment = createPendingAttachmentTextMessageHandler({
      sessionStore,
      catalog,
      agentJobStore,
      scanWorkStore,
      scanQueue,
      now: context.now
    });
    const activation = createUploadIntentTextMessageHandler({
      sessionStore,
      now: context.now,
      requestIdFactory: () => "attachment-intent"
    });
    const writeProfile = profile(["save_resource"]);
    writeProfile.allowedMessageTypes = ["text", "file"];
    const writeHarness = createKernelRuntimeHarness({
      now: context.now,
      profile: writeProfile,
      functionRegistry: {},
      textMessageHandlers: { activation, pending_attachment: pendingAttachment },
      sessionStore,
      planner: noPlanPlanner()
    });
    const [activated] = await writeHarness.runTurns([
      {
        text: "小哈我要上傳檔案",
        requesterUserId: "U_SYNTHETIC_1",
        requestId: `${id}-activate`
      }
    ]);
    const otherRequester = await handleAttachmentMessage({
      profile: writeProfile,
      event: attachmentEvent("U_SYNTHETIC_2"),
      requestId: `${id}-other`,
      sessionStore,
      maxAttachmentBytes: 1_024,
      now: context.now()
    });
    const accepted = await handleAttachmentMessage({
      profile: writeProfile,
      event: attachmentEvent("U_SYNTHETIC_1"),
      requestId: `${id}-attachment`,
      sessionStore,
      maxAttachmentBytes: 1_024,
      now: context.now()
    });
    const writeResults = await writeHarness.runTurns([
      { text: "是", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-opt-in` },
      { text: "投影片", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-purpose` },
      { text: "SundayDeck", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-title` },
      { text: "保存", requesterUserId: "U_SYNTHETIC_1", requestId: `${id}-confirm` }
    ]);
    const work = scanQueue.workIds[0] ? await scanWorkStore.claim(scanQueue.workIds[0]) : undefined;
    return {
      passed:
        activated?.replyText?.includes("兩分鐘") === true &&
        otherRequester === undefined &&
        accepted?.replyText.includes("要我幫忙保存") === true &&
        scanQueue.workIds.length === 1 &&
        writeResults[3]?.replyText?.includes("查看結果") === true &&
        work?.scope.requesterUserId === "U_SYNTHETIC_1" &&
        work?.lineMessageId === "synthetic-file",
      elapsedMs:
        (activated?.elapsedMs ?? 0) +
        writeResults.reduce((sum, result) => sum + result.elapsedMs, 0)
    };
  });
}

function realGroupAttachmentWithoutIntentJourney(): KernelAcceptanceCase {
  const id = "kernel-v1/write/real-group-attachment-silent@1";
  return acceptanceCase(id, "write", "write_safety_bypass", async (context) => {
    const sessionStore = new InMemorySessionStore({ now: context.now });
    const result = await handleAttachmentMessage({
      profile: profile(["save_resource"]),
      event: attachmentEvent("U_SYNTHETIC_1"),
      requestId: id,
      sessionStore,
      maxAttachmentBytes: 1_024,
      now: context.now()
    });
    const pending = await sessionStore.findPendingAttachment({
      profileName: "helper",
      source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_1" },
      requesterUserId: "U_SYNTHETIC_1"
    });
    return { passed: result === undefined && pending === undefined, elapsedMs: 1 };
  });
}

function acceptanceCase(
  id: string,
  journey: KernelJourney,
  recurrenceFamily: RecurrenceFamily,
  execute: (context: { now: () => Date }) => Promise<{ passed: boolean; elapsedMs: number }>
): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey,
    recurrenceFamily,
    boundary: "adapter_retrieval",
    async run(context) {
      const result = await execute(context);
      return observation(id, recurrenceFamily, result.passed, result.elapsedMs);
    }
  };
}

function observation(
  caseId: string,
  recurrenceFamily: RecurrenceFamily,
  passed: boolean,
  elapsedMs: number
): KernelCaseObservation {
  return {
    caseId,
    passed,
    boundary: "adapter_retrieval",
    recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: passed,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs,
    returnedRetrievableJob: false
  };
}

function planner(capability: FunctionName, argumentsRecord: AgentPlanRecord): AgentPlanner {
  return {
    propose: async () => ({
      status: "proposed",
      version: 1,
      disposition: "execute",
      capability,
      arguments: argumentsRecord,
      confidence: 0.99,
      provider: "deepseek",
      attempts: []
    })
  };
}

function noPlanPlanner(): AgentPlanner {
  return {
    propose: async () => ({ status: "no_plan", reasonCode: "no_candidates", attempts: [] })
  };
}

function profile(enabledFunctions: FunctionName[]): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions,
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function graphClient(): GraphDriveClient {
  return {
    listFolderChildren: async () => [],
    getItemById: async (_driveId, itemId) => ({
      id: itemId,
      name: "synthetic",
      driveId: "drive"
    }),
    createSharingLink: async () => "https://example.test/synthetic-link",
    uploadFile: async () => ({ id: "unused", name: "unused", driveId: "drive" })
  };
}

function journeyText(journey: "ppt" | "sheet_music" | "resource"): string {
  if (journey === "ppt") return "查投影片 synthetic";
  if (journey === "sheet_music") return "查歌譜 synthetic";
  return "查教會資料 synthetic";
}

function attachmentEvent(userId: string) {
  return {
    type: "message" as const,
    replyToken: "synthetic-reply-token",
    source: { type: "group" as const, groupId: "G_SYNTHETIC", userId },
    message: {
      type: "file" as const,
      id: "synthetic-file",
      fileName: "OriginalDeck.pptx",
      fileSize: 8
    }
  };
}

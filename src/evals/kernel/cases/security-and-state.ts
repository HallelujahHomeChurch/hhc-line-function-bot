import type { ActiveTaskContext } from "../../../agent/active-task.js";
import { InMemoryConversationWindowStore } from "../../../agent/context-manager.js";
import type { AgentPlanner } from "../../../agent/planner.js";
import { InMemoryCatalogStore } from "../../../catalog/store.js";
import { isSupportedAttachment } from "../../../functions/pending-attachment.js";
import { createResourceBinaryPublisher } from "../../../functions/resource-binary-publisher.js";
import { InMemorySessionStore } from "../../../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionName,
  FunctionRegistry,
  GraphDriveClient,
  TextMessageHandlerRegistry,
  VirusScanner
} from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelCaseObservation,
  RecurrenceFamily
} from "../contracts.js";
import { runKernelJourneyCheck } from "../journey-runtime.js";
import { createKernelRuntimeHarness } from "../runtime-harness.js";

export const SECURITY_AND_STATE_KERNEL_CASES: KernelAcceptanceCase[] = [
  safetyCase(
    "kernel-v1/write/bare-confirmation-precedence@1",
    "pending_write_confirmation_escape",
    pendingConfirmationPrecedesRecall
  ),
  safetyCase(
    "kernel-v1/write/unauthorized-save-denied@1",
    "write_safety_bypass",
    unauthorizedWriteDenied
  ),
  safetyCase(
    "kernel-v1/write/scan-unavailable-fails-closed@1",
    "write_safety_bypass",
    scanUnavailableFailsClosed
  ),
  safetyCase(
    "kernel-v1/write/group-attachment-without-intent-silent@1",
    "write_safety_bypass",
    groupWithoutIntentHasNoSession
  ),
  safetyCase(
    "kernel-v1/write/group-requester-cannot-complete-other-upload@1",
    "group_requester_scope_leak",
    attachmentRequesterIsolation
  ),
  safetyCase(
    "kernel-v1/state/group-requester-isolation@1",
    "group_requester_scope_leak",
    activeTaskRequesterIsolation
  ),
  safetyCase(
    "kernel-v1/state/expired-active-task-not-used@1",
    "role_follow_up_lost",
    expiredActiveTaskRejected
  ),
  safetyCase(
    "kernel-v1/write/write-evidence-required@1",
    "pending_write_confirmation_escape",
    missingWriteEvidenceDenied
  ),
  safetyCase(
    "kernel-v1/write/unsupported-binary-rejected@1",
    "write_safety_bypass",
    async () => !isSupportedAttachment({ type: "audio", id: "synthetic-audio" })
  ),
  safetyCase(
    "kernel-v1/state/replica-scope-key-stable@1",
    "replica_state_divergence",
    stableRequesterScope
  )
];

function safetyCase(
  id: string,
  recurrenceFamily: RecurrenceFamily,
  check: (now: Date) => Promise<boolean>
): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey: id.includes("/state/") ? "memory" : "write",
    recurrenceFamily,
    boundary: id.includes("/state/") ? "active_task_lifecycle" : "write_workflow",
    async run(context) {
      const result = await runKernelJourneyCheck({
        journey: id.includes("/state/") ? "memory" : "write",
        now: context.now,
        check: () => check(context.now()),
        requestId: id
      });
      const passed = result?.resultStatus === "success";
      return observation(id, recurrenceFamily, passed, result?.elapsedMs ?? 9_000);
    }
  };
}

async function pendingConfirmationPrecedesRecall(now: Date): Promise<boolean> {
  const handlers: TextMessageHandlerRegistry = {
    pending: {
      turnStage: "pending_function",
      matches: ({ text }) => text === "保存",
      handle: async () => ({ ok: true, replyText: "pending-confirmation" })
    },
    recall: {
      turnStage: "pre_route_recall",
      matches: ({ text }) => text === "保存",
      handle: async () => ({ ok: true, replyText: "incorrect-recall" })
    }
  };
  const harness = createKernelRuntimeHarness({
    now: () => now,
    profile: kernelProfile([]),
    functionRegistry: {},
    textMessageHandlers: handlers,
    planner: noPlanPlanner()
  });
  const [result] = await harness.runTurns([
    { text: "保存", requesterUserId: "U_SYNTHETIC_1", requestId: "pending-precedence" }
  ]);
  return result?.replyText === "pending-confirmation";
}

async function unauthorizedWriteDenied(now: Date): Promise<boolean> {
  let executions = 0;
  const harness = createKernelRuntimeHarness({
    now: () => now,
    profile: kernelProfile([]),
    functionRegistry: {
      save_resource: async () => {
        executions += 1;
        return { ok: true, replyText: "unsafe" };
      }
    },
    planner: executePlanner("save_resource", { title: "synthetic" })
  });
  const [result] = await harness.runTurns([
    {
      text: "保存這個檔案",
      requesterUserId: "U_SYNTHETIC_1",
      requestId: "unauthorized-save"
    }
  ]);
  return executions === 0 && result?.replyText !== "unsafe";
}

async function missingWriteEvidenceDenied(now: Date): Promise<boolean> {
  let executions = 0;
  const harness = createKernelRuntimeHarness({
    now: () => now,
    profile: kernelProfile(["save_memory"]),
    functionRegistry: {
      save_memory: async () => {
        executions += 1;
        return { ok: true, replyText: "unsafe" };
      }
    },
    planner: executePlanner("save_memory", { content: "synthetic payload" })
  });
  const [result] = await harness.runTurns([
    {
      text: "這是一段普通對話",
      requesterUserId: "U_SYNTHETIC_1",
      requestId: "missing-write-evidence"
    }
  ]);
  return executions === 0 && result?.replyText !== "unsafe";
}

async function scanUnavailableFailsClosed(now: Date): Promise<boolean> {
  const catalog = new InMemoryCatalogStore();
  await catalog.upsertSource({
    profileName: "helper",
    sourceKey: "synthetic_uploads",
    adapterType: "onedrive",
    domain: "presentation",
    defaultItemKind: "ppt_slide",
    rootLocation: { driveId: "drive", folderItemId: "folder" },
    enabled: true,
    syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
    capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
  });
  let uploads = 0;
  const graph: GraphDriveClient = {
    listFolderChildren: async () => [],
    createSharingLink: async () => "synthetic-link",
    uploadFile: async () => {
      uploads += 1;
      return { id: "item", driveId: "drive", name: "synthetic.pptx", path: "synthetic.pptx" };
    }
  };
  const scanner: VirusScanner = { scan: async () => ({ status: "unavailable" }) };
  const publisher = createResourceBinaryPublisher({
    catalog,
    graph,
    scanner,
    maxBytes: 1024
  });
  const result = await publisher.publish({
    binary: {
      data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
      declaredFileName: "synthetic.pptx",
      declaredContentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sourceKind: "line"
    },
    target: {
      profileName: "helper",
      sourceKey: "synthetic_uploads",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "synthetic"
    },
    now
  });
  return uploads === 0 && result.replyText.includes("掃毒服務目前不可用");
}

async function groupWithoutIntentHasNoSession(now: Date): Promise<boolean> {
  const sessions = new InMemorySessionStore({ now: () => now });
  return (
    (await sessions.takeUploadIntent({
      profileName: "helper",
      source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_1" },
      requesterUserId: "U_SYNTHETIC_1"
    })) === undefined
  );
}

async function attachmentRequesterIsolation(now: Date): Promise<boolean> {
  const sessions = new InMemorySessionStore({ now: () => now });
  await sessions.set({
    id: "pending-synthetic",
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_confirmation",
    profileName: "helper",
    requesterUserId: "U_SYNTHETIC_1",
    source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_1" },
    attachment: { messageId: "message", messageType: "file" },
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
  return (
    (await sessions.findPendingAttachment({
      profileName: "helper",
      source: { type: "group", groupId: "G_SYNTHETIC", userId: "U_SYNTHETIC_2" },
      requesterUserId: "U_SYNTHETIC_2"
    })) === undefined
  );
}

async function activeTaskRequesterIsolation(now: Date): Promise<boolean> {
  let executions = 0;
  const functions: FunctionRegistry = {
    retrieve_memory: async () => {
      executions += 1;
      return {
        ok: true,
        replyText: "synthetic-memory",
        agentResult: {
          status: "success",
          replyText: "synthetic-memory",
          anchors: { memoryId: "memory_opaque_1" },
          entities: [{ type: "memory", key: "memory_opaque_1", label: "記憶" }],
          evidence: [{ kind: "memory", reference: { memoryId: "memory_opaque_1" } }],
          supportedOperations: ["continue", "refine", "view_full"]
        }
      };
    }
  };
  const harness = createKernelRuntimeHarness({
    now: () => now,
    profile: kernelProfile(["retrieve_memory"]),
    functionRegistry: functions,
    planner: executePlanner("retrieve_memory", { query: "synthetic" })
  });
  const results = await harness.runTurns([
    {
      text: "查我記住的資訊 synthetic",
      requesterUserId: "U_SYNTHETIC_1",
      requestId: "memory-owner"
    },
    { text: "那一份呢", requesterUserId: "U_SYNTHETIC_2", requestId: "memory-other-user" }
  ]);
  return executions === 1 && results[0]?.resultStatus === "success" && !results[1]?.resultStatus;
}

async function expiredActiveTaskRejected(now: Date): Promise<boolean> {
  const store = new InMemoryConversationWindowStore({ now: () => now });
  await store.recordActiveTask({
    scope: { profileName: "helper", sourceKey: "group:G_SYNTHETIC", requesterUserId: "U1" },
    task: activeTask(new Date(now.getTime() - 120_000), 60_000),
    ttlMs: 60_000
  });
  return (
    (await store.activeTask({
      profileName: "helper",
      sourceKey: "group:G_SYNTHETIC",
      requesterUserId: "U1"
    })) === undefined
  );
}

async function stableRequesterScope(now: Date): Promise<boolean> {
  const first = new InMemoryConversationWindowStore({ now: () => now });
  const second = new InMemoryConversationWindowStore({ now: () => now });
  const scope = {
    profileName: "helper",
    sourceKey: "group:G_SYNTHETIC",
    requesterUserId: "U_SYNTHETIC"
  };
  await first.recordActiveTask({ scope, task: activeTask(now, 60_000), ttlMs: 60_000 });
  return Boolean(await first.activeTask(scope)) && (await second.activeTask(scope)) === undefined;
}

function activeTask(now: Date, ttlMs: number): ActiveTaskContext {
  return {
    version: 2,
    currentCapability: "query_schedule",
    allowedCapabilities: ["query_schedule"],
    anchors: { meeting: "synthetic" },
    entities: [{ type: "meeting", key: "synthetic", label: "聚會" }],
    supportedOperations: ["continue"],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
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
    boundary: caseId.includes("/state/") ? "active_task_lifecycle" : "write_workflow",
    recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: passed,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: passed ? [] : ["scope_leak"],
    performanceEligible: false,
    elapsedMs,
    returnedRetrievableJob: false
  };
}

function kernelProfile(enabledFunctions: FunctionName[]): BotProfileConfig {
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
    allowedProviders: ["deepseek", "ollama"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function executePlanner(
  capability: FunctionName,
  argumentsRecord: Record<string, string>
): AgentPlanner {
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

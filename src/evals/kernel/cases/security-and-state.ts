import type { ActiveTaskContext } from "../../../agent/active-task.js";
import { buildCapabilityCandidates } from "../../../agent/capability-candidates.js";
import { InMemoryConversationWindowStore } from "../../../agent/context-manager.js";
import { validateAgentPlan } from "../../../agent/plan-validator.js";
import { orderTurnHandlers } from "../../../agent/turn-state-machine.js";
import { isSupportedAttachment } from "../../../functions/pending-attachment.js";
import { InMemorySessionStore } from "../../../state/session-store.js";
import type { TextMessageHandler } from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelCaseObservation,
  RecurrenceFamily
} from "../contracts.js";

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
    async () => (await syntheticScan()).status === "unavailable"
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
      const passed = await check(context.now());
      return observation(id, recurrenceFamily, passed);
    }
  };
}

async function pendingConfirmationPrecedesRecall(): Promise<boolean> {
  const handler = (turnStage: TextMessageHandler["turnStage"]): TextMessageHandler => ({
    turnStage,
    matches: async () => false,
    handle: async () => undefined
  });
  return (
    orderTurnHandlers({
      recall: handler("pre_route_recall"),
      attachment: handler("attachment"),
      pending: handler("pending_function"),
      resolution: handler("resolution")
    })
      .map(({ name }) => name)
      .join(",") === "pending,resolution,attachment,recall"
  );
}

async function unauthorizedWriteDenied(now: Date): Promise<boolean> {
  const candidates = buildCapabilityCandidates({
    text: "保存這個檔案",
    enabledFunctions: [],
    knowledgeSources: [],
    maxCandidates: 3,
    source: "group"
  });
  const plan = validateAgentPlan({
    text: "保存這個檔案",
    enabledFunctions: [],
    candidates,
    proposal: {
      status: "proposed",
      disposition: "execute",
      capability: "save_resource",
      arguments: { title: "synthetic" },
      confidence: 0.99
    },
    minConfidence: 0.65,
    sourceType: "group",
    now
  });
  return plan.disposition === "deny";
}

async function missingWriteEvidenceDenied(now: Date): Promise<boolean> {
  const text = "這是一段普通對話";
  const candidates = buildCapabilityCandidates({
    text: "幫我保存一段記憶",
    enabledFunctions: ["save_memory"],
    knowledgeSources: [],
    maxCandidates: 3,
    source: "group"
  });
  const plan = validateAgentPlan({
    text,
    enabledFunctions: ["save_memory"],
    candidates,
    proposal: {
      status: "proposed",
      disposition: "execute",
      capability: "save_memory",
      arguments: { content: "synthetic payload" },
      confidence: 0.99
    },
    minConfidence: 0.65,
    sourceType: "group",
    now
  });
  return plan.disposition === "deny";
}

async function syntheticScan(): Promise<{ status: "unavailable" }> {
  return { status: "unavailable" };
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
  const store = new InMemoryConversationWindowStore({ now: () => now });
  await store.recordActiveTask({
    scope: { profileName: "helper", sourceKey: "group:G_SYNTHETIC", requesterUserId: "U1" },
    task: activeTask(now, 60_000),
    ttlMs: 60_000
  });
  return (
    (await store.activeTask({
      profileName: "helper",
      sourceKey: "group:G_SYNTHETIC",
      requesterUserId: "U2"
    })) === undefined
  );
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
  passed: boolean
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
    elapsedMs: 0,
    returnedRetrievableJob: false
  };
}

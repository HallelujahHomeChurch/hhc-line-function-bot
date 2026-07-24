import { InMemoryAgentJobStore } from "../../../agent/jobs.js";
import type { AgentPlanner } from "../../../agent/planner.js";
import { createControlledAgentRouter } from "../../../agent/controlled-agent-router.js";
import { InMemoryAttachmentScanWorkStore } from "../../../attachments/scan-work-store.js";
import {
  runAttachmentScanWorker,
  type AttachmentFileScanner,
  type ClamAvSignatureManifest
} from "../../../attachments/scan-worker.js";
import { InMemoryCatalogStore } from "../../../catalog/store.js";
import { createResourceBinaryPublisher } from "../../../functions/resource-binary-publisher.js";
import type { BotProfileConfig, GraphDriveClient, LineContentClient } from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelBoundary,
  KernelCaseObservation,
  RecurrenceFamily,
  SecurityViolation
} from "../contracts.js";

export const REMOTE_RUNTIME_KERNEL_CASES: KernelAcceptanceCase[] = [
  providerCase(
    "kernel-v1/resource/deepseek-unavailable-explicit@1",
    explicitProviderFailureRecoversDeterministically
  ),
  providerCase(
    "kernel-v1/resource/deepseek-unavailable-ambiguous@1",
    ambiguousProviderFailureClarifies,
    true
  ),
  attachmentCase("kernel-v1/write/signature-missing-no-publish@1", missingSignatureDoesNotPublish),
  attachmentCase("kernel-v1/write/signature-stale-no-publish@1", staleSignatureDoesNotPublish),
  attachmentCase("kernel-v1/write/infected-no-publish@1", infectedAttachmentDoesNotPublish),
  jobCase("kernel-v1/state/clean-job-requester-scope@1", cleanJobResultIsRequesterScoped)
];

function providerCase(
  id: string,
  check: (now: Date) => Promise<boolean>,
  ambiguityEligible = false
): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey: "resource",
    recurrenceFamily: "unavailable_presented_as_not_found",
    boundary: "deterministic_validation",
    async run(context) {
      const passed = await check(context.now());
      return observation({
        id,
        boundary: "deterministic_validation",
        recurrenceFamily: "unavailable_presented_as_not_found",
        passed,
        unavailableEligible: true,
        ambiguityEligible,
        ambiguityResolvedWithinTwoTurns: ambiguityEligible && passed
      });
    }
  };
}

function attachmentCase(id: string, check: (now: Date) => Promise<boolean>): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey: "write",
    recurrenceFamily: "write_safety_bypass",
    boundary: "write_workflow",
    async run(context) {
      const passed = await check(context.now());
      return observation({
        id,
        boundary: "write_workflow",
        recurrenceFamily: "write_safety_bypass",
        passed,
        securityViolation: "scan_bypass"
      });
    }
  };
}

function jobCase(id: string, check: (now: Date) => Promise<boolean>): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey: "write",
    recurrenceFamily: "group_requester_scope_leak",
    boundary: "active_task_lifecycle",
    async run(context) {
      const passed = await check(context.now());
      return observation({
        id,
        boundary: "active_task_lifecycle",
        recurrenceFamily: "group_requester_scope_leak",
        passed,
        securityViolation: "scope_leak",
        returnedRetrievableJob: passed
      });
    }
  };
}

async function explicitProviderFailureRecoversDeterministically(now: Date): Promise<boolean> {
  const router = createControlledAgentRouter({
    planner: unavailablePlanner(),
    now: () => now
  });
  const baseInput = {
    profileName: "helper",
    enabledFunctions: ["find_ppt_slides"] as const,
    sourceType: "user",
    maxCandidates: 3,
    minPlannerConfidence: 0.65
  };
  const collect = await router.resolve({ ...baseInput, text: "查投影片" });
  const execute = await router.resolve({ ...baseInput, text: "查投影片 synthetic" });
  return (
    collect.disposition === "collect" &&
    collect.capability === "find_ppt_slides" &&
    collect.reasonCode === "missing_required_slot" &&
    execute.disposition === "execute" &&
    execute.capability === "find_ppt_slides" &&
    execute.reasonCode === "deterministic_explicit_intent"
  );
}

async function ambiguousProviderFailureClarifies(now: Date): Promise<boolean> {
  const router = createControlledAgentRouter({
    planner: unavailablePlanner(),
    now: () => now
  });
  const result = await router.resolve({
    profileName: "helper",
    text: "synthetic",
    enabledFunctions: ["find_ppt_slides", "find_resource"],
    sourceType: "user",
    capabilityHints: {
      find_ppt_slides: ["synthetic"],
      find_resource: ["synthetic"]
    },
    maxCandidates: 3,
    minPlannerConfidence: 0.65
  });
  return result.disposition === "clarify" && result.reasonCode === "planner_unavailable";
}

async function missingSignatureDoesNotPublish(now: Date): Promise<boolean> {
  const fixture = await createScanFixture(now, undefined, "clean");
  const result = await runAttachmentScanWorker(fixture.workId, fixture.workerOptions);
  return (
    result.status === "failed" &&
    result.failureCode === "signature_stale" &&
    fixture.uploads() === 0
  );
}

async function staleSignatureDoesNotPublish(now: Date): Promise<boolean> {
  const fixture = await createScanFixture(
    now,
    {
      ...freshSignature(now),
      lastSuccessfulAt: new Date(now.getTime() - 72 * 60 * 60 * 1000 - 1).toISOString()
    },
    "clean"
  );
  const result = await runAttachmentScanWorker(fixture.workId, fixture.workerOptions);
  return (
    result.status === "failed" &&
    result.failureCode === "signature_stale" &&
    fixture.uploads() === 0
  );
}

async function infectedAttachmentDoesNotPublish(now: Date): Promise<boolean> {
  const fixture = await createScanFixture(now, freshSignature(now), "infected");
  const result = await runAttachmentScanWorker(fixture.workId, fixture.workerOptions);
  return (
    result.status === "failed" && result.failureCode === "scan_infected" && fixture.uploads() === 0
  );
}

async function cleanJobResultIsRequesterScoped(now: Date): Promise<boolean> {
  const fixture = await createScanFixture(now, freshSignature(now), "clean");
  const result = await runAttachmentScanWorker(fixture.workId, fixture.workerOptions);
  const ownerResult = await fixture.jobStore.get(fixture.jobId, fixture.scope);
  const foreignResult = await fixture.jobStore.get(fixture.jobId, {
    ...fixture.scope,
    requesterUserId: "U_SYNTHETIC_2"
  });
  return (
    result.status === "completed" &&
    fixture.uploads() === 1 &&
    ownerResult?.status === "completed" &&
    ownerResult.result?.executedAction === "save_resource" &&
    foreignResult === undefined
  );
}

function freshSignature(now: Date): ClamAvSignatureManifest {
  return {
    version: 1,
    signatureVersion: "synthetic-current",
    lastSuccessfulAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    databaseDirectory: "sets/synthetic-current"
  };
}

async function createScanFixture(
  now: Date,
  signatureManifest: ClamAvSignatureManifest | undefined,
  scanStatus: "clean" | "infected" | "unavailable"
) {
  const scope = {
    profileName: "helper",
    sourceKey: "group:G_SYNTHETIC",
    requesterUserId: "U_SYNTHETIC_1"
  };
  const jobStore = new InMemoryAgentJobStore({ now: () => now });
  const job = await jobStore.createPending({ scope, label: "scan", ttlMs: 60_000 });
  const workStore = new InMemoryAttachmentScanWorkStore({
    jobStore,
    now: () => now,
    idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
  });
  const work = await workStore.create({
    jobId: job.id,
    lineMessageId: "opaque-line-message",
    scope,
    target: {
      sourceKey: "synthetic_uploads",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "synthetic"
    },
    ttlMs: 60_000
  });
  await workStore.markEnqueued(work.id);
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
  let uploadCount = 0;
  const graph: GraphDriveClient = {
    listFolderChildren: async () => [],
    createSharingLink: async () => "synthetic-link",
    uploadFile: async () => {
      uploadCount += 1;
      return {
        id: "item",
        driveId: "drive",
        name: "synthetic.pptx",
        path: "synthetic.pptx"
      };
    }
  };
  const lineContent: LineContentClient = {
    async getMessageContent() {
      return {
        data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      };
    }
  };
  const scanner: AttachmentFileScanner = {
    scan: async () => ({ status: scanStatus })
  };
  return {
    scope,
    jobStore,
    jobId: job.id,
    workId: work.id,
    uploads: () => uploadCount,
    workerOptions: {
      workStore,
      lineContent,
      profiles: [kernelProfile()],
      publisher: createResourceBinaryPublisher({ catalog, graph }),
      scanner,
      readSignatureManifest: async () => signatureManifest,
      databaseDirectory: "/synthetic/signatures",
      maxBytes: 1_024,
      lineDownloadTimeoutMs: 1_000,
      now: () => now
    }
  };
}

function unavailablePlanner(): AgentPlanner {
  return {
    propose: async () => ({
      status: "no_plan",
      reasonCode: "providers_unavailable",
      attempts: [
        {
          provider: "deepseek",
          status: "unavailable",
          reason: "provider_unavailable",
          durationMs: 1,
          candidateCount: 1
        }
      ]
    })
  };
}

function kernelProfile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text", "file"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions: ["save_resource"],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function observation(input: {
  id: string;
  boundary: KernelBoundary;
  recurrenceFamily: RecurrenceFamily;
  passed: boolean;
  unavailableEligible?: boolean;
  ambiguityEligible?: boolean;
  ambiguityResolvedWithinTwoTurns?: boolean;
  securityViolation?: SecurityViolation;
  returnedRetrievableJob?: boolean;
}): KernelCaseObservation {
  return {
    caseId: input.id,
    passed: input.passed,
    boundary: input.boundary,
    recurrenceFamily: input.recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: input.passed,
    unavailableEligible: input.unavailableEligible ?? false,
    unavailableMisclassified: input.unavailableEligible ? !input.passed : false,
    ambiguityEligible: input.ambiguityEligible ?? false,
    ambiguityResolvedWithinTwoTurns: input.ambiguityResolvedWithinTwoTurns ?? false,
    securityViolations: input.passed || !input.securityViolation ? [] : [input.securityViolation],
    performanceEligible: true,
    elapsedMs: 1,
    returnedRetrievableJob: input.returnedRetrievableJob ?? false
  };
}

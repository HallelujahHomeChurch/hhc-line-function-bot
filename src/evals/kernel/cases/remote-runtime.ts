import { InMemoryAgentJobStore } from "../../../agent/jobs.js";
import type { AgentPlanner } from "../../../agent/planner.js";
import { createControlledAgentRouter } from "../../../agent/controlled-agent-router.js";
import { InMemoryAttachmentScanWorkStore } from "../../../attachments/scan-work-store.js";
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
  attachmentCase(
    "kernel-v1/write/reclaimed-claim-publication-fenced@1",
    reclaimedClaimCannotPublish
  ),
  attachmentCase("kernel-v1/write/expired-scan-work-disposable@1", expiredScanWorkIsDisposable)
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

async function reclaimedClaimCannotPublish(now: Date): Promise<boolean> {
  let current = now;
  let claimSequence = 0;
  const scope = {
    profileName: "helper",
    sourceKey: "user:U_SYNTHETIC_1",
    requesterUserId: "U_SYNTHETIC_1"
  };
  const jobStore = new InMemoryAgentJobStore({ now: () => current });
  const job = await jobStore.createPending({ scope, label: "scan", ttlMs: 600_000 });
  const workStore = new InMemoryAttachmentScanWorkStore({
    jobStore,
    now: () => current,
    claimLeaseMs: 60_000,
    publishingLeaseMs: 120_000,
    claimIdFactory: () => `synthetic-claim-${++claimSequence}`
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
    ttlMs: 600_000
  });
  await workStore.markEnqueued(work.id);
  const stale = await workStore.claim(work.id);
  current = new Date(now.getTime() + 60_000);
  const replacement = await workStore.claim(work.id);
  if (!stale?.claimId || !replacement?.claimId) return false;

  const staleFenced = !(await workStore.beginPublishing(work.id, stale.claimId));
  const replacementFenced = await workStore.beginPublishing(work.id, replacement.claimId);
  const redelivery = await workStore.claimForProcessing(work.id);
  return staleFenced && replacementFenced && redelivery.disposition === "active";
}

async function expiredScanWorkIsDisposable(now: Date): Promise<boolean> {
  let current = now;
  const scope = {
    profileName: "helper",
    sourceKey: "user:U_SYNTHETIC_1",
    requesterUserId: "U_SYNTHETIC_1"
  };
  const jobStore = new InMemoryAgentJobStore({ now: () => current });
  const job = await jobStore.createPending({ scope, label: "scan", ttlMs: 1 });
  const workStore = new InMemoryAttachmentScanWorkStore({
    jobStore,
    now: () => current
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
    ttlMs: 1
  });
  await workStore.markEnqueued(work.id);
  current = new Date(now.getTime() + 1);
  return (await workStore.claimForProcessing(work.id)).disposition === "missing";
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

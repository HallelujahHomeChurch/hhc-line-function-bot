import { describe, expect, it } from "vitest";

import {
  classifyKernelLocalLiveInfrastructureFailure,
  evaluateKernelLocalLiveOutcome,
  finalizeKernelLocalLiveSuiteResult,
  isKernelLocalLiveDuplicateAcknowledgement
} from "../evals/kernel/local-live/driver.js";
import type { AgentTurnTraceRecord, AgentTurnTraceStep } from "../agent/trace-store.js";

describe("Kernel local live journey outcome evaluation", () => {
  it.each([
    {
      caseId: "schedule-explicit" as const,
      steps: [
        {
          phase: "plan_validation",
          disposition: "execute",
          action: "query_schedule",
          validatorReason: "deterministic_explicit_intent"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "write" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        disposition: "execute",
        capability: "query_schedule",
        resultClass: "success"
      }
    },
    {
      caseId: "schedule-refinement" as const,
      steps: [
        {
          phase: "plan_validation",
          disposition: "execute",
          action: "query_schedule",
          validatorReason: "active_task_refinement"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "replace" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        validatorReason: "active_task_refinement",
        lifecycleOutcome: "replace"
      }
    },
    {
      caseId: "schedule-ambiguity" as const,
      steps: [
        { phase: "slot_clarification", disposition: "collect" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: { passed: true, disposition: "collect" }
    },
    {
      caseId: "capability-switch" as const,
      steps: [
        {
          phase: "plan_validation",
          disposition: "execute",
          action: "query_knowledge",
          validatorReason: "explicit_capability_switch"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "replace" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        capability: "query_knowledge",
        validatorReason: "explicit_capability_switch"
      }
    },
    {
      caseId: "knowledge-follow-up" as const,
      steps: [
        {
          phase: "plan_validation",
          disposition: "execute",
          action: "query_knowledge",
          validatorReason: "active_task_refinement"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "replace" }
      ] satisfies AgentTurnTraceStep[],
      observations: [
        {
          caseId: "knowledge-follow-up" as const,
          kind: "provider",
          provider: "azure_openai",
          ordinal: 1,
          outcome: "success"
        },
        {
          caseId: "knowledge-follow-up" as const,
          kind: "provider",
          provider: "azure_openai",
          ordinal: 2,
          outcome: "success"
        }
      ],
      expected: {
        passed: true,
        capability: "query_knowledge",
        resultClass: "success"
      }
    },
    {
      caseId: "group-requester-isolation" as const,
      steps: [
        { phase: "active_task", outcome: "missing", lifecycleOutcome: "missing" },
        { phase: "controlled_route", disposition: "chat" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: { passed: true, lifecycleOutcome: "missing" }
    },
    {
      caseId: "provider-unavailable" as const,
      steps: [
        { phase: "planner", outcome: "unavailable", provider: "deepseek" },
        {
          phase: "plan_validation",
          disposition: "deny",
          validatorReason: "planner_unavailable"
        }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        disposition: "deny",
        validatorReason: "planner_unavailable"
      }
    },
    {
      caseId: "write-preview-confirm" as const,
      steps: [
        { phase: "text_handler", action: "save_resource", outcome: "handled" }
      ] satisfies AgentTurnTraceStep[],
      observations: [
        {
          caseId: "write-preview-confirm" as const,
          kind: "queue",
          ordinal: 1,
          outcome: "queued"
        }
      ],
      expected: { passed: true, capability: "save_resource" }
    }
  ])("accepts the bounded $caseId evidence", ({ caseId, steps, observations, expected }) => {
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId,
        traces: [trace(steps)],
        observations
      })
    ).toMatchObject(expected);
  });

  it("fails closed when a required queue or requester-isolation observation is absent", () => {
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "write-preview-confirm",
        traces: [trace([{ phase: "text_handler", action: "save_resource", outcome: "handled" }])],
        observations: []
      })
    ).toMatchObject({
      passed: false,
      failureCode: "journey_assertion_failed"
    });
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "group-requester-isolation",
        traces: [
          trace([
            { phase: "active_task", outcome: "present", lifecycleOutcome: "read" },
            { phase: "function", action: "query_schedule", outcome: "success" }
          ])
        ],
        observations: []
      })
    ).toMatchObject({
      passed: false,
      failureCode: "journey_assertion_failed"
    });
  });

  it("finalizes the allowlisted suite result only after host cleanup", () => {
    const suite = {
      schemaVersion: 1,
      caseSetVersion: 1,
      startedAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:01:00.000Z",
      commit: "a".repeat(40),
      selectedCaseIds: ["schedule-explicit"],
      passed: true,
      cases: [{ caseId: "schedule-explicit", passed: true }],
      providers: { deepSeekRequests: 1, embeddingBatches: 0 },
      cleanup: { namespace: true }
    };

    expect(
      finalizeKernelLocalLiveSuiteResult(suite, {
        compose: true,
        secretFiles: true
      })
    ).toMatchObject({
      passed: true,
      cleanup: {
        namespace: true,
        compose: true,
        secretFiles: true,
        passed: true
      }
    });
    expect(
      finalizeKernelLocalLiveSuiteResult(suite, {
        compose: false,
        secretFiles: true
      })
    ).toMatchObject({ passed: false, cleanup: { passed: false } });
    expect(() =>
      finalizeKernelLocalLiveSuiteResult(
        { ...suite, rawMessage: "must never enter a report" },
        { compose: true, secretFiles: true }
      )
    ).toThrow("kernel_local_live_suite_result_invalid");
  });

  it("classifies infrastructure failures without serializing error text", () => {
    expect(
      classifyKernelLocalLiveInfrastructureFailure(
        new Error("kernel_local_live_invalid_signature_failed")
      )
    ).toBe("invalid_signature_failed");
    expect(classifyKernelLocalLiveInfrastructureFailure(new Error("raw provider response"))).toBe(
      "dependency_unavailable"
    );
  });

  it("accepts the production duplicate webhook acknowledgement contract", () => {
    expect(
      isKernelLocalLiveDuplicateAcknowledgement({
        ok: true,
        allowedEvents: 1,
        ignored: "duplicate_webhook_event"
      })
    ).toBe(true);
    expect(
      isKernelLocalLiveDuplicateAcknowledgement({
        ok: true,
        allowedEvents: 1
      })
    ).toBe(false);
  });
});

function trace(steps: AgentTurnTraceStep[]): AgentTurnTraceRecord {
  return {
    occurredAt: "2026-07-26T00:00:00.000Z",
    profileName: "acceptance",
    sourceType: "user",
    steps
  };
}

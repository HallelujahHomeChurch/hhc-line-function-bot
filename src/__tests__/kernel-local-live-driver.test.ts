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
          validatorReason: "explicit_intent"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "replace" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        capability: "query_knowledge",
        validatorReason: "explicit_intent"
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
        {
          phase: "plan_validation",
          disposition: "execute",
          action: "query_schedule",
          validatorReason: "explicit_intent"
        },
        { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "write" }
      ] satisfies AgentTurnTraceStep[],
      observations: [],
      expected: {
        passed: true,
        capability: "query_schedule",
        validatorReason: "explicit_intent",
        resultClass: "success"
      }
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
    const traces =
      caseId === "schedule-refinement"
        ? [successfulTrace("query_schedule"), trace(steps)]
        : caseId === "capability-switch"
          ? [successfulTrace("query_schedule"), trace(steps)]
          : caseId === "knowledge-follow-up"
            ? [successfulTrace("query_knowledge"), trace(steps)]
            : caseId === "write-preview-confirm"
              ? Array.from({ length: 5 }, () => trace(steps))
              : [trace(steps)];
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId,
        traces,
        observations: [
          ...observations.filter(({ kind }) => kind !== "provider"),
          ...successfulProviderObservations(caseId),
          ...(caseId === "write-preview-confirm"
            ? [
                {
                  caseId: "write-preview-confirm" as const,
                  kind: "scan_work",
                  ordinal: 1,
                  outcome: "queued"
                }
              ]
            : [])
        ],
        replyQuickReplyLabels:
          caseId === "write-preview-confirm" ? writeReplyQuickReplyLabels() : [],
        preFinalQueueDetected: false
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

  it("rejects partial multi-turn evidence and a queue emitted before confirmation", () => {
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "capability-switch",
        traces: [successfulTrace("query_knowledge")],
        observations: []
      })
    ).toMatchObject({
      passed: false,
      failureCode: "journey_assertion_failed"
    });
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "write-preview-confirm",
        traces: Array.from({ length: 5 }, () =>
          trace([{ phase: "text_handler", action: "save_resource", outcome: "handled" }])
        ),
        observations: [
          {
            caseId: "write-preview-confirm",
            kind: "queue",
            ordinal: 1,
            outcome: "queued"
          },
          {
            caseId: "write-preview-confirm",
            kind: "scan_work",
            ordinal: 1,
            outcome: "queued"
          }
        ],
        replyQuickReplyLabels: writeReplyQuickReplyLabels(),
        preFinalQueueDetected: true
      })
    ).toMatchObject({
      passed: false,
      failureCode: "journey_assertion_failed"
    });
  });

  it("requires exact successful provider evidence and rejects budget exhaustion", () => {
    const traces = [successfulTrace("query_schedule")];
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "schedule-explicit",
        traces,
        observations: []
      })
    ).toMatchObject({ passed: false });
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "schedule-explicit",
        traces,
        observations: [
          ...successfulProviderObservations("schedule-explicit"),
          {
            caseId: "schedule-explicit",
            kind: "provider",
            provider: "deepseek",
            ordinal: 2,
            outcome: "budget_exhausted"
          }
        ]
      })
    ).toMatchObject({ passed: false });
  });

  it("reports the allowlisted schedule-refinement boundary that failed", () => {
    expect(
      evaluateKernelLocalLiveOutcome({
        caseId: "schedule-refinement",
        traces: [successfulTrace("query_schedule")],
        observations: successfulProviderObservations("schedule-refinement")
      })
    ).toMatchObject({
      passed: false,
      failureCode: "turn_count_failed"
    });

    const initialFailureCases = [
      {
        steps: [{ phase: "plan_validation", disposition: "chat" }],
        failureCode: "initial_capability_failed"
      },
      {
        steps: [
          { phase: "plan_validation", action: "query_schedule" },
          { phase: "result_envelope", resultStatus: "not_found" }
        ],
        failureCode: "initial_result_not_found"
      },
      {
        steps: [
          { phase: "plan_validation", action: "query_schedule" },
          { phase: "result_envelope", resultStatus: "ambiguous" }
        ],
        failureCode: "initial_result_ambiguous"
      },
      {
        steps: [
          { phase: "plan_validation", action: "query_schedule" },
          { phase: "result_envelope", resultStatus: "unavailable" }
        ],
        failureCode: "initial_result_unavailable"
      },
      {
        steps: [{ phase: "plan_validation", action: "query_schedule" }],
        failureCode: "initial_result_missing"
      }
    ] satisfies Array<{ steps: AgentTurnTraceStep[]; failureCode: string }>;

    for (const { steps, failureCode } of initialFailureCases) {
      expect(
        evaluateKernelLocalLiveOutcome({
          caseId: "schedule-refinement",
          traces: [trace(steps), successfulTrace("query_schedule")],
          observations: successfulProviderObservations("schedule-refinement")
        })
      ).toMatchObject({ passed: false, failureCode });
    }
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

function successfulTrace(action: "query_schedule" | "query_knowledge"): AgentTurnTraceRecord {
  return trace([
    {
      phase: "plan_validation",
      disposition: "execute",
      action,
      validatorReason: "explicit_intent"
    },
    { phase: "result_envelope", resultStatus: "success", lifecycleOutcome: "write" }
  ]);
}

function successfulProviderObservations(
  caseId: Parameters<typeof evaluateKernelLocalLiveOutcome>[0]["caseId"]
) {
  const counts = {
    "schedule-explicit": [1, 0],
    "schedule-refinement": [2, 0],
    "schedule-ambiguity": [1, 0],
    "capability-switch": [2, 1],
    "knowledge-follow-up": [2, 2],
    "group-requester-isolation": [1, 0],
    "provider-unavailable": [0, 0],
    "write-preview-confirm": [0, 0]
  }[caseId]!;
  return [
    ...Array.from({ length: counts[0] }, (_, index) => ({
      caseId,
      kind: "provider",
      provider: "deepseek",
      ordinal: index + 1,
      outcome: "success"
    })),
    ...Array.from({ length: counts[1] }, (_, index) => ({
      caseId,
      kind: "provider",
      provider: "azure_openai",
      ordinal: index + 1,
      outcome: "success"
    }))
  ];
}

function writeReplyQuickReplyLabels(): string[][] {
  return [
    ["是", "否"],
    ["投影片", "流行歌譜", "詩歌歌譜", "小哈資料庫"],
    [],
    ["保存", "取消"],
    ["查看結果"]
  ];
}

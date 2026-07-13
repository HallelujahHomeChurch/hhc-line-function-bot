import { describe, expect, it } from "vitest";

import { formatAgentTurnTraces, InMemoryAgentTraceStore } from "../agent/trace-store.js";

const sensitiveValues = [
  "王小明",
  "https://example.invalid/private?token=abc",
  "主日服事表.xlsx",
  "invite_code=SECRET123",
  "system prompt with evidence",
  "drive-item-secret"
];

describe("controlled agent trace sanitization", () => {
  it("keeps only bounded diagnostics for controlled-agent phases", async () => {
    const store = new InMemoryAgentTraceStore(10);

    await store.record({
      requestId: "req-1",
      occurredAt: "2026-07-14T00:00:00.000Z",
      profileName: "helper",
      sourceType: "group",
      steps: [
        {
          phase: "active_task",
          outcome: "present",
          lifecycleOutcome: "preserve",
          action: "query_schedule",
          prompt: sensitiveValues[4]
        },
        {
          phase: "capability_candidates",
          candidates: ["query_schedule", "query_knowledge", sensitiveValues[0]],
          candidateCount: 3,
          sourceUrl: sensitiveValues[1]
        },
        {
          phase: "planner",
          provider: "deepseek",
          disposition: "continue",
          confidenceBucket: "high",
          confidence: 0.97,
          evidence: sensitiveValues[5],
          reason: sensitiveValues[0],
          lane: sensitiveValues[2]
        },
        {
          phase: "plan_validation",
          outcome: "accepted",
          disposition: "execute",
          validatorReason: "active_task_refinement",
          action: "query_schedule",
          person: sensitiveValues[0]
        },
        {
          phase: "result_envelope",
          resultStatus: "success",
          anchorCount: 2,
          entityTypes: ["meeting", "role", sensitiveValues[2]],
          outcome: sensitiveValues[0],
          action: sensitiveValues[5],
          filename: sensitiveValues[2],
          url: sensitiveValues[1]
        }
      ] as never
    });

    await expect(store.list()).resolves.toEqual([
      {
        requestId: "req-1",
        occurredAt: "2026-07-14T00:00:00.000Z",
        profileName: "helper",
        sourceType: "group",
        steps: [
          {
            phase: "active_task",
            outcome: "present",
            action: "query_schedule",
            lifecycleOutcome: "preserve"
          },
          {
            phase: "capability_candidates",
            candidates: ["query_schedule", "query_knowledge"],
            candidateCount: 3
          },
          {
            phase: "planner",
            provider: "deepseek",
            disposition: "continue",
            confidenceBucket: "high"
          },
          {
            phase: "plan_validation",
            outcome: "accepted",
            action: "query_schedule",
            disposition: "execute",
            validatorReason: "active_task_refinement"
          },
          {
            phase: "result_envelope",
            resultStatus: "success",
            anchorCount: 2,
            entityTypes: ["meeting", "role"]
          }
        ]
      }
    ]);
  });

  it("formats useful controlled diagnostics without raw content", async () => {
    const store = new InMemoryAgentTraceStore(10);
    await store.record({
      requestId: "req-2",
      occurredAt: "2026-07-14T00:00:00.000Z",
      profileName: "helper",
      sourceType: "user",
      steps: [
        {
          phase: "capability_candidates",
          candidates: ["query_schedule"],
          candidateCount: 1
        },
        {
          phase: "plan_validation",
          outcome: "accepted",
          disposition: "execute",
          validatorReason: "explicit_intent"
        },
        {
          phase: "result_envelope",
          resultStatus: "not_found",
          anchorCount: 0,
          entityTypes: []
        }
      ] as never
    });

    const formatted = formatAgentTurnTraces(await store.list());

    expect(formatted).toContain("candidates:query_schedule");
    expect(formatted).toContain("count:1");
    expect(formatted).toContain("disposition:execute");
    expect(formatted).toContain("validator:explicit_intent");
    expect(formatted).toContain("status:not_found");
    for (const sensitive of sensitiveValues) expect(formatted).not.toContain(sensitive);
  });
});

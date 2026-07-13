import { describe, expect, it } from "vitest";

import type { ActiveTaskContext } from "../agent/active-task.js";
import { validateAgentPlan, type ValidateAgentPlanInput } from "../agent/plan-validator.js";
import { hasExplicitWriteEvidence } from "../functions/argument-normalization.js";

const now = new Date("2026-07-13T00:00:30.000Z");

const scheduleTask: ActiveTaskContext = {
  version: 1,
  capability: "query_schedule",
  anchors: { date: "2026-07-14", meeting: "晨更" },
  entities: [
    {
      type: "role",
      key: "front-camera",
      label: "前攝影",
      aliases: ["攝影"]
    }
  ],
  supportedOperations: ["continue", "refine", "advance"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

function input(overrides: Partial<ValidateAgentPlanInput> = {}): ValidateAgentPlanInput {
  return {
    text: "查主日服事",
    enabledFunctions: ["query_schedule"],
    candidates: [{ capability: "query_schedule", reason: "explicit_intent", score: 400 }],
    proposal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "主日服事" },
      confidence: 0.95
    },
    minConfidence: 0.65,
    sourceType: "user",
    now,
    ...overrides
  };
}

describe("deterministic agent plan validation", () => {
  it("executes a candidate-confined explicit request with grounded arguments", () => {
    expect(validateAgentPlan(input())).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "主日服事" },
      reasonCode: "explicit_intent"
    });
  });

  it.each(["continue", "refine", "advance"] as const)(
    "accepts a valid requester-scoped active-task %s proposal",
    (disposition) => {
      expect(
        validateAgentPlan(
          input({
            text: "前攝影",
            candidates: [
              { capability: "query_schedule", reason: "active_task_entity", score: 300 }
            ],
            proposal: {
              disposition,
              capability: "query_schedule",
              arguments: { role: "前攝影", date: "2027-01-01" },
              confidence: 0.95
            },
            activeTask: scheduleTask
          })
        )
      ).toMatchObject({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { role: "前攝影" },
        reasonCode: "active_task_refinement"
      });
    }
  );

  it("rejects a capability absent from the deterministic candidate set", () => {
    expect(
      validateAgentPlan(
        input({
          proposal: {
            disposition: "execute",
            capability: "query_wikipedia",
            arguments: { query: "Fastify" },
            confidence: 0.99
          }
        })
      )
    ).toEqual({ disposition: "deny", reasonCode: "candidate_not_allowed" });
  });

  it("fails closed for an unknown candidate object", () => {
    expect(
      validateAgentPlan(
        input({
          candidates: [
            { capability: "invented_function", reason: "explicit_intent", score: 999 }
          ] as ValidateAgentPlanInput["candidates"],
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { query: "主日服事" },
            confidence: 0.99
          }
        })
      )
    ).toEqual({ disposition: "deny", reasonCode: "candidate_not_allowed" });
  });

  it("strips model-invented date, source, document, role, and references", () => {
    const result = validateAgentPlan(
      input({
        text: "查主日服事",
        proposal: {
          disposition: "execute",
          capability: "query_schedule",
          arguments: {
            query: "主日服事",
            date: "2027-01-01",
            sourceKey: "private-source",
            documentId: "private-document",
            role: "主席"
          },
          references: { sourceId: "private-source", documentId: "private-document" },
          confidence: 0.99
        }
      })
    );

    expect(result).toMatchObject({
      disposition: "execute",
      arguments: { query: "主日服事" }
    });
    expect(result).not.toHaveProperty("arguments.date");
    expect(result).not.toHaveProperty("arguments.sourceKey");
    expect(result).not.toHaveProperty("arguments.documentId");
    expect(result).not.toHaveProperty("arguments.role");
    expect(result).not.toHaveProperty("references");
  });

  it("resolves a unique active-task alias to the canonical entity label", () => {
    expect(
      validateAgentPlan(
        input({
          text: "攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "refine",
            capability: "query_schedule",
            arguments: { role: "前攝影" },
            confidence: 0.95
          },
          activeTask: scheduleTask
        })
      )
    ).toMatchObject({
      disposition: "execute",
      arguments: { role: "前攝影" },
      reasonCode: "active_task_refinement"
    });
  });

  it("clarifies an active-task alias matching multiple entities", () => {
    expect(
      validateAgentPlan(
        input({
          text: "攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "refine",
            capability: "query_schedule",
            arguments: { role: "前攝影" },
            confidence: 0.95
          },
          activeTask: {
            ...scheduleTask,
            entities: [
              ...scheduleTask.entities,
              { type: "role", key: "rear-camera", label: "後攝影", aliases: ["攝影"] }
            ]
          }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "ambiguous_entity"
    });
  });

  it("clarifies instead of executing below the configured confidence threshold", () => {
    expect(
      validateAgentPlan(
        input({
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { query: "主日服事" },
            confidence: 0.64
          }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "low_confidence"
    });
  });

  it("clarifies a definition-driven missing required slot", () => {
    expect(
      validateAgentPlan(
        input({
          text: "查服事表",
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { query: "明天" },
            confidence: 0.95
          }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "missing_required_slot"
    });
  });

  it("lets explicit current-message evidence switch away from an active task", () => {
    expect(
      validateAgentPlan(
        input({
          text: "查投影片 主日報告",
          enabledFunctions: ["query_schedule", "find_ppt_slides"],
          candidates: [
            { capability: "find_ppt_slides", reason: "explicit_intent", score: 400 },
            { capability: "query_schedule", reason: "active_task_entity", score: 300 }
          ],
          proposal: {
            disposition: "switch",
            capability: "find_ppt_slides",
            arguments: { query: "主日報告" },
            confidence: 0.95
          },
          activeTask: scheduleTask
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "find_ppt_slides",
      arguments: { query: "主日報告" },
      reasonCode: "explicit_capability_switch"
    });
  });

  it("does not let an active task hijack an explicit capability switch", () => {
    expect(
      validateAgentPlan(
        input({
          text: "查投影片 主日報告",
          enabledFunctions: ["query_schedule", "find_ppt_slides"],
          candidates: [
            { capability: "find_ppt_slides", reason: "explicit_intent", score: 400 },
            { capability: "query_schedule", reason: "active_task_entity", score: 300 }
          ],
          proposal: {
            disposition: "continue",
            capability: "query_schedule",
            arguments: { role: "前攝影" },
            confidence: 0.99
          },
          activeTask: scheduleTask
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "find_ppt_slides",
      reasonCode: "explicit_switch_required"
    });
  });

  it("does not accept a planner switch without explicit current-message evidence", () => {
    expect(
      validateAgentPlan(
        input({
          text: "主日報告",
          enabledFunctions: ["query_schedule", "find_ppt_slides"],
          candidates: [
            { capability: "find_ppt_slides", reason: "capability_hint", score: 100 },
            { capability: "query_schedule", reason: "active_task_entity", score: 300 }
          ],
          proposal: {
            disposition: "switch",
            capability: "find_ppt_slides",
            arguments: { query: "主日報告" },
            confidence: 0.99
          },
          activeTask: scheduleTask
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "find_ppt_slides",
      reasonCode: "capability_evidence_unresolved"
    });
  });

  it("returns chat only when there is no explicit or active-task capability evidence", () => {
    expect(
      validateAgentPlan(
        input({
          text: "今天天氣如何",
          enabledFunctions: ["query_schedule"],
          candidates: [],
          proposal: { disposition: "chat", arguments: {}, confidence: 0.9 }
        })
      )
    ).toEqual({ disposition: "chat", reasonCode: "no_capability_evidence" });
  });

  it("preserves a planner clarification as a controlled clarification", () => {
    expect(
      validateAgentPlan(
        input({
          proposal: { disposition: "clarify", arguments: {}, confidence: 0.9 }
        })
      )
    ).toEqual({ disposition: "clarify", reasonCode: "planner_clarification" });
  });

  it("allows no-plan recovery only for one revalidated high-confidence explicit intent", () => {
    expect(
      validateAgentPlan(
        input({
          text: "查主日服事",
          proposal: { status: "no_plan", reasonCode: "providers_unavailable" }
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "deterministic_explicit_intent"
    });

    expect(
      validateAgentPlan(
        input({
          text: "服事",
          candidates: [{ capability: "query_schedule", reason: "capability_hint", score: 100 }],
          proposal: { status: "no_plan", reasonCode: "providers_unavailable" }
        })
      )
    ).toEqual({ disposition: "clarify", reasonCode: "planner_unavailable" });
  });

  it("fails closed when the function is disabled or the source is unsupported", () => {
    expect(validateAgentPlan(input({ enabledFunctions: [] }))).toEqual({
      disposition: "deny",
      reasonCode: "function_disabled"
    });
    expect(validateAgentPlan(input({ sourceType: "room" }))).toEqual({
      disposition: "deny",
      reasonCode: "source_not_allowed"
    });
  });

  it("treats expired and wrong-requester active tasks as unavailable", () => {
    const proposal = {
      disposition: "continue" as const,
      capability: "query_schedule" as const,
      arguments: { role: "前攝影" },
      confidence: 0.95
    };
    const candidates = [
      { capability: "query_schedule" as const, reason: "active_task_entity" as const, score: 300 }
    ];
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates,
          proposal,
          activeTask: { ...scheduleTask, expiresAt: "2026-07-13T00:00:20.000Z" }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "active_task_unavailable"
    });
    // The requester-scoped store returns undefined for another requester.
    expect(
      validateAgentPlan(input({ text: "前攝影", candidates, proposal, activeTask: undefined }))
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "active_task_unavailable"
    });
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates,
          proposal,
          activeTask: {
            ...scheduleTask,
            createdAt: "2026-07-13T00:00:40.000Z",
            expiresAt: "2026-07-13T00:01:40.000Z"
          }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "active_task_unavailable"
    });
  });

  it("requires explicit write evidence and never treats model confidence as authority", () => {
    expect(
      validateAgentPlan(
        input({
          text: "這份服事表",
          enabledFunctions: ["save_schedule"],
          candidates: [{ capability: "save_schedule", reason: "explicit_intent", score: 999 }],
          proposal: {
            disposition: "execute",
            capability: "save_schedule",
            arguments: { content: "這份服事表" },
            confidence: 1
          }
        })
      )
    ).toEqual({ disposition: "deny", reasonCode: "write_evidence_missing" });

    expect(hasExplicitWriteEvidence("幫我保存 7/14 晨更", { content: "7/14 晨更" })).toBe(true);
    expect(hasExplicitWriteEvidence("看看 7/14 晨更", { content: "7/14 晨更" })).toBe(false);
  });
});

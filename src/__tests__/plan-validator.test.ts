import { describe, expect, it } from "vitest";

import type { ActiveTaskContext } from "../agent/active-task.js";
import { validateAgentPlan, type ValidateAgentPlanInput } from "../agent/plan-validator.js";
import { hasExplicitWriteEvidence } from "../functions/argument-normalization.js";

const now = new Date("2026-07-13T00:00:30.000Z");

const scheduleTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
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

const knowledgeTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_knowledge",
  allowedCapabilities: ["query_knowledge"],
  anchors: { sourceId: "source-1", documentId: "doc-1" },
  entities: [
    { type: "source", key: "source-1", label: "知識來源" },
    { type: "document", key: "doc-1", label: "知識文件" }
  ],
  references: { documentId: "doc-1" },
  supportedOperations: ["continue", "refine", "advance", "select"],
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
  it("materializes exact resource references for a declared field follow-up", () => {
    expect(
      validateAgentPlan(
        input({
          text: "連結呢",
          enabledFunctions: ["find_resource"],
          candidates: [{ capability: "find_resource", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "continue",
            capability: "find_resource",
            arguments: { query: "連結呢" },
            confidence: 0.95
          },
          activeTask: {
            version: 2,
            currentCapability: "find_resource",
            allowedCapabilities: ["find_resource"],
            anchors: { resourceId: "11111111-1111-4111-8111-111111111111" },
            entities: [{ type: "resource", key: "resource-1", label: "教會資料" }],
            references: { resourceId: "11111111-1111-4111-8111-111111111111" },
            supportedOperations: ["continue", "refine", "view_full"],
            responseContext: {
              availableFields: ["title", "link"],
              defaultProjection: "focused"
            },
            createdAt: "2026-07-13T00:00:00.000Z",
            expiresAt: "2026-07-13T00:01:00.000Z"
          }
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "find_resource",
      arguments: {
        query: "連結呢",
        resourceId: "11111111-1111-4111-8111-111111111111"
      },
      reasonCode: "active_task_refinement"
    });
  });

  it("executes a candidate-confined explicit request with grounded arguments", () => {
    expect(validateAgentPlan(input())).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "主日服事" },
      reasonCode: "explicit_intent"
    });
  });

  it.each([
    {
      name: "execute",
      proposal: {
        disposition: "execute" as const,
        capability: "save_schedule" as const,
        arguments: {},
        confidence: 0.95
      }
    },
    {
      name: "clarify",
      proposal: {
        disposition: "clarify" as const,
        capability: "save_schedule" as const,
        arguments: {},
        confidence: 0.95
      }
    },
    {
      name: "no plan",
      proposal: { status: "no_plan" as const, reasonCode: "providers_unavailable" as const }
    },
    {
      name: "chat",
      proposal: {
        disposition: "chat" as const,
        arguments: {},
        confidence: 0.95
      }
    },
    {
      name: "low-confidence execute",
      proposal: {
        disposition: "execute" as const,
        capability: "save_schedule" as const,
        arguments: {},
        confidence: 0.2
      }
    },
    {
      name: "clarify with invented payload",
      proposal: {
        disposition: "clarify" as const,
        capability: "save_schedule" as const,
        arguments: { content: "模型自行補出的服事表" },
        confidence: 0.95
      }
    }
  ])("collects a missing write slot independently of a $name proposal", ({ proposal }) => {
    expect(
      validateAgentPlan(
        input({
          text: "幫我記住服事表",
          enabledFunctions: ["save_schedule"],
          candidates: [{ capability: "save_schedule", reason: "explicit_intent", score: 400 }],
          proposal
        })
      )
    ).toEqual({
      disposition: "collect",
      capability: "save_schedule",
      arguments: { content: "" },
      missingSlot: "content",
      reasonCode: "missing_required_slot"
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

  it("materializes missing schedule anchors for a validated active-task refinement", () => {
    expect(
      validateAgentPlan(
        input({
          text: "音控是誰",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "refine",
            capability: "query_schedule",
            arguments: { query: "音控是誰", role: "音控" },
            confidence: 0.95
          },
          activeTask: {
            ...scheduleTask,
            entities: [...scheduleTask.entities, { type: "role", key: "音控", label: "音控" }]
          }
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: {
        query: "音控是誰",
        role: "音控",
        date: "2026-07-14",
        meeting: "晨更"
      },
      reasonCode: "active_task_refinement"
    });
  });

  it("derives active-task authority from the candidate when execute relabels an expired continuation", () => {
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { role: "前攝影" },
            confidence: 0.95
          },
          activeTask: { ...scheduleTask, expiresAt: "2026-07-13T00:00:20.000Z" }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "active_task_unavailable"
    });
  });

  it("requires continue support when active evidence is relabeled as execute", () => {
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { role: "前攝影" },
            confidence: 0.95
          },
          activeTask: { ...scheduleTask, supportedOperations: ["refine"] }
        })
      )
    ).toEqual({
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "operation_not_allowed"
    });
  });

  it("does not require active-task authority when an explicit candidate is mislabeled continue", () => {
    expect(
      validateAgentPlan(
        input({
          proposal: {
            disposition: "continue",
            capability: "query_schedule",
            arguments: { query: "主日服事" },
            confidence: 0.95
          },
          activeTask: undefined
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "explicit_intent"
    });
  });

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

  it("repairs an injected entity B to the trusted current-text entity A", () => {
    const result = validateAgentPlan(
      input({
        text: "前攝影",
        candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
        proposal: {
          disposition: "execute",
          capability: "query_schedule",
          arguments: { role: "後攝影" },
          confidence: 0.95
        },
        activeTask: {
          ...scheduleTask,
          entities: [
            ...scheduleTask.entities,
            { type: "role", key: "rear-camera", label: "後攝影" }
          ]
        }
      })
    );

    expect(result).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { role: "前攝影" }
    });
    expect(result).not.toHaveProperty("arguments.role", "後攝影");
  });

  it("prefers an explicit trusted role A over a stored role B anchor", () => {
    const result = validateAgentPlan(
      input({
        text: "前攝影",
        candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
        proposal: {
          disposition: "execute",
          capability: "query_schedule",
          arguments: { role: "後攝影" },
          confidence: 0.95
        },
        activeTask: {
          ...scheduleTask,
          anchors: { ...scheduleTask.anchors, role: "後攝影" }
        }
      })
    );

    expect(result).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { role: "前攝影" }
    });
    expect(result).not.toHaveProperty("arguments.role", "後攝影");
  });

  it("does not let a matched meeting entity ground the role field", () => {
    const result = validateAgentPlan(
      input({
        text: "晨更",
        candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
        proposal: {
          disposition: "execute",
          capability: "query_schedule",
          arguments: { role: "晨更" },
          confidence: 0.95
        },
        activeTask: {
          ...scheduleTask,
          entities: [
            ...scheduleTask.entities,
            { type: "meeting", key: "morning-prayer", label: "晨更" }
          ]
        }
      })
    );

    expect(result).toMatchObject({ disposition: "execute", capability: "query_schedule" });
    expect(result).not.toHaveProperty("arguments.role");
  });

  it("inherits only declaratively bound schedule anchors", () => {
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { role: "前攝影", specificDate: "2026-07-14", meeting: "晨更" },
            confidence: 0.95
          },
          activeTask: scheduleTask
        })
      )
    ).toMatchObject({
      disposition: "execute",
      arguments: { role: "前攝影", specificDate: "2026-07-14", meeting: "晨更" },
      reasonCode: "active_task_refinement"
    });
  });

  it("accepts a declared date entity with explicit relative-date normalization", () => {
    expect(
      validateAgentPlan(
        input({
          text: "明天",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "execute",
            capability: "query_schedule",
            arguments: { dateIntent: "tomorrow" },
            confidence: 0.95
          },
          activeTask: {
            ...scheduleTask,
            entities: [{ type: "date", key: "2026-07-14", label: "明天" }]
          }
        })
      )
    ).toMatchObject({
      disposition: "execute",
      arguments: { dateIntent: "tomorrow" },
      reasonCode: "active_task_refinement"
    });
  });

  it("strips a model-invented year when current text contains only month and day", () => {
    const result = validateAgentPlan(
      input({
        text: "查服事 7/14",
        proposal: {
          disposition: "execute",
          capability: "query_schedule",
          arguments: { query: "7/14", specificDate: "2027-07-14" },
          confidence: 0.95
        }
      })
    );

    expect(result).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "7/14" }
    });
    expect(result).not.toHaveProperty("arguments.specificDate");
  });

  it.each(["2027-07-14", "2027/7/14", "2027年7月14日"])(
    "accepts a full date when the year is explicit in %s",
    (dateText) => {
      expect(
        validateAgentPlan(
          input({
            text: `查服事 ${dateText}`,
            proposal: {
              disposition: "execute",
              capability: "query_schedule",
              arguments: { query: dateText, specificDate: "2027-07-14" },
              confidence: 0.95
            }
          })
        )
      ).toMatchObject({
        disposition: "execute",
        capability: "query_schedule",
        arguments: { specificDate: "2027-07-14" }
      });
    }
  );

  it("keeps opaque knowledge source and document values out of planner arguments", () => {
    const result = validateAgentPlan({
      text: "繼續查這份知識",
      enabledFunctions: ["query_knowledge"],
      candidates: [{ capability: "query_knowledge", reason: "knowledge_metadata", score: 200 }],
      proposal: {
        disposition: "execute",
        capability: "query_knowledge",
        arguments: { query: "繼續查這份知識", sourceId: "source-1", documentId: "doc-1" },
        confidence: 0.95
      },
      activeTask: knowledgeTask,
      minConfidence: 0.65,
      sourceType: "user",
      now
    });
    expect(result).toMatchObject({ disposition: "execute", reasonCode: "explicit_intent" });
    expect(result).not.toHaveProperty("arguments.sourceId");
    expect(result).not.toHaveProperty("arguments.documentId");
  });

  it("keeps an opaque knowledge section out of planner arguments", () => {
    const sectionKey = "a".repeat(64);
    const task: ActiveTaskContext = {
      ...knowledgeTask,
      anchors: { ...knowledgeTask.anchors, sectionKey },
      entities: [
        ...knowledgeTask.entities,
        { type: "section", key: sectionKey, label: "知識段落" }
      ],
      references: { ...knowledgeTask.references, sectionKey }
    };
    const result = validateAgentPlan({
      text: "那幾點集合",
      enabledFunctions: ["query_knowledge"],
      candidates: [{ capability: "query_knowledge", reason: "knowledge_metadata", score: 200 }],
      proposal: {
        disposition: "continue",
        capability: "query_knowledge",
        arguments: { query: "那幾點集合", sectionKey },
        confidence: 0.95
      },
      activeTask: task,
      minConfidence: 0.65,
      sourceType: "user",
      now
    });
    expect(result).toMatchObject({ disposition: "execute", reasonCode: "explicit_intent" });
    expect(result).not.toHaveProperty("arguments.sectionKey");
  });

  it("strips a spoofed proposal reference key even when its value exists in the task", () => {
    const result = validateAgentPlan({
      text: "出隊",
      enabledFunctions: ["query_knowledge"],
      candidates: [{ capability: "query_knowledge", reason: "knowledge_metadata", score: 200 }],
      proposal: {
        disposition: "continue",
        capability: "query_knowledge",
        arguments: { query: "出隊" },
        references: { sourceId: "doc-1" },
        confidence: 0.95
      },
      activeTask: knowledgeTask,
      minConfidence: 0.65,
      sourceType: "user",
      now
    });

    expect(result).toMatchObject({ disposition: "execute" });
    expect(result).not.toHaveProperty("references.sourceId");
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
      disposition: "collect",
      capability: "query_schedule",
      arguments: { query: "" },
      missingSlot: "query",
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

  it.each([
    { status: "no_plan" as const, reasonCode: "no_candidates" as const },
    { disposition: "chat" as const, arguments: {}, confidence: 0.9 }
  ])("does not turn an unresolved task-shaped request into small talk", (proposal) => {
    expect(
      validateAgentPlan(
        input({
          text: "我想查詢牧師師母五十週年檔案",
          enabledFunctions: ["find_resource"],
          candidates: [],
          proposal
        })
      )
    ).toEqual({ disposition: "clarify", reasonCode: "capability_evidence_unresolved" });
  });

  it("recovers a complete explicit read request from an over-cautious planner clarification", () => {
    expect(
      validateAgentPlan(
        input({
          text: "幫我查下一場聚會服事的導播",
          proposal: { disposition: "clarify", arguments: {}, confidence: 0.95 },
          sourceType: "group"
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: {
        query: "幫我查下一場聚會服事的導播",
        dateIntent: "next_meeting",
        role: "導播"
      },
      reasonCode: "explicit_intent"
    });
  });

  it("recovers a unique requester-scoped active-task refinement from planner clarification", () => {
    expect(
      validateAgentPlan(
        input({
          text: "前攝影",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "clarify",
            capability: "query_schedule",
            arguments: {},
            confidence: 0
          },
          activeTask: scheduleTask
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "前攝影", role: "前攝影" },
      reasonCode: "active_task_refinement"
    });
  });

  it("keeps an ambiguous active-task refinement controlled when the planner clarifies", () => {
    expect(
      validateAgentPlan(
        input({
          text: "攝影是誰",
          candidates: [{ capability: "query_schedule", reason: "active_task_entity", score: 300 }],
          proposal: {
            disposition: "clarify",
            capability: "query_schedule",
            arguments: {},
            confidence: 0
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

  it("recovers trusted dynamic-knowledge metadata evidence from planner clarification", () => {
    expect(
      validateAgentPlan({
        text: "第一天去哪裡",
        enabledFunctions: ["query_knowledge"],
        candidates: [{ capability: "query_knowledge", reason: "knowledge_metadata", score: 200 }],
        proposal: {
          disposition: "clarify",
          capability: "query_knowledge",
          arguments: {},
          confidence: 0
        },
        minConfidence: 0.65,
        sourceType: "group",
        now
      })
    ).toMatchObject({
      disposition: "execute",
      capability: "query_knowledge",
      arguments: { query: "第一天去哪裡" }
    });
  });

  it("preserves an explicit cross-function switch during deterministic recovery", () => {
    expect(
      validateAgentPlan(
        input({
          text: "那主日音控呢",
          enabledFunctions: ["query_knowledge", "query_schedule"],
          candidates: [{ capability: "query_schedule", reason: "argument_evidence", score: 350 }],
          proposal: {
            disposition: "clarify",
            capability: "query_schedule",
            arguments: {},
            confidence: 0.6
          },
          activeTask: knowledgeTask
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "explicit_capability_switch",
      arguments: { meeting: "主日", role: "音控" }
    });
  });

  it("does not recover an expired active task from planner clarification", () => {
    expect(
      validateAgentPlan({
        text: "那幾點集合",
        enabledFunctions: ["query_knowledge"],
        candidates: [{ capability: "query_knowledge", reason: "active_task_entity", score: 300 }],
        proposal: {
          disposition: "clarify",
          capability: "query_knowledge",
          arguments: {},
          confidence: 0
        },
        activeTask: { ...knowledgeTask, expiresAt: "2026-07-12T23:59:59.000Z" },
        minConfidence: 0.65,
        sourceType: "group",
        now
      })
    ).toEqual({
      disposition: "clarify",
      capability: "query_knowledge",
      reasonCode: "active_task_unavailable"
    });
  });

  it("preserves a planner clarification as a controlled clarification", () => {
    expect(
      validateAgentPlan(
        input({
          text: "攝影是誰",
          candidates: [{ capability: "query_schedule", reason: "capability_hint", score: 100 }],
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

  it("does not ground ordinal 1 from the numeric substring in 第10個", () => {
    expect(
      validateAgentPlan({
        text: "查知識 第10個",
        enabledFunctions: ["query_knowledge"],
        candidates: [{ capability: "query_knowledge", reason: "explicit_intent", score: 400 }],
        proposal: {
          disposition: "execute",
          capability: "query_knowledge",
          arguments: { query: "查知識 第10個", ordinal: 1 },
          confidence: 0.95
        },
        minConfidence: 0.65,
        sourceType: "user",
        now
      })
    ).toMatchObject({ disposition: "execute", arguments: { ordinal: 9 } });
  });

  it.each([Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY])(
    "fails closed for invalid proposal confidence %s",
    (confidence) => {
      expect(
        validateAgentPlan(
          input({
            proposal: {
              disposition: "execute",
              capability: "query_schedule",
              arguments: { query: "主日服事" },
              confidence
            }
          })
        )
      ).toEqual({
        disposition: "clarify",
        capability: "query_schedule",
        reasonCode: "low_confidence"
      });
    }
  );

  it.each([Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY])(
    "denies an invalid confidence policy threshold %s",
    (minConfidence) => {
      expect(validateAgentPlan(input({ minConfidence }))).toEqual({
        disposition: "deny",
        reasonCode: "invalid_policy"
      });
    }
  );

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

  it("accepts a candidate-confined multi-line schedule write grounded in the current message", () => {
    const text = "幫我記住服事表\n7/14 晨更\n音控：資恆\n導播：莘凌";

    expect(
      validateAgentPlan(
        input({
          text,
          enabledFunctions: ["save_schedule"],
          candidates: [{ capability: "save_schedule", reason: "explicit_intent", score: 400 }],
          proposal: {
            disposition: "execute",
            capability: "save_schedule",
            arguments: { content: "7/14 晨更\n音控：資恆\n導播：莘凌", operation: "replace" },
            confidence: 0.95
          }
        })
      )
    ).toMatchObject({
      disposition: "execute",
      capability: "save_schedule",
      arguments: { content: "7/14 晨更\n音控：資恆\n導播：莘凌" }
    });
  });

  it("accepts explicit text-memory content but rejects model-invented content", () => {
    const candidate = [
      { capability: "save_memory" as const, reason: "explicit_intent" as const, score: 400 }
    ];

    expect(
      validateAgentPlan(
        input({
          text: "幫我記住集合時間是下午兩點半",
          enabledFunctions: ["save_memory"],
          candidates: candidate,
          proposal: {
            disposition: "execute",
            capability: "save_memory",
            arguments: { content: "集合時間是下午兩點半" },
            confidence: 0.95
          }
        })
      )
    ).toMatchObject({ disposition: "execute", capability: "save_memory" });

    expect(
      validateAgentPlan(
        input({
          text: "幫我記住集合時間是下午兩點半",
          enabledFunctions: ["save_memory"],
          candidates: candidate,
          proposal: {
            disposition: "execute",
            capability: "save_memory",
            arguments: { content: "集合時間是下午三點" },
            confidence: 0.99
          }
        })
      )
    ).toEqual({ disposition: "deny", reasonCode: "write_evidence_missing" });
  });
});

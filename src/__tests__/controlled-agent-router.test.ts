import { describe, expect, it, vi } from "vitest";

import type { ActiveTaskContext } from "../agent/active-task.js";
import {
  createControlledAgentRouter,
  type DynamicKnowledgeMetadataProvider
} from "../agent/controlled-agent-router.js";
import type { AgentPlanner } from "../agent/planner.js";

const now = new Date("2026-07-13T00:00:30.000Z");

const scheduleTask: ActiveTaskContext = {
  version: 1,
  capability: "query_schedule",
  anchors: { date: "2026-07-14", meeting: "晨更" },
  entities: [{ type: "role", key: "front-camera", label: "前攝影", aliases: ["攝影"] }],
  supportedOperations: ["continue", "refine", "advance"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

const knowledgeTask: ActiveTaskContext = {
  version: 1,
  capability: "query_knowledge",
  anchors: { sourceKey: "retreat" },
  entities: [{ type: "section", key: "day-one", label: "第一天" }],
  supportedOperations: ["continue", "refine", "advance", "select"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

function createRouter(planner: AgentPlanner, knowledgeMetadata?: DynamicKnowledgeMetadataProvider) {
  return createControlledAgentRouter({ planner, knowledgeMetadata, now: () => now });
}

describe("ControlledAgentRouter", () => {
  it("does not let a chat proposal override exact active-task entity evidence", async () => {
    const planner: AgentPlanner = {
      propose: vi.fn().mockResolvedValue({
        status: "proposed",
        version: 1,
        disposition: "chat",
        arguments: {},
        confidence: 0.99,
        provider: "deepseek",
        attempts: []
      })
    };

    await expect(
      createRouter(planner).resolve({
        profileName: "helper",
        text: "前攝影",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        sourceType: "group",
        activeTask: scheduleTask,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toEqual({
      disposition: "clarify",
      reasonCode: "capability_evidence_unresolved"
    });
  });

  it("lets explicit schedule intent switch away from knowledge context", async () => {
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "proposed",
      version: 1,
      disposition: "switch",
      capability: "query_schedule",
      arguments: { query: "查主日服事", meeting: "主日" },
      confidence: 0.96,
      provider: "deepseek",
      attempts: []
    });

    await expect(
      createRouter({ propose }).resolve({
        profileName: "helper",
        text: "查主日服事",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        sourceType: "group",
        activeTask: knowledgeTask,
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "查主日服事", meeting: "主日" },
      reasonCode: "explicit_capability_switch"
    });
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ capability: "query_schedule" })]
      })
    );
  });

  it("uses deterministic explicit intent when every planner provider fails", async () => {
    const planner: AgentPlanner = {
      propose: vi.fn().mockRejectedValue(new Error("providers unavailable"))
    };

    await expect(
      createRouter(planner).resolve({
        profileName: "helper",
        text: "查主日服事",
        enabledFunctions: ["query_schedule"],
        sourceType: "user",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toMatchObject({
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "deterministic_explicit_intent"
    });
  });

  it("loads bounded dynamic knowledge metadata before planning", async () => {
    const list = vi.fn<DynamicKnowledgeMetadataProvider["list"]>().mockResolvedValue([
      {
        sourceKey: "retreat",
        displayName: "2026 青年出隊",
        aliases: ["出隊"],
        topics: ["第一天"]
      }
    ]);
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "no_plan",
      reasonCode: "providers_unavailable",
      attempts: []
    });

    await createRouter({ propose }, { list }).resolve({
      profileName: "helper",
      text: "第一天去哪裡",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });

    expect(list).toHaveBeenCalledWith("helper", 20);
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ capability: "query_knowledge" })]
      })
    );
  });

  it("uses a declarative bounded retrieval provider without leaking its evidence to planning", async () => {
    const probe = vi.fn().mockResolvedValue({
      matched: true,
      count: 1,
      opaqueIds: ["source-secret-id"]
    });
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "no_plan",
      reasonCode: "providers_unavailable",
      attempts: []
    });
    const router = createControlledAgentRouter({
      planner: { propose },
      retrievalEvidenceProviders: { knowledge: { probe } },
      now: () => now
    });

    await router.resolve({
      profileName: "helper",
      text: "急救箱位置",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });

    expect(probe).toHaveBeenCalledWith({
      profileName: "helper",
      text: "急救箱位置",
      maxSources: 20
    });
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            capability: "query_knowledge",
            reason: "retrieval_evidence"
          })
        ]
      })
    );
    expect(JSON.stringify(propose.mock.calls)).not.toMatch(/source-secret-id/u);
  });

  it("does not probe retrieval providers for small talk or disabled capabilities", async () => {
    const probe = vi.fn().mockResolvedValue({ matched: true });
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "no_plan",
      reasonCode: "no_candidates",
      attempts: []
    });
    const router = createControlledAgentRouter({
      planner: { propose },
      retrievalEvidenceProviders: { knowledge: { probe } },
      now: () => now
    });

    await router.resolve({
      profileName: "helper",
      text: "你好",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });
    await router.resolve({
      profileName: "helper",
      text: "急救箱位置",
      enabledFunctions: ["query_schedule"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });
    await router.resolve({
      profileName: "helper",
      text: "幫我儲存急救箱位置",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });

    expect(probe).not.toHaveBeenCalled();
    expect(propose.mock.calls.every((call) => call[0].candidates.length === 0)).toBe(true);
  });

  it("fails closed before planning for an unsupported source", async () => {
    const propose = vi.fn<AgentPlanner["propose"]>();

    await expect(
      createRouter({ propose }).resolve({
        profileName: "helper",
        text: "查主日服事",
        enabledFunctions: ["query_schedule"],
        sourceType: "room",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toEqual({ disposition: "deny", reasonCode: "source_not_allowed" });
    expect(propose).not.toHaveBeenCalled();
  });
});

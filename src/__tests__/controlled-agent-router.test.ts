import { describe, expect, it, vi } from "vitest";

import type { ActiveTaskContext } from "../agent/active-task.js";
import {
  createControlledAgentRouter,
  type DynamicKnowledgeMetadataProvider
} from "../agent/controlled-agent-router.js";
import type { AgentPlanner } from "../agent/planner.js";

const now = new Date("2026-07-13T00:00:30.000Z");

const scheduleTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
  anchors: { date: "2026-07-14", meeting: "晨更" },
  entities: [{ type: "role", key: "front-camera", label: "前攝影", aliases: ["攝影"] }],
  supportedOperations: ["continue", "refine", "advance"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

const knowledgeTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_knowledge",
  allowedCapabilities: ["query_knowledge"],
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
  it("emits bounded candidate, planner, and validator diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const planner: AgentPlanner = {
      propose: vi.fn().mockResolvedValue({
        status: "proposed",
        version: 1,
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "查主日服事" },
        confidence: 0.96,
        provider: "deepseek",
        attempts: []
      })
    };

    await createRouter(planner).resolve(
      {
        profileName: "helper",
        text: "查主日服事",
        enabledFunctions: ["query_schedule"],
        sourceType: "group",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      },
      (step) => diagnostics.push(step)
    );

    expect(diagnostics).toEqual([
      {
        phase: "capability_candidates",
        candidates: ["query_schedule"],
        candidateCount: 1
      },
      {
        phase: "planner",
        outcome: "proposed",
        provider: "deepseek",
        disposition: "execute",
        confidenceBucket: "high"
      },
      {
        phase: "plan_validation",
        outcome: "accepted",
        action: "query_schedule",
        disposition: "execute",
        validatorReason: "explicit_intent"
      }
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("查主日服事");
  });

  it("does not let a diagnostic observer change the validated plan", async () => {
    const planner: AgentPlanner = {
      propose: vi.fn().mockResolvedValue({
        status: "proposed",
        version: 1,
        disposition: "execute",
        capability: "query_schedule",
        arguments: { query: "查主日服事" },
        confidence: 0.96,
        provider: "deepseek",
        attempts: []
      })
    };

    await expect(
      createRouter(planner).resolve(
        {
          profileName: "helper",
          text: "查主日服事",
          enabledFunctions: ["query_schedule"],
          sourceType: "group",
          maxCandidates: 3,
          minPlannerConfidence: 0.65
        },
        () => {
          throw new Error("diagnostics unavailable");
        }
      )
    ).resolves.toMatchObject({ disposition: "execute", capability: "query_schedule" });
  });

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

  it("keeps an explicit memory write controlled when the planner succeeds", async () => {
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "proposed",
      version: 1,
      disposition: "execute",
      capability: "save_memory",
      arguments: { content: "集合時間是下午兩點半", visibility: "group" },
      confidence: 0.96,
      provider: "deepseek",
      attempts: []
    });

    await expect(
      createRouter({ propose }).resolve({
        profileName: "helper",
        text: "幫我記住集合時間是下午兩點半，群組共用",
        enabledFunctions: ["save_memory"],
        sourceType: "group",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toMatchObject({
      disposition: "execute",
      capability: "save_memory",
      arguments: { content: "集合時間是下午兩點半", visibility: "group" }
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

  it("probes catalog evidence with a projected resource query", async () => {
    const probe = vi.fn().mockResolvedValue({ matched: true, count: 1, opaqueIds: ["r1"] });
    const propose = vi.fn<AgentPlanner["propose"]>().mockResolvedValue({
      status: "proposed",
      version: 1,
      disposition: "execute",
      capability: "find_resource",
      arguments: { query: "牧師師母 50 週年" },
      confidence: 0.95,
      provider: "deepseek",
      attempts: []
    });
    const router = createControlledAgentRouter({
      planner: { propose },
      retrievalEvidenceProviders: { catalog_general: { probe } },
      now: () => now
    });

    await expect(
      router.resolve({
        profileName: "helper",
        text: "我想查詢牧師師母 50 週年檔案",
        enabledFunctions: ["find_resource"],
        sourceType: "user",
        sourceId: "user-1",
        requesterUserId: "user-1",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toMatchObject({ disposition: "execute", capability: "find_resource" });

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ text: "牧師師母 50 週年" }));
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
      sourceId: "group-1",
      requesterUserId: "user-1",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });

    expect(probe).toHaveBeenCalledWith({
      profileName: "helper",
      text: "急救箱位置",
      maxResults: 20,
      source: "group",
      sourceId: "group-1",
      requesterUserId: "user-1"
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

    for (const text of [
      "你好",
      "你好嗎",
      "在嗎",
      "辛苦嗎",
      "你是內向的人嗎",
      "加油",
      "說個笑話哈哈"
    ]) {
      await router.resolve({
        profileName: "helper",
        text,
        enabledFunctions: ["query_knowledge"],
        sourceType: "group",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      });
    }
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
    await router.resolve({
      profileName: "helper",
      text: "幫我把第一日儲存起來",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });
    await router.resolve({
      profileName: "helper",
      text: "請將第一日新增到知識",
      enabledFunctions: ["query_knowledge"],
      sourceType: "group",
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });

    expect(probe).not.toHaveBeenCalled();
    expect(propose.mock.calls.every((call) => call[0].candidates.length === 0)).toBe(true);
  });

  it("distinguishes unavailable retrieval evidence from no matching capability", async () => {
    const propose = vi.fn<AgentPlanner["propose"]>();
    const router = createControlledAgentRouter({
      planner: { propose },
      retrievalEvidenceProviders: {
        knowledge: { probe: vi.fn().mockRejectedValue(new Error("database unavailable")) }
      },
      now: () => now
    });

    await expect(
      router.resolve({
        profileName: "helper",
        text: "急救箱位置",
        enabledFunctions: ["query_knowledge"],
        sourceType: "group",
        sourceId: "group-1",
        requesterUserId: "user-1",
        maxCandidates: 3,
        minPlannerConfidence: 0.65
      })
    ).resolves.toEqual({ disposition: "clarify", reasonCode: "retrieval_unavailable" });
    expect(propose).not.toHaveBeenCalled();
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

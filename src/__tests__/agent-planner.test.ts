import { describe, expect, it, vi } from "vitest";

import { createAgentPlanner, type AgentPlannerCandidate } from "../agent/planner.js";
import type { ActiveTaskContext } from "../agent/active-task.js";
import type { ChatProvider, ModelProviderName } from "../types.js";

const scheduleTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
  anchors: {
    date: "2026-07-14",
    meeting: "晨更",
    rawResult: "前攝影：不應送給 planner 的人名"
  },
  entities: [
    {
      type: "role",
      key: "front-camera",
      label: "前攝影",
      aliases: ["攝影"]
    }
  ],
  references: { url: "https://private.example.test/sharing-link" },
  supportedOperations: ["continue", "refine", "advance"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

const scheduleCandidate = {
  capability: "query_schedule" as const,
  reason: "active_task_entity" as const,
  score: 300
};

const scheduleCandidateWithContract: AgentPlannerCandidate = {
  ...scheduleCandidate,
  contract: {
    intents: ["查服事"],
    candidateHints: ["服事"],
    semanticDescription: "依日期、聚會或角色查詢服事安排。",
    arguments: {
      query: { type: "string", authority: "current_text" },
      role: { type: "string", authority: "model_grounded" },
      dateIntent: {
        type: "string",
        authority: "model_grounded",
        values: ["today", "next_meeting"]
      }
    },
    entityTypes: ["role"],
    refinableFields: ["role"],
    operations: ["continue", "refine"],
    responseProjection: {
      defaultMode: "focused",
      fields: {
        role: { label: "服事", aliases: ["誰", "人員"] },
        date: { label: "日期", aliases: ["何時"] }
      }
    },
    ambiguity: "clarify"
  }
};

function provider(
  providerName: ModelProviderName,
  implementation: ChatProvider["completeJson"]
): ChatProvider {
  return {
    providerName,
    completeJson: vi.fn(implementation)
  };
}

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    disposition: "continue",
    capability: "query_schedule",
    arguments: { role: "前攝影" },
    references: { entityKey: "front-camera", ordinal: 1, confirmed: true },
    confidence: 0.95,
    ...overrides
  });
}

describe("constrained semantic planner", () => {
  it("accepts one strict DeepSeek proposal and sends only bounded sanitized context", async () => {
    const primary = provider("deepseek", async () => response());
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });
    const sensitiveTask: ActiveTaskContext = {
      ...scheduleTask,
      anchors: { sourceValue: "notion-source-raw", result: "prior-result-value" },
      entities: [
        {
          type: "role",
          key: "private-roster.xlsx",
          label: "王小明",
          aliases: ["姵穎"]
        },
        {
          type: "selection",
          key: "source-file-key",
          label: "主日名單.pdf",
          aliases: ["private-file-alias"]
        }
      ],
      references: { sourceId: "private-source-id", url: "https://private.example.test/link" }
    };

    const result = await planner.propose({
      profileName: "helper",
      text: "前攝影 https://private.example.test www.hidden.example sk-proj-secretsecretsecretsecret",
      candidates: [scheduleCandidateWithContract],
      activeTask: sensitiveTask
    });

    expect(result).toMatchObject({
      status: "proposed",
      version: 1,
      disposition: "continue",
      capability: "query_schedule",
      arguments: { role: "前攝影" },
      references: { entityKey: "front-camera", ordinal: 1, confirmed: true },
      confidence: 0.95,
      provider: "deepseek",
      attempts: [
        {
          provider: "deepseek",
          status: "accepted",
          reason: "valid_proposal",
          candidateCount: 1
        }
      ]
    });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).not.toHaveBeenCalled();

    const request = vi.mocked(primary.completeJson).mock.calls[0]?.[0];
    expect(request?.enabledFunctions).toEqual(["query_schedule"]);
    expect(request?.text).toContain("前攝影");
    expect(request?.text).not.toContain("private.example.test");
    expect(request?.text).not.toContain("hidden.example");
    expect(request?.text).not.toContain("sk-proj-secret");
    expect(request?.prompt).toContain("Candidate actions are the only permitted functions");
    expect(request?.prompt).toContain("Current-message evidence overrides active-task context");
    expect(request?.prompt).toContain("Ambiguity requires disposition clarify");
    expect(request?.prompt).toContain(
      "Write actions are unavailable unless deterministic candidates include them"
    );
    expect(request?.prompt).toContain('"capability":"query_schedule"');
    expect(request?.prompt).toContain("依日期、聚會或角色查詢服事安排");
    expect(request?.prompt).toContain('"requiredSlots":["schedule_range_or_type"]');
    expect(request?.prompt).toContain(
      '"arguments":{"query":{"type":"string","authority":"current_text"},"role":{"type":"string","authority":"model_grounded"}'
    );
    expect(request?.prompt).toContain('"values":["today","next_meeting"]');
    expect(request?.prompt).toContain('"responseFields":["role","date"]');
    expect(request?.prompt).toContain('"ref":"entity-1","type":"role"');
    expect(request?.prompt).toContain('"supportedOperations":["continue","refine"]');
    for (const sensitiveValue of [
      "private-roster.xlsx",
      "王小明",
      "姵穎",
      "source-file-key",
      "主日名單.pdf",
      "private-file-alias",
      "notion-source-raw",
      "prior-result-value",
      "private-source-id",
      "private.example.test"
    ]) {
      expect(request?.prompt).not.toContain(sensitiveValue);
    }
  });

  it("omits active-task entities and operations when the candidate has no declarations", async () => {
    const primary = provider("deepseek", async () => response());
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    await planner.propose({
      profileName: "helper",
      text: "前攝影",
      candidates: [scheduleCandidate],
      activeTask: scheduleTask
    });

    const prompt = vi.mocked(primary.completeJson).mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('Active-task summary: {"version":2,"capability":"query_schedule"}');
    expect(prompt).not.toContain("supportedOperations");
    expect(prompt).not.toContain("entities");
    expect(prompt).not.toContain("front-camera");
    expect(prompt).not.toContain("前攝影");
  });

  it("falls back from a bounded primary timeout to Ollama exactly once", async () => {
    let primarySignal: AbortSignal | undefined;
    let fallbackObservedAbort = false;
    const primary = provider(
      "deepseek",
      (request) =>
        new Promise((_resolve, reject) => {
          primarySignal = request.signal;
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const fallback = provider("ollama", async () => {
      fallbackObservedAbort = primarySignal?.aborted === true;
      return response({ disposition: "refine" });
    });
    const planner = createAgentPlanner({ primary, fallback, timeoutMs: 5 });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "只看晨更",
        candidates: [scheduleCandidate],
        activeTask: scheduleTask
      })
    ).resolves.toMatchObject({
      status: "proposed",
      disposition: "refine",
      provider: "ollama",
      attempts: [
        { provider: "deepseek", status: "timeout", reason: "timeout", candidateCount: 1 },
        {
          provider: "ollama",
          status: "accepted",
          reason: "valid_proposal",
          candidateCount: 1
        }
      ]
    });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).toHaveBeenCalledOnce();
    expect(primarySignal?.aborted).toBe(true);
    expect(fallbackObservedAbort).toBe(true);
  });

  it("keeps every bounded candidate and active-task summary complete within the prompt limit", async () => {
    const primary = provider("deepseek", async () => response());
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });
    const longValues = Array.from(
      { length: 12 },
      (_, index) => `${index}-${"metadata".repeat(20)}`
    );
    const candidates: AgentPlannerCandidate[] = (
      [
        "query_schedule",
        "find_ppt_slides",
        "query_knowledge",
        "find_sheet_music",
        "find_resource"
      ] as const
    ).map((capability) => ({
      capability,
      reason: "capability_hint" as const,
      score: 100,
      contract: {
        intents: longValues,
        candidateHints: longValues,
        entityTypes: longValues,
        refinableFields: longValues,
        operations: longValues,
        ambiguity: "clarify" as const
      }
    }));
    const activeTask: ActiveTaskContext = {
      ...scheduleTask,
      entities: Array.from({ length: 20 }, (_, index) => ({
        type: `role-${index}-${"t".repeat(200)}`,
        key: `role-key-${index}-${"k".repeat(200)}`,
        label: `role-label-${index}-${"l".repeat(600)}`,
        aliases: Array.from({ length: 10 }, (_, alias) => `alias-${alias}-${"a".repeat(300)}`)
      }))
    };

    await planner.propose({
      profileName: "helper",
      text: "前攝影",
      candidates,
      activeTask
    });

    const request = vi.mocked(primary.completeJson).mock.calls[0]?.[0];
    expect(request?.prompt.length).toBeLessThanOrEqual(12_000);
    for (const { capability } of candidates) {
      expect(request?.prompt).toContain(`"capability":"${capability}"`);
    }
    expect(request?.prompt).toMatch(/Active-task summary: \{.*\}$/su);
  });

  it.each([
    "not json",
    `\`\`\`json\n${response()}\n\`\`\``,
    `${response()} trailing`,
    response({ version: 2 }),
    response({ unexpected: true })
  ])("falls back once when DeepSeek returns non-strict JSON: %s", async (raw) => {
    const primary = provider("deepseek", async () => raw);
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    const result = await planner.propose({
      profileName: "helper",
      text: "前攝影",
      candidates: [scheduleCandidate],
      activeTask: scheduleTask
    });

    expect(result).toMatchObject({
      status: "proposed",
      provider: "ollama",
      attempts: [
        { provider: "deepseek", status: "invalid_output" },
        { provider: "ollama", status: "accepted" }
      ]
    });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).toHaveBeenCalledOnce();
  });

  it("rejects an unknown capability and confines the fallback to supplied candidates", async () => {
    const primary = provider("deepseek", async () =>
      response({ capability: "save_resource", disposition: "switch" })
    );
    const fallback = provider("ollama", async () =>
      response({ capability: "query_schedule", disposition: "continue" })
    );
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "前攝影",
        candidates: [scheduleCandidate],
        activeTask: scheduleTask
      })
    ).resolves.toMatchObject({
      status: "proposed",
      capability: "query_schedule",
      provider: "ollama",
      attempts: [
        {
          provider: "deepseek",
          status: "invalid_output",
          reason: "candidate_not_allowed"
        },
        { provider: "ollama", status: "accepted" }
      ]
    });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).toHaveBeenCalledOnce();
  });

  it.each([
    response({ confidence: -0.01 }),
    response({ confidence: 1.01 }),
    response({ arguments: { query: "x".repeat(501) } }),
    response({ arguments: { choices: Array.from({ length: 11 }, () => "x") } }),
    response({ arguments: { nested: { raw: "forbidden" } } }),
    response({
      arguments: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index]))
    }),
    response({ references: { nested: { raw: "forbidden" } } }),
    '{"version":1,"disposition":"continue","arguments":{},"confidence":NaN}',
    '{"version":1,"disposition":"continue","arguments":{},"confidence":Infinity}'
  ])("rejects oversized, nested, non-finite, or out-of-range proposal data", async (raw) => {
    const primary = provider("deepseek", async () => raw);
    const fallback = provider("ollama", async () => "invalid too");
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "前攝影",
        candidates: [scheduleCandidate],
        activeTask: scheduleTask
      })
    ).resolves.toMatchObject({
      status: "no_plan",
      reasonCode: "invalid_output",
      attempts: [
        { provider: "deepseek", status: "invalid_output" },
        { provider: "ollama", status: "invalid_output" }
      ]
    });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).toHaveBeenCalledOnce();
  });

  it.each([
    ["arguments", "__proto__"],
    ["references", "Constructor"],
    ["arguments", "ＰＲＯＴＯＴＹＰＥ"]
  ] as const)("rejects reserved %s key %s before proposal acceptance", async (record, key) => {
    const argumentsJson = record === "arguments" ? `{"${key}":"hostile"}` : "{}";
    const referencesJson = record === "references" ? `,"references":{"${key}":"hostile"}` : "";
    const primary = provider(
      "deepseek",
      async () =>
        `{"version":1,"disposition":"continue","capability":"query_schedule","arguments":${argumentsJson}${referencesJson},"confidence":0.95}`
    );
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "前攝影",
        candidates: [scheduleCandidate]
      })
    ).resolves.toMatchObject({
      status: "proposed",
      provider: "ollama",
      attempts: [
        { provider: "deepseek", status: "invalid_output", reason: "invalid_schema" },
        { provider: "ollama", status: "accepted" }
      ]
    });
  });

  it("returns a proposed clarification without invoking the fallback", async () => {
    const primary = provider("deepseek", async () =>
      response({ disposition: "clarify", capability: undefined, arguments: {} })
    );
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "哪一個？",
        candidates: [scheduleCandidate]
      })
    ).resolves.toMatchObject({
      status: "proposed",
      disposition: "clarify",
      provider: "deepseek"
    });
    expect(fallback.completeJson).not.toHaveBeenCalled();
  });

  it("returns no_plan without calling a provider when there are no candidates", async () => {
    const primary = provider("deepseek", async () => response());
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({ profileName: "helper", text: "今天天氣如何", candidates: [] })
    ).resolves.toEqual({ status: "no_plan", reasonCode: "no_candidates", attempts: [] });
    expect(primary.completeJson).not.toHaveBeenCalled();
    expect(fallback.completeJson).not.toHaveBeenCalled();
  });

  it("returns sanitized no_plan diagnostics when both providers are unavailable", async () => {
    const primary = provider("deepseek", async () => {
      throw new Error("secret query and raw provider body");
    });
    const fallback = provider("ollama", async () => {
      throw new Error("https://private.example.test/output");
    });
    const planner = createAgentPlanner({ primary, fallback });

    const result = await planner.propose({
      profileName: "helper",
      text: "sensitive current query",
      candidates: [scheduleCandidate]
    });

    expect(result).toMatchObject({
      status: "no_plan",
      reasonCode: "providers_unavailable",
      attempts: [
        {
          provider: "deepseek",
          status: "unavailable",
          reason: "provider_unavailable",
          candidateCount: 1
        },
        {
          provider: "ollama",
          status: "unavailable",
          reason: "provider_unavailable",
          candidateCount: 1
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sensitive current query");
    expect(JSON.stringify(result)).not.toContain("secret query");
    expect(JSON.stringify(result)).not.toContain("private.example.test");
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).toHaveBeenCalledOnce();
  });

  it("does not call the same resolved provider twice", async () => {
    const primary = provider("ollama", async () => "invalid");
    const fallback = provider("ollama", async () => response());
    const planner = createAgentPlanner({ primary, fallback });

    await expect(
      planner.propose({
        profileName: "helper",
        text: "前攝影",
        candidates: [scheduleCandidate]
      })
    ).resolves.toMatchObject({ status: "no_plan", reasonCode: "invalid_output" });
    expect(primary.completeJson).toHaveBeenCalledOnce();
    expect(fallback.completeJson).not.toHaveBeenCalled();
  });
});

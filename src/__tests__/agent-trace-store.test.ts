import { describe, expect, it } from "vitest";

import {
  formatAgentTurnTraces,
  InMemoryAgentTraceStore,
  RedisAgentTraceStore
} from "../agent/trace-store.js";

const sensitiveValues = [
  "王小明",
  "https://example.invalid/private?token=abc",
  "主日服事表.xlsx",
  "invite_code=SECRET123",
  "system prompt with evidence",
  "drive-item-secret"
];

describe("controlled agent trace sanitization", () => {
  it("persists the same sanitized bounded traces in Redis", async () => {
    const values: string[] = [];
    const store = new RedisAgentTraceStore({
      keyPrefix: "test",
      maxEntries: 2,
      client: {
        lPush: async (_key, value) => values.unshift(value),
        lTrim: async (_key, start, stop) => {
          values.splice(stop + 1);
          return "OK";
        },
        lRange: async (_key, start, stop) => values.slice(start, stop + 1),
        del: async () => {
          const count = values.length > 0 ? 1 : 0;
          values.splice(0);
          return count;
        }
      }
    });

    await store.record({
      requestId: "secret-request",
      occurredAt: "2026-07-17T00:00:00.000Z",
      profileName: "helper-secret",
      sourceType: "group",
      steps: [{ phase: "route", action: "query_schedule", reason: "王小明" }]
    });

    await expect(store.list()).resolves.toEqual([
      {
        requestId: "present",
        occurredAt: "2026-07-17T00:00:00.000Z",
        profileName: "configured",
        sourceType: "group",
        steps: [{ phase: "route", action: "query_schedule" }]
      }
    ]);
    expect(values.join("\n")).not.toMatch(/secret-request|helper-secret|王小明/u);
  });

  it("fails closed for metadata and every legacy trace phase", async () => {
    const store = new InMemoryAgentTraceStore(10);

    await store.record({
      requestId: "request-secret-id",
      occurredAt: "2026-07-14T00:00:00.000Z",
      profileName: "private-profile-id",
      sourceType: "group",
      steps: [
        {
          phase: "route",
          outcome: "execute",
          action: "find_ppt_slides",
          provider: "ollama",
          lane: "function_routing",
          reason: "bare-secret-evidence",
          query: "present",
          ok: true,
          errorName: "主日服事表.xlsx",
          dedup: "drive-item-secret",
          durationMs: 999_999
        },
        {
          phase: "function_error",
          outcome: "function",
          action: "王小明",
          provider: "unknown-provider-secret",
          reason: "invite_code=SECRET123",
          errorName: "private-error-name"
        }
      ]
    });

    const traces = await store.list();
    expect(traces).toEqual([
      {
        requestId: "present",
        occurredAt: "2026-07-14T00:00:00.000Z",
        profileName: "configured",
        sourceType: "group",
        steps: [
          {
            phase: "route",
            outcome: "execute",
            action: "find_ppt_slides",
            provider: "ollama",
            lane: "function_routing",
            query: "present",
            ok: true,
            errorName: "Error",
            durationMs: 60_000
          },
          { phase: "function_error", outcome: "function", errorName: "Error" }
        ]
      }
    ]);
    expect(JSON.stringify(traces)).not.toMatch(
      /request-secret-id|private-profile-id|bare-secret|主日服事表|drive-item|王小明|unknown-provider|SECRET123|private-error/u
    );
  });

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
        requestId: "present",
        occurredAt: "2026-07-14T00:00:00.000Z",
        profileName: "configured",
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

  it("keeps a sanitized slot-collection decision without recording user content", async () => {
    const store = new InMemoryAgentTraceStore(10);
    await store.record({
      requestId: "collect-secret-request",
      occurredAt: "2026-07-14T00:00:00.000Z",
      profileName: "helper",
      sourceType: "group",
      steps: [
        {
          phase: "plan_validation",
          outcome: "collect",
          disposition: "collect",
          validatorReason: "missing_required_slot",
          action: "save_schedule",
          content: "七/17五世緯家園"
        },
        {
          phase: "slot_clarification",
          outcome: "collect",
          action: "save_schedule",
          prompt: "請貼上服事表"
        }
      ] as never
    });

    const formatted = formatAgentTurnTraces(await store.list());
    expect(formatted).toContain("disposition:collect");
    expect(formatted).toContain("validator:missing_required_slot");
    expect(formatted).toContain("action:save_schedule");
    expect(formatted).not.toMatch(/世緯家園|請貼上服事表|collect-secret-request/u);
  });
});

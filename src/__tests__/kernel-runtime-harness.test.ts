import { describe, expect, it, vi } from "vitest";

import type { AgentPlanner } from "../agent/planner.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createKernelRuntimeHarness } from "../evals/kernel/runtime-harness.js";
import { createQueryScheduleHandler } from "../functions/query-schedule.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import type { BotProfileConfig } from "../types.js";

const now = () => new Date("2026-07-16T08:00:00.000Z");

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    allowedProviders: ["deepseek", "ollama"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: {
      meetingWindows: [],
      domains: [
        {
          key: "media_schedule",
          displayName: "媒體服事",
          aliases: ["媒體"],
          routingHints: ["音控"],
          schemaVersion: 1,
          inputSchema: "assignment_rows_v1",
          occurrencePolicy: "profile_meeting_windows_v1",
          binding: {
            kind: "canonical",
            sourceKeys: ["media_schedule"],
            allowLiveFallback: false
          },
          origins: ["line"],
          writePolicy: { mode: "read_only", allowedOperations: [] },
          priority: 20,
          revision: "1",
          freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
        },
        {
          key: "morning_schedule",
          displayName: "晨間服事",
          aliases: ["晨間"],
          routingHints: ["帶領"],
          schemaVersion: 1,
          inputSchema: "assignment_rows_v1",
          occurrencePolicy: "profile_meeting_windows_v1",
          binding: {
            kind: "canonical",
            sourceKeys: ["morning_schedule"],
            allowLiveFallback: false
          },
          origins: ["line"],
          writePolicy: { mode: "read_only", allowedOperations: [] },
          priority: 10,
          revision: "1",
          freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
        }
      ]
    }
  };
}

function planner(): AgentPlanner {
  return {
    propose: vi.fn(async ({ text }) => ({
      status: "proposed" as const,
      version: 1 as const,
      disposition: "execute" as const,
      capability: "query_schedule" as const,
      arguments: {
        query: text,
        dateIntent: "next_meeting" as const,
        ...(/音控/u.test(text) ? { role: "音控" } : {})
      },
      confidence: 0.98,
      provider: "deepseek" as const,
      attempts: []
    }))
  };
}

async function fixture() {
  const schedules = new InMemoryScheduleStore();
  for (const [sourceKey, assignee] of [
    ["media_schedule", "同工甲"],
    ["morning_schedule", "同工乙"]
  ] as const) {
    await schedules.upsertItem({
      profileName: "helper",
      sourceKey,
      origin: "line",
      externalId: `${sourceKey}-1`,
      serviceDate: "2026-07-17",
      meeting: "聚會",
      role: "音控",
      assignee
    });
  }
  const handler = createQueryScheduleHandler({
    memoryStore: new InMemoryAgentMemoryStore({ now }),
    scheduleStore: schedules,
    now,
    timeZone: "Asia/Taipei"
  });
  return createKernelRuntimeHarness({
    now,
    profile: profile(),
    functionRegistry: { query_schedule: handler },
    planner: planner(),
    elapsedMs: () => 25
  });
}

describe("Kernel real-turn runtime harness", () => {
  it("runs an explicit domain query through the controlled runtime", async () => {
    const harness = await fixture();

    const [result] = await harness.runTurns([
      {
        text: "下一場媒體服事音控是誰",
        requesterUserId: "U_SYNTHETIC_1",
        requestId: "kernel-turn-1"
      }
    ]);

    expect(result).toMatchObject({
      replyText: "音控：同工甲",
      resultStatus: "success",
      elapsedMs: 25
    });
    expect(result?.trace[0]?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "capability_candidates" }),
        expect.objectContaining({ phase: "plan_validation" }),
        expect.objectContaining({ phase: "result_envelope", resultStatus: "success" })
      ])
    );
  });

  it("returns a genuine domain clarification when multiple sources match", async () => {
    const harness = await fixture();

    const [result] = await harness.runTurns([
      {
        text: "下一場服事",
        requesterUserId: "U_SYNTHETIC_1",
        requestId: "kernel-turn-2"
      }
    ]);

    expect(result?.resultStatus).toBe("ambiguous");
    expect(result?.quickReplyLabels).toEqual(["媒體服事", "晨間服事"]);
  });

  it("does not expose one requester active task to another requester", async () => {
    const harness = await fixture();

    const results = await harness.runTurns([
      {
        text: "下一場媒體服事",
        requesterUserId: "U_SYNTHETIC_1",
        requestId: "kernel-turn-3"
      },
      {
        text: "那一位呢",
        requesterUserId: "U_SYNTHETIC_2",
        requestId: "kernel-turn-4"
      }
    ]);

    expect(results[1]?.replyText).not.toBe("音控：同工甲");
    expect(JSON.stringify(results[1]?.trace)).not.toContain("U_SYNTHETIC_1");
  });
});

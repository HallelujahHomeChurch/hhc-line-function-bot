import { describe, expect, it } from "vitest";

import { InMemoryAgentJobStore, RedisAgentJobStore } from "../agent/jobs.js";
import { handleAgentTextTurnWithLongJob } from "../transport/line/postbacks.js";
import type { BotProfileConfig, FunctionExecutionResult } from "../types.js";

const scope = {
  profileName: "helper",
  sourceKey: "group:g1",
  requesterUserId: "u1"
};

describe("agent long-running jobs", () => {
  it("keeps job results scoped to the requester and source", async () => {
    const store = new InMemoryAgentJobStore({
      now: () => new Date("2026-07-08T10:00:00.000Z")
    });

    const job = await store.createPending({
      scope,
      capability: "query_schedule",
      label: "查投影片",
      ttlMs: 600_000
    });
    await store.complete(job.id, { ok: true, replyText: "下載連結" });

    await expect(store.get(job.id, scope)).resolves.toMatchObject({
      capability: "query_schedule",
      status: "completed",
      result: { replyText: "下載連結" }
    });
    await expect(store.get(job.id, { ...scope, requesterUserId: "u2" })).resolves.toBeUndefined();
  });

  it("stores Redis job results with the same requester/source guard", async () => {
    const client = new FakeRedisJobClient();
    const store = new RedisAgentJobStore({
      client,
      keyPrefix: "test",
      idFactory: () => "job-1",
      now: () => new Date("2026-07-08T10:00:00.000Z")
    });

    const job = await store.createPending({
      scope,
      capability: "query_schedule",
      label: "lookup",
      ttlMs: 600_000
    });
    await store.complete(job.id, { ok: true, replyText: "result ready" });

    await expect(store.get("job-1", scope)).resolves.toMatchObject({
      capability: "query_schedule",
      status: "completed",
      result: { replyText: "result ready" }
    });
    await expect(store.get("job-1", { ...scope, requesterUserId: "u2" })).resolves.toBeUndefined();
  });

  it("fails a slow result that has no owning capability instead of storing it for replay", async () => {
    const store = new InMemoryAgentJobStore();
    let resolveTurn: (result: FunctionExecutionResult | undefined) => void = () => undefined;
    const turnResult = new Promise<FunctionExecutionResult | undefined>((resolve) => {
      resolveTurn = resolve;
    });
    const profile: BotProfileConfig = {
      name: "helper",
      webhookPath: "/api/line/webhook/helper",
      channelSecret: "secret",
      channelAccessToken: "token",
      allowDirectUser: true,
      allowRooms: false,
      allowedMessageTypes: ["text"],
      groupRequireWakeWord: false,
      wakeKeywords: [],
      acceptMention: true,
      enabledFunctions: ["query_schedule"],
      permissionRequiredFunctions: [],
      allowedProviders: ["deepseek"],
      allowSubscriptionProviders: false,
      longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1, resultTtlMinutes: 10 }
    };
    const pendingReply = await handleAgentTextTurnWithLongJob({
      runtime: { handleTextTurn: () => turnResult },
      jobStore: store,
      profile,
      event: {
        type: "message",
        replyToken: "reply",
        source: { type: "user", userId: "u1" },
        message: { type: "text", text: "slow" }
      },
      requestId: "slow-ownerless",
      allowRouting: true
    });
    const action = pendingReply?.quickReplies?.[0]?.action;
    const data = action?.type === "postback" ? action.data : "";
    const jobId = new URLSearchParams(data).get("jobId");
    expect(jobId).toBeTruthy();

    resolveTurn({ ok: true, replyText: "unsafe ownerless result" });
    await turnResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      store.get(jobId!, {
        profileName: "helper",
        sourceKey: "user:u1",
        requesterUserId: "u1"
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: "missing_capability_owner"
    });
  });
});

class FakeRedisJobClient {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

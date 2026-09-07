import { describe, expect, it, vi } from "vitest";

import type { CapabilityName } from "../capabilities/names.js";
import { InMemoryAgentJobStore, RedisAgentJobStore } from "../agent/jobs.js";
import {
  handleAgentOperationWithLongJob,
  handleAgentTextTurnWithLongJob,
  handlePostbackEvent
} from "../transport/line/postbacks.js";
import type { BotProfileConfig, FunctionExecutionResult } from "../types.js";

const scope = {
  profileName: "helper",
  sourceKey: "group:g1",
  requesterUserId: "u1"
};

describe("agent long-running jobs", () => {
  it("keeps an in-memory completed result immutable when fail arrives later", async () => {
    const store = new InMemoryAgentJobStore();
    const job = await store.createPending({ scope, label: "immutable", ttlMs: 600_000 });
    await store.complete(job.id, { ok: true, replyText: "completed result" }, "query_schedule");

    await store.fail(job.id, "late failure");

    await expect(store.get(job.id, scope)).resolves.toMatchObject({
      status: "completed",
      result: { replyText: "completed result" }
    });

    const failed = await store.createPending({ scope, label: "failed", ttlMs: 600_000 });
    await store.fail(failed.id, "first failure");
    await store.fail(failed.id, "late replacement");
    await expect(store.get(failed.id, scope)).resolves.toMatchObject({
      status: "failed",
      error: "first failure"
    });
  });

  it("fails closed when Redis eval is unavailable instead of racing a job transition", async () => {
    const store = new RedisAgentJobStore({
      client: new FakeRedisJobClient(),
      keyPrefix: "test",
      idFactory: () => "job-no-eval"
    });
    const job = await store.createPending({ scope, label: "pending", ttlMs: 600_000 });

    await store.fail(job.id, "failure");

    await expect(store.get(job.id, scope)).resolves.toMatchObject({ status: "pending" });
  });

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

  it("replays explicit public results, checks every capability, and rejects expired previews", async () => {
    const store = new InMemoryAgentJobStore();
    const profile = jobProfile();
    const event = {
      type: "postback" as const,
      source: { type: "group" as const, groupId: "g1", userId: "u1" }
    };
    const job = await store.createPending({ scope, label: "safe", ttlMs: 60_000 });
    const retrieve = (
      authorize?: (names: readonly CapabilityName[]) => Promise<readonly CapabilityName[]>
    ) =>
      handlePostbackEvent(
        { ...event, postback: { data: `action=agent_job_result&jobId=${job.id}` } },
        profile,
        {},
        "request",
        undefined,
        store,
        ["query_schedule", "save_memory"],
        authorize
      );
    await store.complete(job.id, {
      ok: true,
      replyText: "plain answer",
      resultAuthority: { kind: "public" }
    });
    expect((await retrieve()).result.replyText).toBe("plain answer");
    await store.complete(job.id, {
      ok: true,
      replyText: "protected",
      resultAuthority: { kind: "capabilities", capabilities: ["query_schedule", "save_memory"] }
    });
    expect((await retrieve(async () => [])).result.replyText).not.toBe("protected");
    expect((await retrieve(async (names) => names)).result.replyText).toBe("protected");
    await store.complete(job.id, {
      ok: true,
      replyText: "old preview",
      resultAuthority: { kind: "public", expiresAt: "2000-01-01T00:00:00.000Z" }
    });
    expect((await retrieve()).result.replyText).toContain("預覽已經過期");
  });

  it("reuses the pending button after restart and eventually expires without rerunning an agent", async () => {
    let now = new Date("2026-07-08T10:00:00Z");
    const client = new FakeRedisJobClient();
    const options = { client, keyPrefix: "restart", now: () => now };
    const writer = new RedisAgentJobStore(options);
    const job = await writer.createPending({ scope, label: "pending", ttlMs: 100 });
    const restarted = new RedisAgentJobStore(options);
    const retrieve = () =>
      handlePostbackEvent(
        {
          type: "postback",
          source: { type: "group", groupId: "g1", userId: "u1" },
          postback: { data: `action=agent_job_result&jobId=${job.id}` }
        },
        jobProfile(),
        {},
        "request",
        undefined,
        restarted
      );
    const first = await retrieve();
    expect((await retrieve()).result).toEqual(first.result);
    expect(first.result.quickReplies?.[0]?.action).toMatchObject({
      data: `action=agent_job_result&jobId=${job.id}`
    });
    now = new Date(now.getTime() + 200);
    expect((await retrieve()).result.replyText).toContain("過期");
  });

  it("returns a pending result for a slow review operation and persists its completion", async () => {
    const store = new InMemoryAgentJobStore();
    let complete!: (result: FunctionExecutionResult) => void;
    const operation = vi.fn(
      () =>
        new Promise<FunctionExecutionResult>((resolve) => {
          complete = resolve;
        })
    );
    const reply = await handleAgentOperationWithLongJob({
      jobStore: store,
      profile: {
        ...jobProfile(),
        longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1, resultTtlMinutes: 30 }
      },
      event: { type: "postback", source: { type: "group", groupId: "g1", userId: "u1" } },
      operation
    });
    const action = reply?.quickReplies?.[0]?.action;
    const jobId = new URLSearchParams(action?.type === "postback" ? action.data : "").get("jobId")!;
    complete({ ok: true, replyText: "saved", executedAction: "save_memory", writePhase: "commit" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operation).toHaveBeenCalledTimes(1);
    expect(await store.get(jobId, scope)).toMatchObject({
      status: "completed",
      capability: "save_memory",
      result: { replyText: "saved" }
    });
  });

  it("clears the inline timer when the agent completes early", async () => {
    vi.useFakeTimers();
    try {
      await handleAgentTextTurnWithLongJob({
        runtime: { handleTextTurn: async () => ({ ok: true, replyText: "hello" }) },
        jobStore: new InMemoryAgentJobStore(),
        profile: jobProfile(),
        event: { type: "message", source: { type: "user", userId: "u1" } },
        requestId: "fast"
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive expired results even if Redis has not evicted the key", async () => {
    let now = new Date("2026-07-08T10:00:00Z");
    const client = new FakeRedisJobClient();
    const store = new RedisAgentJobStore({
      client,
      keyPrefix: "test",
      now: () => now
    });
    const job = await store.createPending({ scope, label: "expired", ttlMs: 100 });
    now = new Date(now.getTime() + 200);
    await store.complete(job.id, { ok: true, replyText: "too late" });
    expect(await store.get(job.id, scope)).toBeUndefined();
    expect(JSON.parse([...client.values.values()][0]!).status).toBe("pending");
  });

  it.each([
    {
      name: "rejects ownerless",
      result: { ok: true, replyText: "unsafe ownerless result" },
      status: "failed"
    },
    {
      name: "stores explicit public",
      result: { ok: true, replyText: "plain answer", resultAuthority: { kind: "public" as const } },
      status: "completed"
    },
    {
      name: "stores protected",
      result: {
        ok: true,
        replyText: "protected",
        resultAuthority: {
          kind: "capabilities" as const,
          capabilities: ["query_schedule" as const]
        }
      },
      status: "completed"
    }
  ])("$name slow result", async ({ result, status }) => {
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
      requestId: "slow-ownerless"
    });
    const action = pendingReply?.quickReplies?.[0]?.action;
    const data = action?.type === "postback" ? action.data : "";
    const jobId = new URLSearchParams(data).get("jobId");
    expect(jobId).toBeTruthy();

    resolveTurn(result);
    await turnResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      store.get(jobId!, {
        profileName: "helper",
        sourceKey: "user:u1",
        requesterUserId: "u1"
      })
    ).resolves.toMatchObject({
      status,
      ...(status === "failed" ? { error: "missing_capability_owner" } : { result })
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

function jobProfile(): BotProfileConfig {
  return {
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
    longRunningJobs: { enabled: true, inlineReplyTimeoutMs: 1000, resultTtlMinutes: 30 }
  };
}

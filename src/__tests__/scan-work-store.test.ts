import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore, type AgentJobStore } from "../agent/jobs.js";
import {
  InMemoryAttachmentScanWorkStore,
  RedisAttachmentScanWorkStore
} from "../attachments/scan-work-store.js";
import type { FunctionExecutionResult } from "../types.js";

const now = new Date("2026-07-24T04:00:00.000Z");
const scope = {
  profileName: "helper",
  sourceKey: "group:C1",
  requesterUserId: "U1"
};

describe("attachment scan work store", () => {
  it("atomically yields one record to two parallel claim attempts", async () => {
    const client = new FakeRedisScanWorkClient();
    const jobStore = new InMemoryAgentJobStore({ now: () => now });
    const job = await jobStore.createPending({
      scope,
      label: "保存檔案",
      ttlMs: 600_000
    });
    const store = new RedisAttachmentScanWorkStore({
      client,
      keyPrefix: "test",
      jobStore,
      now: () => now,
      idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);

    const claimed = await Promise.all([store.claim(work.id), store.claim(work.id)]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(claimed.find(Boolean)).toMatchObject({
      id: work.id,
      status: "claimed",
      lineMessageId: "line-message-opaque-id",
      scope,
      target: { title: "SundayDeck" }
    });
    expect(client.evalCalls).toHaveLength(4);
  });

  it("atomically cancels only work that has not already been claimed", async () => {
    const client = new FakeRedisScanWorkClient();
    const jobStore = new InMemoryAgentJobStore({ now: () => now });
    const store = new RedisAttachmentScanWorkStore({
      client,
      keyPrefix: "test",
      jobStore,
      now: () => now,
      idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });

    await expect(store.cancelPendingEnqueue(work.id, "enqueue_failed")).resolves.toBe(true);
    await expect(store.claim(work.id)).resolves.toBeUndefined();
    await expect(store.cancelPendingEnqueue(work.id, "enqueue_failed")).resolves.toBe(false);
  });

  it("refuses expired, completed, already-claimed, or foreign work", async () => {
    const client = new FakeRedisScanWorkClient();
    const jobStore = new InMemoryAgentJobStore({ now: () => now });
    const store = new RedisAttachmentScanWorkStore({
      client,
      keyPrefix: "test",
      jobStore,
      now: () => now,
      idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);

    await expect(store.claim(work.id)).resolves.toMatchObject({ status: "claimed" });
    await expect(store.claim(work.id)).resolves.toBeUndefined();

    const key = "test:attachment-scan-work:4c03465b-8a87-45a2-9d0d-54f904f4e6ab";
    client.values.set(key, JSON.stringify({ ...work, id: "foreign-id", status: "confirmed" }));
    await expect(store.claim(work.id)).resolves.toBeUndefined();

    client.values.set(
      key,
      JSON.stringify({
        ...work,
        status: "confirmed",
        expiresAt: "2026-07-24T03:59:59.000Z"
      })
    );
    await expect(store.claim(work.id)).resolves.toBeUndefined();

    client.values.set(key, JSON.stringify({ ...work, status: "completed" }));
    await expect(store.claim(work.id)).resolves.toBeUndefined();

    client.values.set(
      key,
      JSON.stringify({
        ...work,
        status: "confirmed",
        scope: { profileName: "helper", sourceKey: "group:C1" }
      })
    );
    await expect(store.claim(work.id)).resolves.toBeUndefined();
  });

  it("reclaims a crashed claim only after its bounded lease expires", async () => {
    let current = new Date("2026-07-24T04:00:00.000Z");
    let leaseSequence = 0;
    const jobStore = new InMemoryAgentJobStore({ now: () => current });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const store = new InMemoryAttachmentScanWorkStore({
      jobStore,
      now: () => current,
      claimLeaseMs: 60_000,
      claimIdFactory: () => `lease-${++leaseSequence}`
    });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);

    const first = await store.claim(work.id);
    expect(first).toMatchObject({
      status: "claimed",
      claimId: "lease-1",
      claimExpiresAt: "2026-07-24T04:01:00.000Z"
    });
    await expect(store.claim(work.id)).resolves.toBeUndefined();

    current = new Date("2026-07-24T04:01:00.000Z");
    const reclaimed = await store.claim(work.id);
    expect(reclaimed).toMatchObject({
      status: "claimed",
      claimId: "lease-2",
      claimExpiresAt: "2026-07-24T04:02:00.000Z"
    });

    await expect(store.fail(work.id, first!.claimId!, "worker_failed")).resolves.toBe(false);
    await expect(store.terminalStatus(work.id)).resolves.toBeUndefined();
    await expect(store.fail(work.id, reclaimed!.claimId!, "worker_failed")).resolves.toBe(true);
    await expect(store.terminalStatus(work.id)).resolves.toBe("failed");
  });

  it("fences publication and never reclaims a worker after publishing starts", async () => {
    let current = new Date("2026-07-24T04:00:00.000Z");
    let leaseSequence = 0;
    const jobStore = new InMemoryAgentJobStore({ now: () => current });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const store = new InMemoryAttachmentScanWorkStore({
      jobStore,
      now: () => current,
      claimLeaseMs: 60_000,
      claimIdFactory: () => `lease-${++leaseSequence}`
    });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);
    const claim = await store.claim(work.id);

    await expect(store.beginPublishing(work.id, claim!.claimId!)).resolves.toBe(true);
    current = new Date("2026-07-24T04:01:00.000Z");

    await expect(store.claimForProcessing(work.id)).resolves.toEqual({
      disposition: "active"
    });
    await expect(store.claim(work.id)).resolves.toBeUndefined();
  });

  it("rejects a stale worker publication fence and every stale AgentJobStore write", async () => {
    let current = new Date("2026-07-24T04:00:00.000Z");
    let leaseSequence = 0;
    const complete = vi.fn<AgentJobStore["complete"]>();
    const fail = vi.fn<AgentJobStore["fail"]>();
    const backingJobs = new InMemoryAgentJobStore({ now: () => current });
    const jobStore: AgentJobStore = {
      createPending: (input) => backingJobs.createPending(input),
      complete,
      fail,
      get: (id, requestedScope) => backingJobs.get(id, requestedScope)
    };
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const store = new InMemoryAttachmentScanWorkStore({
      jobStore,
      now: () => current,
      claimLeaseMs: 60_000,
      claimIdFactory: () => `lease-${++leaseSequence}`
    });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);
    const stale = await store.claim(work.id);
    current = new Date("2026-07-24T04:01:00.000Z");
    const replacement = await store.claim(work.id);

    await expect(store.beginPublishing(work.id, stale!.claimId!)).resolves.toBe(false);
    await expect(store.fail(work.id, stale!.claimId!, "worker_failed")).resolves.toBe(false);
    await expect(store.complete(work.id, stale!.claimId!, successfulResult())).resolves.toBe(false);
    expect(fail).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    await expect(store.beginPublishing(work.id, replacement!.claimId!)).resolves.toBe(true);
  });

  it.each(["complete", "fail"] as const)(
    "commits the Redis terminal CAS before the AgentJobStore %s write",
    async (transition) => {
      const order: string[] = [];
      const client = new FakeRedisScanWorkClient({
        onTerminalTransition: () => order.push("work-terminal-cas")
      });
      const backingJobs = new InMemoryAgentJobStore({ now: () => now });
      const jobStore: AgentJobStore = {
        createPending: (input) => backingJobs.createPending(input),
        complete: async (id, result) => {
          order.push("job-complete");
          await backingJobs.complete(id, result);
        },
        fail: async (id, error) => {
          order.push("job-fail");
          await backingJobs.fail(id, error);
        },
        get: (id, requestedScope) => backingJobs.get(id, requestedScope)
      };
      const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
      const store = new RedisAttachmentScanWorkStore({
        client,
        keyPrefix: "test",
        jobStore,
        now: () => now,
        idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        claimIdFactory: () => "lease-1"
      });
      const work = await store.create({
        jobId: job.id,
        lineMessageId: "line-message-opaque-id",
        scope,
        target: {
          sourceKey: "ppt_slides",
          itemKind: "ppt_slide",
          domain: "presentation",
          title: "SundayDeck"
        },
        ttlMs: 600_000
      });
      await store.markEnqueued(work.id);
      const claim = await store.claim(work.id);
      if (transition === "complete") {
        await store.beginPublishing(work.id, claim!.claimId!);
        await expect(store.complete(work.id, claim!.claimId!, successfulResult())).resolves.toBe(
          true
        );
      } else {
        await expect(store.fail(work.id, claim!.claimId!, "scan_infected")).resolves.toBe(true);
      }

      expect(order).toEqual([
        "work-terminal-cas",
        transition === "complete" ? "job-complete" : "job-fail"
      ]);
    }
  );

  it.each(["complete", "fail"] as const)(
    "reconciles a Redis AgentJobStore %s write after a crash following terminal CAS",
    async (transition) => {
      const client = new FakeRedisScanWorkClient();
      const backingJobs = new InMemoryAgentJobStore({ now: () => now });
      let shouldCrash = true;
      const complete = vi.fn<AgentJobStore["complete"]>(async (id, result) => {
        if (shouldCrash) {
          shouldCrash = false;
          throw new Error("synthetic_crash_after_terminal_cas");
        }
        await backingJobs.complete(id, result);
      });
      const fail = vi.fn<AgentJobStore["fail"]>(async (id, error) => {
        if (shouldCrash) {
          shouldCrash = false;
          throw new Error("synthetic_crash_after_terminal_cas");
        }
        await backingJobs.fail(id, error);
      });
      const jobStore: AgentJobStore = {
        createPending: (input) => backingJobs.createPending(input),
        complete,
        fail,
        get: (id, requestedScope) => backingJobs.get(id, requestedScope)
      };
      const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
      const store = new RedisAttachmentScanWorkStore({
        client,
        keyPrefix: "test",
        jobStore,
        now: () => now,
        idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        claimIdFactory: () => "lease-1"
      });
      const work = await store.create({
        jobId: job.id,
        lineMessageId: "line-message-opaque-id",
        scope,
        target: {
          sourceKey: "ppt_slides",
          itemKind: "ppt_slide",
          domain: "presentation",
          title: "SundayDeck"
        },
        ttlMs: 600_000
      });
      await store.markEnqueued(work.id);
      const claim = await store.claim(work.id);
      if (transition === "complete") {
        await store.beginPublishing(work.id, claim!.claimId!);
        await expect(store.complete(work.id, claim!.claimId!, successfulResult())).rejects.toThrow(
          "synthetic_crash_after_terminal_cas"
        );
      } else {
        await expect(store.fail(work.id, claim!.claimId!, "scan_infected")).rejects.toThrow(
          "synthetic_crash_after_terminal_cas"
        );
      }
      await expect(backingJobs.get(job.id, scope)).resolves.toMatchObject({ status: "pending" });

      await expect(store.claimForProcessing(work.id)).resolves.toEqual({
        disposition: "terminal",
        terminalStatus: transition === "complete" ? "completed" : "failed"
      });
      await expect(backingJobs.get(job.id, scope)).resolves.toMatchObject({
        status: transition === "complete" ? "completed" : "failed"
      });
      expect(transition === "complete" ? complete : fail).toHaveBeenCalledTimes(2);
    }
  );

  it("terminal-fails an abandoned publication without making it publishable again", async () => {
    let current = new Date("2026-07-24T04:00:00.000Z");
    const jobStore = new InMemoryAgentJobStore({ now: () => current });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const store = new InMemoryAttachmentScanWorkStore({
      jobStore,
      now: () => current,
      claimLeaseMs: 60_000,
      publishingLeaseMs: 120_000,
      claimIdFactory: () => "lease-1"
    });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);
    const claim = await store.claim(work.id);
    await store.beginPublishing(work.id, claim!.claimId!, new Date("2026-07-24T04:01:00.000Z"));

    current = new Date("2026-07-24T04:01:00.000Z");

    await expect(store.claimForProcessing(work.id)).resolves.toEqual({
      disposition: "terminal",
      terminalStatus: "failed"
    });
    await expect(store.claim(work.id)).resolves.toBeUndefined();
    await expect(jobStore.get(job.id, scope)).resolves.toMatchObject({
      status: "failed",
      error: "publication_abandoned"
    });
  });

  it("distinguishes missing or expired work from active and terminal work", async () => {
    let current = new Date("2026-07-24T04:00:00.000Z");
    const jobStore = new InMemoryAgentJobStore({ now: () => current });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 60_000 });
    const store = new InMemoryAttachmentScanWorkStore({ jobStore, now: () => current });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 60_000
    });

    await expect(store.claimForProcessing("missing-opaque-work")).resolves.toEqual({
      disposition: "missing"
    });
    await expect(store.claimForProcessing(work.id)).resolves.toEqual({
      disposition: "active"
    });

    current = new Date("2026-07-24T04:01:00.000Z");
    await expect(store.claimForProcessing(work.id)).resolves.toEqual({
      disposition: "missing"
    });
  });

  it("atomically reports terminal work for safe queue redelivery acknowledgement", async () => {
    const jobStore = new InMemoryAgentJobStore({ now: () => now });
    const job = await jobStore.createPending({ scope, label: "保存檔案", ttlMs: 600_000 });
    const store = new InMemoryAttachmentScanWorkStore({ jobStore, now: () => now });
    const work = await store.create({
      jobId: job.id,
      lineMessageId: "line-message-opaque-id",
      scope,
      target: {
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      ttlMs: 600_000
    });
    await store.markEnqueued(work.id);
    const claim = await store.claim(work.id);
    await store.fail(work.id, claim!.claimId!, "scan_infected");

    await expect(store.terminalStatus(work.id)).resolves.toBe("failed");
    await expect(store.claim(work.id)).resolves.toBeUndefined();
  });
});

class FakeRedisScanWorkClient {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly evalCalls: Array<{
    script: string;
    options: { keys: string[]; arguments: string[] };
  }> = [];

  constructor(
    private readonly options: {
      onTerminalTransition?: () => void;
    } = {}
  ) {}

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async sMembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async sAdd(key: string, member: string): Promise<void> {
    const values = this.sets.get(key) ?? new Set<string>();
    values.add(member);
    this.sets.set(key, values);
  }

  async sRem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<string | null> {
    this.evalCalls.push({ script, options });
    const [key] = options.keys;
    if (script.includes('redis.call("SADD"')) {
      this.values.set(key!, options.arguments[1]!);
      await this.sAdd(options.keys[1]!, options.arguments[2]!);
      return options.arguments[1]!;
    }
    const [expectedId, currentTime] = options.arguments;
    const raw = this.values.get(key);
    if (!raw) return script.includes("local claimable =") ? "missing" : null;
    const record = JSON.parse(raw) as {
      id: string;
      status: string;
      expiresAt: string;
      claimedAt?: string;
      claimId?: string;
      claimExpiresAt?: string;
      publishingAt?: string;
      publishingExpiresAt?: string;
      pendingJobUpdate?: unknown;
    };
    if (record.id !== expectedId || !isValidWork(record)) {
      return null;
    }
    let transitioned: Record<string, unknown>;
    if (script.includes("work.pendingJobUpdate = nil")) {
      if (
        (record.status !== "completed" && record.status !== "failed") ||
        record.pendingJobUpdate === undefined
      ) {
        return null;
      }
      transitioned = { ...record, pendingJobUpdate: undefined };
    } else if (script.includes("local ownsClaim =")) {
      const [, claimId, operation, status, completedAt, failureCode, pendingJobUpdate] =
        options.arguments;
      const ownsLiveClaim =
        record.status === "claimed" &&
        operation === "fail" &&
        record.claimExpiresAt! > completedAt!;
      const ownsLivePublication =
        record.status === "publishing" && record.publishingExpiresAt! > completedAt!;
      if (
        record.claimId !== claimId ||
        record.expiresAt <= completedAt! ||
        (!ownsLiveClaim && !ownsLivePublication) ||
        (operation === "complete" && record.status !== "publishing")
      ) {
        return null;
      }
      transitioned = {
        ...record,
        status,
        completedAt,
        claimId: undefined,
        claimExpiresAt: undefined,
        pendingJobUpdate: JSON.parse(pendingJobUpdate!),
        ...(failureCode ? { failureCode } : {})
      };
      this.options.onTerminalTransition?.();
    } else if (script.includes('work.status = "publishing"')) {
      const [, claimId, publishingAt, publishingExpiresAt] = options.arguments;
      if (
        record.status !== "claimed" ||
        record.claimId !== claimId ||
        record.claimExpiresAt! <= publishingAt! ||
        record.expiresAt <= publishingAt! ||
        publishingExpiresAt! <= publishingAt!
      ) {
        return null;
      }
      transitioned = {
        ...record,
        status: "publishing",
        claimExpiresAt: undefined,
        publishingAt,
        publishingExpiresAt
      };
    } else if (script.includes('work.status = "queued"')) {
      if (record.status !== "pending_enqueue" || record.expiresAt <= currentTime) return null;
      transitioned = { ...record, status: "queued" };
    } else if (script.includes("local claimable =")) {
      if (record.expiresAt <= currentTime) return "missing";
      if (record.status === "completed" || record.status === "failed") {
        return `terminal:${JSON.stringify(record)}`;
      }
      if (record.status === "publishing") {
        if (record.publishingExpiresAt! <= currentTime) {
          transitioned = {
            ...record,
            status: "failed",
            failureCode: "publication_abandoned",
            claimId: undefined,
            claimExpiresAt: undefined,
            pendingJobUpdate: {
              status: "failed",
              error: "publication_abandoned"
            },
            completedAt: currentTime
          };
        } else {
          return "active";
        }
      } else if (!(
        record.status === "queued" ||
        (record.status === "claimed" && record.claimExpiresAt! <= currentTime)
      )) {
        return "active";
      } else {
        transitioned = {
          ...record,
          status: "claimed",
          claimedAt: options.arguments[2],
          claimId: options.arguments[3],
          claimExpiresAt: options.arguments[4],
          publishingAt: undefined,
          publishingExpiresAt: undefined
        };
      }
    } else if (script.includes('work.status = "failed"')) {
      if (record.status !== "pending_enqueue" || record.expiresAt <= currentTime) return null;
      transitioned = {
        ...record,
        status: "failed",
        failureCode: options.arguments[2],
        completedAt: currentTime
      };
    } else {
      return null;
    }
    const serialized = JSON.stringify(transitioned);
    this.values.set(key, serialized);
    if (script.includes('redis.call("SREM"')) {
      await this.sRem(options.keys[1]!, expectedId!);
    }
    if (
      script.includes("local claimable =") &&
      (transitioned.status === "failed" || transitioned.status === "completed")
    ) {
      return `abandoned:${serialized}`;
    }
    return serialized;
  }
}

function successfulResult(): FunctionExecutionResult {
  return {
    ok: true,
    executedAction: "save_resource",
    writePhase: "commit",
    replyText: "檔案已保存。"
  };
}

function isValidWork(record: {
  version?: number;
  jobId?: string;
  lineMessageId?: string;
  scope?: { profileName?: string; sourceKey?: string; requesterUserId?: string };
  target?: { sourceKey?: string; itemKind?: string; domain?: string; title?: string };
}): boolean {
  return Boolean(
    record.version === 1 &&
    record.jobId &&
    record.lineMessageId &&
    record.scope?.profileName &&
    record.scope.sourceKey &&
    record.scope.requesterUserId &&
    record.target?.sourceKey &&
    record.target.itemKind &&
    record.target.domain &&
    record.target.title
  );
}

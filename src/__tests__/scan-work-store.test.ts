import { describe, expect, it } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import {
  InMemoryAttachmentScanWorkStore,
  RedisAttachmentScanWorkStore
} from "../attachments/scan-work-store.js";

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
    if (!raw) return null;
    const record = JSON.parse(raw) as {
      id: string;
      status: string;
      expiresAt: string;
      claimedAt?: string;
      claimId?: string;
      claimExpiresAt?: string;
    };
    if (record.id !== expectedId || !isValidWork(record)) {
      return null;
    }
    let transitioned: Record<string, unknown>;
    if (script.includes('work.status = "queued"')) {
      if (record.status !== "pending_enqueue" || record.expiresAt <= currentTime) return null;
      transitioned = { ...record, status: "queued" };
    } else if (script.includes("local claimable =")) {
      if (
        !(
          record.status === "queued" ||
          (record.status === "claimed" && record.claimExpiresAt! <= currentTime)
        ) ||
        record.expiresAt <= currentTime
      ) {
        return null;
      }
      transitioned = {
        ...record,
        status: "claimed",
        claimedAt: options.arguments[2],
        claimId: options.arguments[3],
        claimExpiresAt: options.arguments[4]
      };
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
    return serialized;
  }
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

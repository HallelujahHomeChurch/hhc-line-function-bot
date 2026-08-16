import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAttachmentScanQueue } from "../attachments/scan-queue.js";
import {
  dispatchAttachmentScanWork,
  flushAttachmentScanOutbox,
  flushMediaSyncOutbox
} from "../attachments/scan-outbox.js";
import {
  InMemoryAttachmentScanWorkStore,
  type AttachmentScanWorkStore
} from "../attachments/scan-work-store.js";

const scope = {
  profileName: "helper",
  sourceKey: "group:C1",
  requesterUserId: "U1"
};

async function createPendingWork(store: AttachmentScanWorkStore) {
  return store.create({
    jobId: "job-1",
    lineMessageId: "line-message-1",
    scope,
    target: {
      sourceKey: "ppt_slides",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "SundayDeck"
    },
    ttlMs: 600_000
  });
}

describe("attachment scan durable outbox", () => {
  it("dispatches committed media-sync operations by opaque ID and exact reservation lease", async () => {
    const claimedUntil = "2099-01-01T00:00:30.000Z";
    const store = {
      claimOutboxForDispatch: vi.fn().mockResolvedValue([
        {
          workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
          sourceKey: "line:helper:private-message-id",
          operation: "delete",
          attempts: 0,
          availableAt: "2099-01-01T00:00:00.000Z",
          claimedUntil
        }
      ]),
      markOutboxDispatched: vi.fn().mockResolvedValue(true)
    };
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const now = new Date("2099-01-01T00:00:00.000Z");

    await expect(
      flushMediaSyncOutbox({ store: store as never, queue, limit: 1, leaseMs: 30_000, now })
    ).resolves.toEqual({ considered: 1, queued: 1 });
    expect(store.claimOutboxForDispatch).toHaveBeenCalledWith({
      limit: 1,
      leaseMs: 30_000,
      now
    });
    expect(queue.enqueue).toHaveBeenCalledWith(
      "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
      "media-sync"
    );
    expect(store.markOutboxDispatched).toHaveBeenCalledWith({
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
      operation: "delete",
      expectedClaimedUntil: claimedUntil
    });
    expect(JSON.stringify(queue.enqueue.mock.calls)).not.toContain("private-message-id");
  });

  it("leaves failed media-sync dispatch reservations for lease reclaim", async () => {
    const store = {
      claimOutboxForDispatch: vi.fn().mockResolvedValue([
        {
          workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
          sourceKey: "line:helper:message-1",
          operation: "intake",
          attempts: 0,
          availableAt: "2099-01-01T00:00:00.000Z",
          claimedUntil: "2099-01-01T00:00:30.000Z"
        }
      ]),
      markOutboxDispatched: vi.fn()
    };
    const queue = { enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable")) };

    await expect(
      flushMediaSyncOutbox({ store: store as never, queue, limit: 1, leaseMs: 30_000 })
    ).resolves.toEqual({ considered: 1, queued: 0 });
    expect(store.markOutboxDispatched).not.toHaveBeenCalled();
  });
  it("keeps a durable pending record when the queue fails before send and Redis is unavailable", async () => {
    const work = { id: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab" };
    const store = {
      supportsDurableEnqueueRetry: true,
      markEnqueued: vi.fn().mockRejectedValue(new Error("redis unavailable"))
    } as unknown as AttachmentScanWorkStore;
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable before send"))
    };

    await expect(dispatchAttachmentScanWork(work.id, { store, queue })).resolves.toBe(
      "retry_scheduled"
    );
    expect(store.markEnqueued).not.toHaveBeenCalled();
  });

  it("flushes persisted pending work and duplicate queue sends remain claim-idempotent", async () => {
    const jobStore = new InMemoryAgentJobStore();
    const base = new InMemoryAttachmentScanWorkStore({ jobStore });
    const work = await createPendingWork(base);
    const store = Object.assign(base, { supportsDurableEnqueueRetry: true as const });
    const queue = new InMemoryAttachmentScanQueue();

    await expect(flushAttachmentScanOutbox({ store, queue, limit: 10 })).resolves.toEqual({
      considered: 1,
      queued: 1
    });
    await queue.enqueue(work.id);

    const claims = await Promise.all([store.claim(work.id), store.claim(work.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(queue.workIds).toEqual([work.id, work.id]);
  });
});

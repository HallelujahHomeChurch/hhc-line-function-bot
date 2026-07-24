import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAttachmentScanQueue } from "../attachments/scan-queue.js";
import {
  dispatchAttachmentScanWork,
  flushAttachmentScanOutbox
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

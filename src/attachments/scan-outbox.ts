import type { AttachmentScanQueue } from "./scan-queue.js";
import type { AttachmentScanWorkStore } from "./scan-work-store.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";

export type AttachmentScanDispatchResult = "queued" | "retry_scheduled";

export interface AttachmentScanOutboxOptions {
  store: AttachmentScanWorkStore;
  queue: AttachmentScanQueue;
}

export async function dispatchAttachmentScanWork(
  workId: string,
  options: AttachmentScanOutboxOptions
): Promise<AttachmentScanDispatchResult> {
  try {
    await options.queue.enqueue(workId);
    if (!(await options.store.markEnqueued(workId))) {
      throw new Error("attachment_scan_outbox_state_unavailable");
    }
    return "queued";
  } catch (error) {
    if (options.store.supportsDurableEnqueueRetry) {
      return "retry_scheduled";
    }
    throw error;
  }
}

export async function flushAttachmentScanOutbox(
  options: AttachmentScanOutboxOptions & { limit: number }
): Promise<{ considered: number; queued: number }> {
  const work = await options.store.listPendingEnqueue(options.limit);
  let queued = 0;
  for (const item of work) {
    try {
      await options.queue.enqueue(item.id);
      if (await options.store.markEnqueued(item.id)) queued += 1;
    } catch {
      // The work remains durably pending. A later bounded pass retries the opaque ID.
    }
  }
  return { considered: work.length, queued };
}

export function startAttachmentScanOutboxDispatcher(
  options: AttachmentScanOutboxOptions & {
    intervalMs?: number;
    batchSize?: number;
  }
): () => void {
  const flush = () =>
    flushAttachmentScanOutbox({
      ...options,
      limit: options.batchSize ?? 20
    }).catch(() => undefined);
  void flush();
  const timer = setInterval(flush, options.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

type MediaSyncDispatchStore = Pick<
  PostgresMediaSyncStore,
  "claimOutboxForDispatch" | "markOutboxDispatched"
>;

export async function flushMediaSyncOutbox(options: {
  store: MediaSyncDispatchStore;
  queue: AttachmentScanQueue;
  limit: number;
  leaseMs: number;
  now?: Date;
}): Promise<{ considered: number; queued: number }> {
  const work = await options.store.claimOutboxForDispatch({
    operation: "intake",
    limit: options.limit,
    leaseMs: options.leaseMs,
    ...(options.now ? { now: options.now } : {})
  });
  let queued = 0;
  for (const item of work) {
    if (!item.claimedUntil) continue;
    try {
      await options.queue.enqueue(item.workId, "media-sync");
      if (
        await options.store.markOutboxDispatched({
          workId: item.workId,
          operation: "intake",
          expectedClaimedUntil: item.claimedUntil
        })
      ) {
        queued += 1;
      }
    } catch {
      // The PostgreSQL reservation expires and a later bounded pass retries the opaque work ID.
    }
  }
  return { considered: work.length, queued };
}

export function startMediaSyncOutboxDispatcher(options: {
  store: MediaSyncDispatchStore;
  queue: AttachmentScanQueue;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
}): () => void {
  const flush = () =>
    flushMediaSyncOutbox({
      store: options.store,
      queue: options.queue,
      limit: options.batchSize ?? 20,
      leaseMs: options.leaseMs ?? 30_000
    }).catch(() => undefined);
  void flush();
  const timer = setInterval(flush, options.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

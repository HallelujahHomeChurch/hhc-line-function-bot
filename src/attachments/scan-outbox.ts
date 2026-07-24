import type { AttachmentScanQueue } from "./scan-queue.js";
import type { AttachmentScanWorkStore } from "./scan-work-store.js";

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

import { createHash } from "node:crypto";

import type { AuditAppendResult } from "./client.js";

export type AuditOutboxItem = {
  eventId: string;
  payload: string;
  payloadHash: string;
  attempts: number;
  claimedUntil: string;
};

type AuditDispatchStore = {
  claimAuditOutbox(input: { limit: number; leaseMs: number }): Promise<AuditOutboxItem[]>;
  markAuditDelivered(item: AuditOutboxItem): Promise<boolean>;
  markAuditRetry(item: AuditOutboxItem, delayMs: number, reason: string): Promise<boolean>;
  markAuditTerminal(item: AuditOutboxItem, reason: string): Promise<boolean>;
};

type AuditStatsStore = AuditDispatchStore & {
  auditOutboxStats(): Promise<{
    pendingCount: number;
    oldestPendingSeconds: number;
    deadLetterCount: number;
  }>;
};

export async function flushAuditOutbox(options: {
  store: AuditDispatchStore;
  client: { append(payload: string): Promise<AuditAppendResult> };
  limit: number;
  leaseMs: number;
}): Promise<{ considered: number; delivered: number; retried: number; terminal: number }> {
  const rows = await options.store.claimAuditOutbox({
    limit: options.limit,
    leaseMs: options.leaseMs
  });
  let delivered = 0;
  let retried = 0;
  let terminal = 0;
  for (const row of rows) {
    if (createHash("sha256").update(row.payload).digest("hex") !== row.payloadHash) {
      if (await options.store.markAuditTerminal(row, "invalid_payload")) terminal += 1;
      continue;
    }
    const result = await options.client.append(row.payload);
    if (result.status === "delivered") {
      if (await options.store.markAuditDelivered(row)) delivered += 1;
    } else if (result.status === "retry") {
      if (row.attempts >= 20) {
        if (await options.store.markAuditTerminal(row, "max_attempts")) terminal += 1;
      } else {
        const delayMs = result.retryAfterMs ?? retryDelay(row.attempts);
        if (await options.store.markAuditRetry(row, delayMs, result.reason)) retried += 1;
      }
    } else if (await options.store.markAuditTerminal(row, result.reason)) {
      terminal += 1;
    }
  }
  return { considered: rows.length, delivered, retried, terminal };
}

export function startAuditOutboxDispatcher(options: {
  store: AuditStatsStore;
  client: { append(payload: string): Promise<AuditAppendResult> };
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
}): () => void {
  const flush = () =>
    flushAuditOutbox({
      store: options.store,
      client: options.client,
      limit: options.batchSize ?? 20,
      leaseMs: options.leaseMs ?? 30_000
    }).catch(() =>
      console.error(
        JSON.stringify({ event: "audit_dispatch_failed", sourceService: "hhc-line-function-bot" })
      )
    );
  void flush();
  const timer = setInterval(flush, options.intervalMs ?? 5_000);
  timer.unref();
  const snapshot = setInterval(() => {
    void options.store
      .auditOutboxStats()
      .then((stats) =>
        console.info(
          JSON.stringify({
            event: "audit_pipeline_snapshot",
            sourceService: "hhc-line-function-bot",
            ...stats
          })
        )
      )
      .catch(() =>
        console.error(
          JSON.stringify({
            event: "audit_pipeline_snapshot_failed",
            sourceService: "hhc-line-function-bot"
          })
        )
      );
  }, 60_000);
  snapshot.unref();
  return () => {
    clearInterval(timer);
    clearInterval(snapshot);
  };
}

function retryDelay(attempts: number): number {
  return [30_000, 120_000, 300_000, 900_000, 3_600_000][attempts - 1] ?? 21_600_000;
}

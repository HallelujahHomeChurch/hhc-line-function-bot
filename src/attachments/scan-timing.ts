const MINUTE_MS = 60_000;

export const ATTACHMENT_SCAN_TIMING = {
  scanDeadlineMs: 10 * MINUTE_MS,
  publicationDeadlineMs: 14 * MINUTE_MS,
  replicaTimeoutMs: 15 * MINUTE_MS,
  ackMarginMs: MINUTE_MS,
  queueVisibilityMs: 17 * MINUTE_MS,
  claimLeaseMs: 20 * MINUTE_MS,
  retryCycles: 2,
  workTtlMs: 60 * MINUTE_MS
} as const;

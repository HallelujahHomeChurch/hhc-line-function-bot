import { createHmac } from "node:crypto";

export const RETRIEVAL_EXECUTION_MODES = [
  "fresh_search",
  "explicit_task_replay",
  "resource_memory_candidate",
  "catalog_snapshot_read",
  "provider_fallback"
] as const;

export const STATE_AGE_BUCKETS = [
  "under_1m",
  "under_10m",
  "under_1h",
  "under_1d",
  "under_30d",
  "unknown"
] as const;

export const FRESHNESS_STATUSES = ["fresh", "stale_allowed", "stale_rejected", "unknown"] as const;

export type RetrievalExecutionMode = (typeof RETRIEVAL_EXECUTION_MODES)[number];
export type StateAgeBucket = (typeof STATE_AGE_BUCKETS)[number];
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

export interface RetrievalDiagnostics {
  executionMode: RetrievalExecutionMode;
  stateAgeBucket?: StateAgeBucket;
  freshnessStatus?: FreshnessStatus;
  sourceRevision?: "present" | "missing";
  queryFingerprint?: string;
  referenceFingerprint?: string;
}

export function diagnosticFingerprint(
  kind: "query" | "reference",
  value: string,
  hmacKey?: string
): string | undefined {
  if (!hmacKey || !value) return undefined;
  return createHmac("sha256", hmacKey)
    .update(`hhc-line-function-bot:${kind}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function stateAgeBucket(createdAt: string | undefined, now: Date): StateAgeBucket {
  if (!createdAt) return "unknown";
  const ageMs = now.getTime() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 60_000) return "under_1m";
  if (ageMs < 10 * 60_000) return "under_10m";
  if (ageMs < 60 * 60_000) return "under_1h";
  if (ageMs < 24 * 60 * 60_000) return "under_1d";
  if (ageMs < 30 * 24 * 60 * 60_000) return "under_30d";
  return "unknown";
}

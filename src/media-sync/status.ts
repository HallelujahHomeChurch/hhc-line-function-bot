export const mediaSyncStatuses = [
  "received",
  "processing",
  "awaiting_scan",
  "published",
  "failed",
  "cancelled",
  "tombstoned"
] as const;
export type MediaSyncStatus = (typeof mediaSyncStatuses)[number];
export type MediaSyncStatusQuery = {
  from: string;
  until: string;
  limit: number;
  after?: { createdAt: string; workId: string };
};
export type MediaSyncStatusItem = {
  workId: string;
  mediaKind: "image" | "video" | "audio" | "file";
  status: MediaSyncStatus;
  receivedAt: string;
  updatedAt: string;
  failure: "source_unavailable" | "rejected" | "needs_review" | "temporarily_unavailable" | null;
};
export type MediaSyncStatusPage = {
  from: string;
  until: string;
  counts: Record<MediaSyncStatus, number>;
  totalReceived: number;
  lastPublishedAt: string | null;
  items: MediaSyncStatusItem[];
  cursor?: string;
  hasMore: boolean;
};

const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/u.test(value) &&
  !value.startsWith("0000-") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseMediaSyncStatusQuery(
  value: unknown,
  collectionId: string,
  now = Date.now()
): MediaSyncStatusQuery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !["from", "until", "limit", "cursor"].includes(key)))
    return undefined;
  if (!instant(query.from) || !instant(query.until)) return undefined;
  const from = Date.parse(query.from),
    until = Date.parse(query.until);
  if (until <= from || until - from > 7 * 86400_000 || until > now + 60_000) return undefined;
  if (
    query.limit !== undefined &&
    (typeof query.limit !== "string" || !/^[1-9]\d?$/u.test(query.limit))
  )
    return undefined;
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (limit > 50) return undefined;
  let after: MediaSyncStatusQuery["after"];
  if (query.cursor !== undefined) {
    if (
      typeof query.cursor !== "string" ||
      query.cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/u.test(query.cursor)
    )
      return undefined;
    try {
      const data: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (
        !Array.isArray(data) ||
        data.length !== 5 ||
        data[0] !== collectionId ||
        data[1] !== query.from ||
        data[2] !== query.until ||
        !instant(data[3]) ||
        typeof data[4] !== "string" ||
        !uuid.test(data[4])
      )
        return undefined;
      if (Date.parse(data[3]) < from || Date.parse(data[3]) >= until) return undefined;
      after = { createdAt: data[3], workId: data[4] };
    } catch {
      return undefined;
    }
  }
  return { from: query.from, until: query.until, limit, ...(after ? { after } : {}) };
}

export function statusCursor(
  collectionId: string,
  query: MediaSyncStatusQuery,
  item: MediaSyncStatusItem
): string {
  return Buffer.from(
    JSON.stringify([collectionId, query.from, query.until, item.receivedAt, item.workId])
  ).toString("base64url");
}

import type { InFlightKey, InFlightStore } from "../../../in-flight/in-flight-store.js";
import type { FunctionName, JsonRecord, LineSource } from "../../../types.js";

export const IN_FLIGHT_TTL_MS = 120_000;

const IN_FLIGHT_FUNCTIONS = new Set<FunctionName>([
  "find_ppt_slides",
  "find_sheet_music",
  "query_schedule"
]);

export function buildInFlightKey(
  profileName: string,
  source: LineSource,
  action: FunctionName,
  args: JsonRecord
): { key: InFlightKey; queryHash: string } | undefined {
  if (!IN_FLIGHT_FUNCTIONS.has(action)) {
    return undefined;
  }
  const queryHash = hashDedupPayload(normalizeDedupPayload(args));
  return {
    queryHash,
    key: {
      profileName,
      sourceKey: turnSourceKey(source),
      action,
      queryHash
    }
  };
}

export async function releaseInFlight(store: InFlightStore, key: InFlightKey): Promise<void> {
  try {
    await store.release(key);
  } catch {
    // A failed cleanup should not turn a successful LINE reply into an error.
  }
}

function normalizeDedupPayload(args: JsonRecord): string {
  const query = typeof args.query === "string" ? args.query.normalize("NFKC").trim() : "";
  const fileType = typeof args.fileType === "string" ? args.fileType.trim().toLowerCase() : "";
  const dateIntent = typeof args.dateIntent === "string" ? args.dateIntent.trim() : "";
  const meeting = typeof args.meeting === "string" ? args.meeting.trim() : "";
  const role = typeof args.role === "string" ? args.role.trim() : "";
  return JSON.stringify({ query, fileType, dateIntent, meeting, role });
}

export function turnSourceKey(source: LineSource): string {
  switch (source.type) {
    case "group":
      return `group:${source.groupId ?? ""}`;
    case "room":
      return `room:${source.roomId ?? ""}`;
    case "user":
      return `user:${source.userId ?? ""}`;
    default:
      return `${source.type}:unknown`;
  }
}

function hashDedupPayload(payload: string): string {
  let hash = 0;
  for (let index = 0; index < payload.length; index += 1) {
    hash = Math.imul(31, hash) + payload.charCodeAt(index);
  }
  return Math.abs(hash).toString(16).slice(0, 16);
}

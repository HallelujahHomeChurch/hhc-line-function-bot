import { sanitizeActionTelemetryEvent } from "./action-telemetry.js";
import { createActorFingerprint } from "./opaque-identifiers.js";
import type { FunctionName, LineSource, RouteObserver } from "../types.js";

export const PRODUCT_EVENT_NAMES = [
  "registration_completed",
  "clarification_requested",
  "function_completed",
  "write_previewed",
  "write_committed",
  "retry_observed"
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];
export type ProductResultClass = "success" | "not_found" | "ambiguous" | "unavailable" | "error";

export interface ProductEventInput {
  eventName: ProductEventName;
  requestId: string;
  profileName: string;
  source: LineSource;
  hmacKey?: string;
  action?: FunctionName;
  resultClass?: ProductResultClass;
  durationMs?: number;
  clarificationCount?: number;
  retry?: boolean;
}

export async function emitProductEvent(
  observer: RouteObserver | undefined,
  input: ProductEventInput
): Promise<void> {
  if (!observer) return;
  const sourceType = normalizedSourceType(input.source.type);
  const actorFingerprint =
    input.hmacKey && sourceType
      ? createActorFingerprint(
          {
            profileName: input.profileName,
            sourceType,
            sourceId: sourceId(input.source),
            requesterUserId: input.source.userId
          },
          input.hmacKey
        )
      : undefined;
  const event = sanitizeActionTelemetryEvent({
    kind: "product_event",
    requestId: input.requestId,
    profileName: input.profileName,
    sourceType: input.source.type,
    eventName: input.eventName,
    actorFingerprint,
    action: input.action,
    resultClass: input.resultClass,
    latencyBucket: latencyBucket(input.durationMs),
    clarificationCountBucket: clarificationCountBucket(input.clarificationCount),
    retry: input.retry
  });
  try {
    await observer(event as never);
  } catch {
    // Observability must never change product behavior.
  }
}

function normalizedSourceType(value: string): "user" | "group" | "room" | undefined {
  return value === "user" || value === "group" || value === "room" ? value : undefined;
}

function sourceId(source: LineSource): string | undefined {
  if (source.type === "group") return source.groupId;
  if (source.type === "room") return source.roomId;
  return source.userId;
}

function latencyBucket(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) return undefined;
  if (durationMs < 100) return "under_100ms";
  if (durationMs < 500) return "under_500ms";
  if (durationMs < 2_000) return "under_2s";
  if (durationMs < 10_000) return "under_10s";
  return "over_10s";
}

function clarificationCountBucket(value: number | undefined): string | undefined {
  if (value === undefined || value < 0) return undefined;
  if (value === 0) return "zero";
  if (value === 1) return "one";
  return "multiple";
}

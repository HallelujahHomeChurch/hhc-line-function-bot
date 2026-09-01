export type MediaSyncTimingEvent =
  "webhook_received" | "upload_completed" | "clean_observed" | "collection_published";

export function logMediaSyncTiming(event: MediaSyncTimingEvent, correlationId: string): void {
  process.stdout.write(`${JSON.stringify({ event: `media_sync.${event}`, correlationId })}\n`);
}

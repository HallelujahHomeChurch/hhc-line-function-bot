export type MediaSyncTimingEvent =
  "webhook_received" | "upload_completed" | "clean_observed" | "collection_published";

export type MediaSyncTimingDimensions = {
  assetId?: string;
  collectionItemId?: string;
  contentVersion?: string;
  sizeBytes?: number;
};

export function logMediaSyncTiming(
  event: MediaSyncTimingEvent,
  correlationId: string,
  dimensions: MediaSyncTimingDimensions = {}
): void {
  process.stdout.write(
    `${JSON.stringify({ event: `media_sync.${event}`, correlationId, ...dimensions })}\n`
  );
}

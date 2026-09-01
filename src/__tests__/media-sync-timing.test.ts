import { afterEach, describe, expect, it, vi } from "vitest";

import { logMediaSyncTiming } from "../media-sync/timing.js";

afterEach(() => vi.restoreAllMocks());

describe("media sync timing logs", () => {
  it("writes only the stage and approved opaque correlation dimensions", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logMediaSyncTiming("upload_completed", "work-opaque-1", {
      assetId: "asset-opaque-1",
      collectionItemId: "item-opaque-1",
      contentVersion: "etag-opaque-1",
      sizeBytes: 25_000_000
    });

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      event: "media_sync.upload_completed",
      correlationId: "work-opaque-1",
      assetId: "asset-opaque-1",
      collectionItemId: "item-opaque-1",
      contentVersion: "etag-opaque-1",
      sizeBytes: 25_000_000
    });
  });
});

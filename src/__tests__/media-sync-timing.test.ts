import { afterEach, describe, expect, it, vi } from "vitest";

import { logMediaSyncTiming } from "../media-sync/timing.js";

afterEach(() => vi.restoreAllMocks());

describe("media sync timing logs", () => {
  it("writes only the stage and opaque correlation ID", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logMediaSyncTiming("upload_completed", "work-opaque-1");

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      event: "media_sync.upload_completed",
      correlationId: "work-opaque-1"
    });
  });
});

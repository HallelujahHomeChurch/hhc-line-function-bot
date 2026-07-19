import { describe, expect, it, vi } from "vitest";

import { emitProductEvent } from "../observability/product-events.js";

describe("product events", () => {
  it("emits a privacy-safe bounded function completion", async () => {
    const observer = vi.fn();

    await emitProductEvent(observer, {
      eventName: "function_completed",
      requestId: "req-1",
      profileName: "helper",
      source: { type: "group", groupId: "C-private", userId: "U-private" },
      hmacKey: "0123456789abcdef0123456789abcdef",
      action: "find_ppt_slides",
      resultClass: "success",
      durationMs: 620,
      clarificationCount: 0,
      rawText: "牧師師母五十週年",
      title: "private.pptx"
    } as never);

    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product_event",
        eventName: "function_completed",
        supportId: expect.stringMatching(/^[a-f0-9]{16}$/u),
        actorFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/u),
        action: "find_ppt_slides",
        resultClass: "success",
        latencyBucket: "under_2s",
        clarificationCountBucket: "zero"
      })
    );
    expect(JSON.stringify(observer.mock.calls)).not.toMatch(
      /C-private|U-private|牧師|private\.pptx/u
    );
  });

  it("does not emit actor metrics when the requester or HMAC key is unavailable", async () => {
    const observer = vi.fn();

    await emitProductEvent(observer, {
      eventName: "clarification_requested",
      requestId: "req-2",
      profileName: "helper",
      source: { type: "group", groupId: "C-private" },
      action: "query_schedule"
    });

    expect(observer).toHaveBeenCalledWith(
      expect.not.objectContaining({ actorFingerprint: expect.anything() })
    );
  });
});

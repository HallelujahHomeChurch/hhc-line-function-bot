import { describe, expect, it, vi } from "vitest";

import { runWarmScheduler } from "../media-sync/warm-scheduler.js";

describe("runWarmScheduler", () => {
  it("sends a bounded pulse batch only inside the meeting window", async () => {
    const sendPulse = vi.fn().mockResolvedValue(undefined);
    await expect(
      runWarmScheduler({ isWarm: async () => true, sendPulse }, new Date("2026-09-06T01:00:00Z"))
    ).resolves.toEqual({ status: "pulsed" });
    expect(sendPulse).toHaveBeenCalledTimes(20);
    expect(sendPulse).toHaveBeenCalledWith({ ttlSeconds: 120 });

    sendPulse.mockClear();
    await expect(
      runWarmScheduler({ isWarm: async () => false, sendPulse }, new Date("2026-09-06T03:00:00Z"))
    ).resolves.toEqual({ status: "cold" });
    expect(sendPulse).not.toHaveBeenCalled();
  });

  it("fails without sending when the meeting API is unavailable", async () => {
    const sendPulse = vi.fn();
    await expect(
      runWarmScheduler({ isWarm: async () => Promise.reject(new Error("down")), sendPulse })
    ).rejects.toThrow("down");
    expect(sendPulse).not.toHaveBeenCalled();
  });
});

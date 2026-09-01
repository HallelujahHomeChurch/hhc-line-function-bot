import { describe, expect, it, vi } from "vitest";

import { MeetingWindowClient, meetingAccessTokenScope } from "../media-sync/meeting-client.js";

describe("MeetingWindowClient", () => {
  it("coalesces refreshes, caches for 60 seconds, and derives the 5/10 minute warm union", async () => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ startsAt: "2026-09-06T01:00:00.000Z", endsAt: "2026-09-06T02:00:00.000Z" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const client = new MeetingWindowClient({
      baseUrl: "https://meeting.internal",
      getAccessToken: async () => "token",
      fetcher
    });

    await expect(
      Promise.all([
        client.isWarm(new Date("2026-09-06T00:55:00.000Z")),
        client.isWarm(new Date("2026-09-06T00:55:00.000Z"))
      ])
    ).resolves.toEqual([true, true]);
    await client.isWarm(new Date("2026-09-06T00:55:59.999Z"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.isWarm(new Date("2026-09-06T00:56:00.000Z"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.isWarm(new Date("2026-09-06T02:10:00.000Z"))).resolves.toBe(true);
    await expect(client.isWarm(new Date("2026-09-06T02:10:00.001Z"))).resolves.toBe(false);
  });

  it("does not retain a failed refresh", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new MeetingWindowClient({
      baseUrl: "https://meeting.internal",
      getAccessToken: async () => "token",
      fetcher
    });
    await expect(client.isWarm(new Date("2026-09-06T01:00:00.000Z"))).rejects.toThrow(
      "unavailable"
    );
    await expect(client.isWarm(new Date("2026-09-06T01:00:01.000Z"))).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the managed identity application scope", () => {
    expect(meetingAccessTokenScope("api://meeting-app/")).toBe("api://meeting-app/.default");
  });
});

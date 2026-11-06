import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingOccurrenceReader } from "../clients/meeting-occurrences.js";

const item = {
  occurrenceId: "one",
  meetingKey: "sunday",
  meetingName: "主日",
  occurrenceDate: "2026-09-06",
  timezone: "Asia/Taipei",
  startsAt: "2026-09-06T09:00:00+08:00",
  endsAt: "2026-09-06T12:00:00+08:00",
  status: "scheduled"
};
afterEach(() => vi.useRealTimers());
describe("meeting occurrence reader", () => {
  it("uses the Operations private Dapr path and refreshes cancellation within a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [item] }))
      .mockResolvedValueOnce(Response.json({ data: [{ ...item, status: "cancelled" }] }));
    const read = createMeetingOccurrenceReader({
      baseUrl: "http://127.0.0.1:3500/v1.0/invoke/operations-api/method",
      fetcher
    });
    expect((await read(new Date()))[0].status).toBe("scheduled");
    await read(new Date());
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect((await read(new Date()))[0].status).toBe("cancelled");
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/method/priv/operations/meeting-occurrences?"
    );
  });
  it("rejects failed or incomplete responses instead of inventing meeting times", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ startsAt: item.startsAt }] }));
    const read = createMeetingOccurrenceReader({ baseUrl: "http://localhost", fetcher });
    await expect(read(new Date())).rejects.toThrow();
    await expect(read(new Date())).rejects.toThrow();
  });
  it("uses the exact Operations HTTPS route without fallback or redirects", async () => {
    const baseUrl = "https://operations-api.internal.fixture.region.azurecontainerapps.io";
    const privateToken = "a".repeat(64);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const read = createMeetingOccurrenceReader({ baseUrl, privateToken, fetcher });
    await expect(read(new Date("2026-09-05T00:00:00Z"))).rejects.toThrow(
      "meeting_occurrences_unavailable"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      baseUrl + "/priv/operations/meeting-occurrences?"
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { "x-hhc-operations-token": privateToken }
    });
    expect(() =>
      createMeetingOccurrenceReader({ baseUrl: "https://example.test", privateToken })
    ).toThrow("meeting_occurrences_https_config_invalid");
  });
});

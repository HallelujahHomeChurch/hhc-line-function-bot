import { describe, expect, it } from "vitest";

import { selectFirstUpcomingOccurrence } from "../schedules/occurrence-policy.js";

describe("schedule occurrence policy", () => {
  it("chooses the earliest future date before comparing meeting names or known windows", () => {
    const result = selectFirstUpcomingOccurrence({
      occurrences: [],
      rows: [
        { serviceDate: "2026-07-16", meeting: "仙履奇緣", assignee: "later" },
        { serviceDate: "2026-07-15", meeting: "臨時聚會", assignee: "earlier" }
      ],
      now: new Date("2026-07-14T08:40:00.000Z"),
      timeZone: "Asia/Taipei"
    });

    expect(result).toEqual([
      { serviceDate: "2026-07-15", meeting: "臨時聚會", assignee: "earlier" }
    ]);
  });
});

describe("canonical meeting changes", () => {
  const row = { serviceDate: "2026-09-06", meeting: "主日", assignee: "team" };
  const occurrence = {
    occurrenceId: "one",
    meetingKey: "sunday",
    meetingName: "主日",
    occurrenceDate: "2026-09-06",
    timezone: "Asia/Taipei",
    startsAt: "2026-09-08T09:00:00+08:00",
    endsAt: "2026-09-08T12:00:00+08:00",
    status: "scheduled" as const
  };
  it("keeps a moved occurrence available after its original date", () => {
    expect(
      selectFirstUpcomingOccurrence({
        rows: [row],
        now: new Date("2026-09-07T00:00:00Z"),
        timeZone: "Asia/Taipei",
        occurrences: [occurrence]
      })
    ).toEqual([{ ...row, serviceDate: "2026-09-08" }]);
  });
  it("does not infer a missing or cancelled recurring meeting from a future roster date", () => {
    const input = { rows: [row], now: new Date("2026-09-05T00:00:00Z"), timeZone: "Asia/Taipei" };
    expect(selectFirstUpcomingOccurrence({ ...input, occurrences: [] })).toEqual([]);
    expect(
      selectFirstUpcomingOccurrence({
        ...input,
        occurrences: [{ ...occurrence, status: "cancelled" }]
      })
    ).toEqual([]);
  });
});

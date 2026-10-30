import { readTimeZone } from "../time-zone.js";
export function historyTimeRange(
  period: "recent" | "yesterday" | "last_week",
  now: Date,
  timeZone: string
) {
  readTimeZone(timeZone);
  if (period === "recent")
    return { start: new Date(now.getTime() - 1800000).toISOString(), end: now.toISOString() };
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const today = new Date(`${date}T00:00:00Z`);
  const shift = period === "yesterday" ? -1 : -((today.getUTCDay() + 6) % 7) - 7;
  const startDate = new Date(today.getTime() + shift * 86400000);
  const endDate = new Date(startDate.getTime() + (period === "yesterday" ? 1 : 7) * 86400000);
  const midnight = (day: Date) => {
    let instant = day.getTime();
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(new Date(instant));
      const value = (type: string) => parts.find((p) => p.type === type)!.value;
      const local = Date.parse(
        `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}Z`
      );
      instant += day.getTime() - local;
    }
    return new Date(instant).toISOString();
  };
  return { start: midnight(startDate), end: midnight(endDate) };
}

import type { ReadMeetingOccurrences, MeetingOccurrence } from "../clients/meeting-occurrences.js";

// Fixed upstream calendar fixture for handler tests; production never imports this module.
export const readTestMeetingOccurrences: ReadMeetingOccurrences = async (now) => {
  const rules = [
    ["morning-prayer", "晨更", [2, 5], "06:30", "08:30"],
    ["cinderella", "仙履奇緣", [4], "06:30", "09:00"],
    ["gospel-meal", "福音餐會", [4], "12:00", "14:00"],
    ["discipleship-prayer", "門訓禱告會", [5], "19:00", "21:30"],
    ["kingdom-prayer", "國度禱告會", [6], "09:00", "11:30"],
    ["sunday", "主日", [0], "09:00", "12:00"]
  ] as const;
  const items: MeetingOccurrence[] = [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(now);
  for (let day = 0; day < 90; day++) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + day * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    for (const [meetingKey, meetingName, weekdays, start, end] of rules) {
      if (!(weekdays as readonly number[]).includes(date.getUTCDay())) continue;
      items.push({
        occurrenceId: `${meetingKey}-${key}`,
        meetingKey,
        meetingName,
        occurrenceDate: key,
        timezone: "Asia/Taipei",
        startsAt: `${key}T${start}:00+08:00`,
        endsAt: `${key}T${end}:00+08:00`,
        status: "scheduled"
      });
    }
  }
  return items;
};

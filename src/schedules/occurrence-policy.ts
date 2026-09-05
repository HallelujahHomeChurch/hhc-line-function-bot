import type { MeetingOccurrence } from "../clients/meeting-occurrences.js";
import type { MeetingReference } from "../types.js";

export const DEFAULT_MEETING_REFERENCES: MeetingReference[] = [
  { key: "morning-prayer", aliases: ["晨更"] },
  { key: "cinderella", aliases: ["仙履奇緣"] },
  { key: "gospel-meal", aliases: ["福音餐會"] },
  { key: "discipleship-prayer", aliases: ["門訓禱告會"] },
  { key: "kingdom-prayer", aliases: ["國度禱告會"] },
  { key: "sunday", aliases: ["主日"] }
];

export interface ScheduleOccurrenceRow {
  serviceDate: string;
  meeting: string;
}

export function selectFirstUpcomingOccurrence<T extends ScheduleOccurrenceRow>(input: {
  rows: T[];
  now: Date;
  timeZone: string;
  meetingReferences?: MeetingReference[];
  occurrences: MeetingOccurrence[];
}): T[] {
  const groups = groupRows(input.rows);
  const today = dateKey(input.now, input.timeZone);
  const first = groups
    .map((group) => ({
      group,
      window: occurrenceWindow(
        group,
        input.meetingReferences ?? DEFAULT_MEETING_REFERENCES,
        input.occurrences
      )
    }))
    .filter(({ group, window }) => {
      const reference = (input.meetingReferences ?? DEFAULT_MEETING_REFERENCES).find((rule) =>
        rule.aliases.some((alias) => group.meeting.includes(alias))
      );
      if (reference) return Boolean(window && window.end > input.now);
      if (group.serviceDate > today) return true;
      if (group.serviceDate < today) return false;
      return Boolean(window && window.end > input.now);
    })
    .sort((left, right) => {
      const leftDate =
        (left.window ? dateKey(left.window.start, input.timeZone) : undefined) ??
        left.group.serviceDate;
      const rightDate =
        (right.window ? dateKey(right.window.start, input.timeZone) : undefined) ??
        right.group.serviceDate;
      const dateOrder = leftDate.localeCompare(rightDate);
      if (dateOrder !== 0) return dateOrder;
      const leftTime = left.window?.start.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.window?.start.getTime() ?? Number.MAX_SAFE_INTEGER;
      return (
        leftTime - rightTime || left.group.meeting.localeCompare(right.group.meeting, "zh-Hant")
      );
    })[0];
  if (!first) return [];
  const resolvedDate = first.window?.resolvedDate;
  return resolvedDate && resolvedDate !== first.group.serviceDate
    ? first.group.rows.map((row) => ({
        ...row,
        serviceDate: resolvedDate,
        meeting: first.window?.meetingName ?? row.meeting
      }))
    : first.group.rows;
}

interface ScheduleOccurrenceGroup<T> {
  serviceDate: string;
  meeting: string;
  rows: T[];
}

function groupRows<T extends ScheduleOccurrenceRow>(rows: T[]): Array<ScheduleOccurrenceGroup<T>> {
  const groups = new Map<string, ScheduleOccurrenceGroup<T>>();
  for (const row of rows) {
    const serviceDate = row.serviceDate.match(/\d{4}-\d{2}-\d{2}/u)?.[0] ?? row.serviceDate;
    const key = `${serviceDate}\u0000${row.meeting}`;
    const group = groups.get(key) ?? { serviceDate, meeting: row.meeting, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function occurrenceWindow<T>(
  group: ScheduleOccurrenceGroup<T>,
  rules: MeetingReference[],
  occurrences: MeetingOccurrence[]
): { start: Date; end: Date; resolvedDate?: string; meetingName?: string } | undefined {
  const reference = rules.find((candidate) =>
    candidate.aliases.some((alias) => group.meeting.includes(alias))
  );
  if (!reference)
    return parseExplicitWindow(
      (group.rows[0] as ScheduleOccurrenceRow | undefined)?.serviceDate ?? ""
    );
  const occurrence = occurrences.find(
    (item) =>
      item.meetingKey === reference.key &&
      item.occurrenceDate === group.serviceDate &&
      item.status === "scheduled"
  );
  return occurrence
    ? {
        start: new Date(occurrence.startsAt),
        end: new Date(occurrence.endsAt),
        resolvedDate: dateKey(new Date(occurrence.startsAt), occurrence.timezone),
        meetingName: occurrence.meetingName
      }
    : undefined;
}

function parseExplicitWindow(value: string): { start: Date; end: Date } | undefined {
  const values = value.match(/\d{4}-\d{2}-\d{2}T[^\s~]+/gu);
  if (!values?.length) return undefined;
  const start = new Date(values[0]);
  const last = new Date(values.at(-1) ?? values[0]);
  if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime())) return undefined;
  return {
    start,
    end: values.length > 1 ? last : new Date(start.getTime() + 3 * 60 * 60 * 1000)
  };
}

function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function includeMovedOccurrenceDates(
  range: { start: string; endExclusive: string } | undefined,
  occurrences: MeetingOccurrence[],
  now: Date
): { start: string; endExclusive: string } | undefined {
  if (!range) return range;
  const originalDates = occurrences
    .filter((item) => item.status === "scheduled" && Date.parse(item.endsAt) > now.getTime())
    .map((item) => item.occurrenceDate);
  return { ...range, start: [range.start, ...originalDates].sort()[0] };
}

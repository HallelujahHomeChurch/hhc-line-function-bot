import { z } from "zod";

const occurrenceSchema = z
  .object({
    occurrenceId: z.string().min(1),
    meetingKey: z.string().min(1),
    meetingName: z.string().min(1),
    occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    timezone: z.string().min(1),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    status: z.enum(["scheduled", "cancelled"])
  })
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt));
const envelopeSchema = z.object({ data: z.array(occurrenceSchema) });
export type MeetingOccurrence = z.infer<typeof occurrenceSchema>;
export type ReadMeetingOccurrences = (now: Date) => Promise<MeetingOccurrence[]>;

export function createMeetingOccurrenceReader(options: {
  baseUrl: string;
  fetcher?: typeof fetch;
}): ReadMeetingOccurrences {
  let cache: { from: string; refreshedAt: number; items: MeetingOccurrence[] } | undefined;
  return async (now) => {
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    const fromKey = from.toISOString();
    const age = Date.now() - (cache?.refreshedAt ?? 0);
    if (cache?.from === fromKey && age >= 0 && age < 60_000) return cache.items;
    const to = new Date(from.getTime() + 90 * 86_400_000);
    const query = new URLSearchParams({ from: fromKey, to: to.toISOString() });
    const response = await (options.fetcher ?? fetch)(
      `${options.baseUrl.replace(/\/$/u, "")}/priv/meeting-occurrences?${query}`,
      { signal: AbortSignal.timeout(3_000) }
    );
    if (!response.ok) throw new Error("meeting_occurrences_unavailable");
    const items = envelopeSchema.parse(await response.json()).data;
    cache = { from: fromKey, refreshedAt: Date.now(), items };
    return items;
  };
}

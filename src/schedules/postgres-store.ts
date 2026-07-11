import { randomUUID } from "node:crypto";

import {
  normalizeScheduleText,
  scheduleItemIdentity,
  searchableScheduleText,
  stripGenericScheduleWords,
  type ScheduleItemInput,
  type ScheduleItemRecord,
  type ScheduleOrigin,
  type ScheduleSearchInput,
  type ScheduleStore
} from "./store.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

type ScheduleItemRow = {
  id: string;
  profile_name: string;
  source_key: string;
  origin: ScheduleOrigin;
  external_id: string | null;
  service_date: Date | string;
  meeting: string;
  role: string;
  assignee: string;
  notes: string | null;
  normalized_search_text: string;
  external_updated_at: Date | string | null;
  deleted_at: Date | string | null;
};

export class PostgresScheduleStore implements ScheduleStore {
  constructor(private readonly db: PgQueryable) {}

  async upsertItem(input: ScheduleItemInput): Promise<ScheduleItemRecord> {
    const normalizedSearchText = searchableScheduleText(input);
    const result = await this.db.query<ScheduleItemRow>(
      `
      insert into schedule_items
        (id, profile_name, source_key, origin, external_id, service_date, meeting, role,
         assignee, notes, normalized_search_text, schedule_identity, external_updated_at,
         deleted_at, updated_at)
      values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, now())
      on conflict (profile_name, source_key, schedule_identity) do update
      set origin = excluded.origin,
          external_id = excluded.external_id,
          service_date = excluded.service_date,
          meeting = excluded.meeting,
          role = excluded.role,
          assignee = excluded.assignee,
          notes = excluded.notes,
          normalized_search_text = excluded.normalized_search_text,
          external_updated_at = excluded.external_updated_at,
          deleted_at = excluded.deleted_at,
          updated_at = now()
      returning *
      `,
      [
        randomUUID(),
        input.profileName,
        input.sourceKey,
        input.origin,
        input.externalId ?? null,
        input.serviceDate,
        input.meeting,
        input.role,
        input.assignee,
        input.notes ?? null,
        normalizedSearchText,
        scheduleItemIdentity(input),
        input.externalUpdatedAt ?? null,
        input.deletedAt ?? null
      ]
    );
    return mapRow(result.rows[0]);
  }

  async tombstoneMissingExternalIds(input: {
    profileName: string;
    sourceKey: string;
    origin: ScheduleOrigin;
    liveExternalIds: string[];
    deletedAt: string;
  }): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `
      update schedule_items
      set deleted_at = $5,
          updated_at = now()
      where profile_name = $1
        and source_key = $2
        and origin = $3
        and external_id is not null
        and deleted_at is null
        and not (external_id = any($4::text[]))
      returning id
      `,
      [input.profileName, input.sourceKey, input.origin, input.liveExternalIds, input.deletedAt]
    );
    return result.rows.length;
  }

  async searchItems(input: ScheduleSearchInput): Promise<ScheduleItemRecord[]> {
    const values: unknown[] = [input.profileName];
    const conditions = ["profile_name = $1", "deleted_at is null"];

    if (input.sourceKeys?.length) {
      values.push(input.sourceKeys);
      conditions.push(`source_key = any($${values.length}::text[])`);
    }
    if (input.serviceDate) {
      values.push(input.serviceDate);
      conditions.push(`service_date = $${values.length}::date`);
    }
    if (input.range) {
      values.push(input.range.start, input.range.endExclusive);
      conditions.push(
        `service_date >= $${values.length - 1}::date and service_date < $${values.length}::date`
      );
    }
    if (input.meeting?.trim()) {
      values.push(`%${input.meeting.trim().toLowerCase()}%`);
      conditions.push(`lower(meeting) like $${values.length}`);
    }
    if (input.role?.trim()) {
      values.push(`%${input.role.trim().toLowerCase()}%`);
      conditions.push(`lower(role) like $${values.length}`);
    }
    const query = normalizeScheduleText(stripGenericScheduleWords(input.query ?? ""));
    if (query) {
      values.push(`%${query}%`);
      conditions.push(`normalized_search_text like $${values.length}`);
    }
    values.push(input.limit ?? 10);

    const result = await this.db.query<ScheduleItemRow>(
      `
      select *
      from schedule_items
      where ${conditions.join("\n        and ")}
      order by service_date asc, meeting asc, role asc, assignee asc
      limit $${values.length}
      `,
      values
    );
    return result.rows.map(mapRow);
  }
}

function mapRow(row: ScheduleItemRow): ScheduleItemRecord {
  return {
    id: row.id,
    profileName: row.profile_name,
    sourceKey: row.source_key,
    origin: row.origin,
    externalId: row.external_id ?? undefined,
    serviceDate: dateKey(row.service_date),
    meeting: row.meeting,
    role: row.role,
    assignee: row.assignee,
    notes: row.notes ?? undefined,
    normalizedSearchText: row.normalized_search_text,
    externalUpdatedAt: row.external_updated_at
      ? new Date(row.external_updated_at).toISOString()
      : undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : undefined
  };
}

function dateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

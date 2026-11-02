import type { Pool } from "pg";
import {
  searchSettingsInput,
  type SearchSettings,
  type SearchSettingsChange,
  type SearchSettingsInput,
  type SearchSettingsStore
} from "./contracts.js";

type Row = {
  enabled: boolean;
  direct_daily_limit: number;
  group_daily_limit: number;
  revision: number;
  updated_at: Date;
  updated_by: string | null;
};
const project = (row: Row): SearchSettings => ({
  enabled: row.enabled,
  directDailyLimit: row.direct_daily_limit,
  groupDailyLimit: row.group_daily_limit,
  revision: row.revision,
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by
});
export class PostgresSearchSettingsStore implements SearchSettingsStore {
  constructor(private readonly db: Pick<Pool, "query">) {}
  async setup(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS helper_search_settings (
        profile text PRIMARY KEY CHECK (profile = 'helper'),
        enabled boolean NOT NULL DEFAULT true,
        direct_daily_limit integer NOT NULL DEFAULT 60 CHECK (direct_daily_limit BETWEEN 0 AND 10000),
        group_daily_limit integer NOT NULL DEFAULT 300 CHECK (group_daily_limit BETWEEN 0 AND 10000),
        revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
      );
      CREATE TABLE IF NOT EXISTS helper_search_settings_audit (
        revision integer PRIMARY KEY, changed_at timestamptz NOT NULL DEFAULT now(),
        changed_by uuid NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL
      );
      INSERT INTO helper_search_settings (profile) VALUES ('helper') ON CONFLICT DO NOTHING;
    `);
  }
  async get(): Promise<SearchSettings> {
    const { rows } = await this.db.query<Row>(
      "SELECT * FROM helper_search_settings WHERE profile = 'helper'"
    );
    if (!rows[0]) throw new Error("search_settings_unavailable");
    return project(rows[0]);
  }
  async history(): Promise<SearchSettingsChange[]> {
    const { rows } = await this.db.query<{
      revision: number;
      changed_at: Date;
      changed_by: string;
      before_value: SearchSettingsInput;
      after_value: SearchSettingsInput;
    }>("SELECT * FROM helper_search_settings_audit ORDER BY revision DESC LIMIT 50");
    return rows.map((row) => ({
      revision: row.revision,
      changedAt: row.changed_at.toISOString(),
      changedBy: row.changed_by,
      before: row.before_value,
      after: row.after_value
    }));
  }
  async update(input: SearchSettingsInput, actor: string): Promise<SearchSettings | undefined> {
    const value = searchSettingsInput.parse(input);
    // The revision CAS and its audit are one SQL transaction; neither can commit alone.
    const { rows } = await this.db.query<Row>(
      `
      WITH prior AS MATERIALIZED (
        SELECT * FROM helper_search_settings WHERE profile = 'helper' AND revision = $1 FOR UPDATE
      ), changed AS (
        UPDATE helper_search_settings s SET enabled = $2, direct_daily_limit = $3,
          group_daily_limit = $4, revision = s.revision + 1, updated_by = $5, updated_at = now()
        FROM prior WHERE s.profile = prior.profile AND s.revision = prior.revision RETURNING s.*
      ), logged AS (
        INSERT INTO helper_search_settings_audit (revision, changed_by, before_value, after_value)
        SELECT changed.revision, $5,
          jsonb_build_object('enabled', prior.enabled, 'directDailyLimit', prior.direct_daily_limit, 'groupDailyLimit', prior.group_daily_limit, 'revision', prior.revision),
          jsonb_build_object('enabled', changed.enabled, 'directDailyLimit', changed.direct_daily_limit, 'groupDailyLimit', changed.group_daily_limit, 'revision', changed.revision)
        FROM changed, prior RETURNING revision
      ) SELECT changed.* FROM changed JOIN logged USING (revision)
    `,
      [value.revision, value.enabled, value.directDailyLimit, value.groupDailyLimit, actor]
    );
    return rows[0] ? project(rows[0]) : undefined;
  }
}

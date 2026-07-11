import { runScheduleMigrations } from "./migrations.js";
import { PostgresScheduleStore, type PgQueryable } from "./postgres-store.js";
import { InMemoryScheduleStore, type ScheduleStore } from "./store.js";

export interface CreateScheduleStoreOptions {
  db?: PgQueryable;
}

export async function createScheduleStore(
  options: CreateScheduleStoreOptions
): Promise<ScheduleStore> {
  if (!options.db) {
    return new InMemoryScheduleStore();
  }
  await runScheduleMigrations(options.db);
  return new PostgresScheduleStore(options.db);
}

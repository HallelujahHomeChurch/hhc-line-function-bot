import type { AgentMemoryStore } from "../../agent/memory-store.js";
import type { NotionDatabaseClient } from "../../types.js";
import type { ScheduleStore } from "../../schedules/store.js";
import type { SessionStore } from "../../state/session-store.js";

export interface QueryScheduleDependencies {
  memoryStore: AgentMemoryStore;
  scheduleStore?: ScheduleStore;
  notion?: NotionDatabaseClient;
  databaseId?: string;
  properties?: {
    date: string;
    meeting: string;
    role: string;
    person: string;
  };
  timeZone?: string;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

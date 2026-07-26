import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { MemoryCacheStore } from "../cache/cache-store.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { InMemoryKnowledgeStore } from "../knowledge/store.js";
import { InMemoryFirstSuccessStore } from "../observability/first-success-store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";
import { InMemorySessionStore } from "../state/session-store.js";

export function createTestRuntime() {
  return {
    kind: "test" as const,
    stores: {
      session: new InMemorySessionStore(),
      cache: new MemoryCacheStore(),
      memory: new InMemoryAgentMemoryStore(),
      catalog: new InMemoryCatalogStore(),
      knowledge: new InMemoryKnowledgeStore(),
      schedule: new InMemoryScheduleStore(),
      firstSuccess: new InMemoryFirstSuccessStore()
    }
  };
}

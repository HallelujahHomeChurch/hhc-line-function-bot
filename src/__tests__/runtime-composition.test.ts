import { describe, expect, it } from "vitest";

import {
  assertProductionPersistence,
  type ProductionRuntimeConfig
} from "../bootstrap/runtime-contracts.js";
import { createFunctionRegistries } from "../functions/registry.js";
import { createTestRuntime } from "../testing/create-test-runtime.js";
import type { AppConfig } from "../types.js";

describe("runtime composition", () => {
  it("fails closed when production persistence adapters are not configured", () => {
    const config = {
      redis: undefined,
      database: undefined
    } as ProductionRuntimeConfig;

    expect(() => assertProductionPersistence(config)).toThrow(
      "Production runtime requires DATABASE_URL and REDIS_URL"
    );
  });

  it("makes in-memory test construction explicit", () => {
    const runtime = createTestRuntime();

    expect(runtime.kind).toBe("test");
    expect(runtime.stores.session.constructor.name).toBe("InMemorySessionStore");
    expect(runtime.stores.cache.constructor.name).toBe("MemoryCacheStore");
    expect(runtime.stores.memory.constructor.name).toBe("InMemoryAgentMemoryStore");
    expect(runtime.stores.catalog.constructor.name).toBe("InMemoryCatalogStore");
    expect(runtime.stores.knowledge.constructor.name).toBe("InMemoryKnowledgeStore");
    expect(runtime.stores.schedule.constructor.name).toBe("InMemoryScheduleStore");
  });

  it("does not let production registry construction invent missing stores", () => {
    expect(() => createFunctionRegistries({} as AppConfig, {} as never)).toThrow(
      "Function registry requires explicitly constructed stores"
    );
  });
});

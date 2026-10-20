import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../types.js";

import type * as AccessStoreModule from "../access/create-access-store.js";

import type * as AgentMemoryModule from "../agent/create-agent-memory-store.js";

import type * as CatalogModule from "../catalog/create-catalog-store.js";

import type * as KnowledgeModule from "../knowledge/create-store.js";

import type * as ScheduleModule from "../schedules/create-schedule-store.js";

const mocks = vi.hoisted(() => ({
  appClose: vi.fn(),
  redisClose: vi.fn(),
  pgEnd: vi.fn(),
  stopMedia: vi.fn()
}));
vi.mock("../redis.js", () => ({
  createRedisRuntime: async () => ({ client: {}, keyPrefix: "test", close: mocks.redisClose })
}));
vi.mock("../db/postgres.js", () => ({
  createPostgresRuntime: async () => ({ pool: { end: mocks.pgEnd }, mediaSyncStore: {} }),
  createPostgresPool: vi.fn()
}));
vi.mock("../server.js", () => ({ createApp: () => ({ close: mocks.appClose }) }));
vi.mock("../attachments/scan-queue.js", () => ({
  createAzureAttachmentScanQueue: () => ({ enqueue: vi.fn() })
}));
vi.mock("../attachments/scan-outbox.js", () => ({
  startMediaSyncOutboxDispatcher: () => mocks.stopMedia,
  startAttachmentScanOutboxDispatcher: () => () => undefined
}));
vi.mock("../bootstrap/compose-capabilities.js", () => ({
  composeCapabilities: () => ({
    functions: {},
    postbacks: {},
    textMessages: {},
    attachmentTextHandlers: {},
    adminHandlers: {}
  })
}));
vi.mock("../access/create-access-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AccessStoreModule>();
  return { ...actual, createAccessStore: () => actual.createAccessStore({}) };
});
vi.mock("../agent/create-agent-memory-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentMemoryModule>();
  return { ...actual, createAgentMemoryStore: () => actual.createAgentMemoryStore({}) };
});
vi.mock("../catalog/create-catalog-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return { ...actual, createCatalogStore: () => actual.createCatalogStore({}) };
});
vi.mock("../knowledge/create-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KnowledgeModule>();
  return { ...actual, createKnowledgeStore: () => actual.createKnowledgeStore({}) };
});
vi.mock("../schedules/create-schedule-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScheduleModule>();
  return { ...actual, createScheduleStore: () => actual.createScheduleStore({}) };
});
import { createProductionRuntime } from "../bootstrap/create-production-runtime.js";

const config = {
  profiles: [],
  database: { url: "postgres://fixture.invalid/test", ssl: false },
  redis: { url: "redis://fixture.invalid", keyPrefix: "test" },
  llm: {
    deepseekBaseUrl: "https://provider.invalid",
    deepseekModel: "fixture",
    deepseekTimeoutMs: 1000
  },
  attachments: { scanQueueUrl: "https://queue.invalid/test" }
} as AppConfig;

describe("production media dispatcher close ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.appClose.mockResolvedValue(undefined);
    mocks.redisClose.mockResolvedValue(undefined);
    mocks.pgEnd.mockResolvedValue(undefined);
    mocks.stopMedia.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    "starts HTTP close but waits for active media flush before resources (HTTP fails=%s)",
    async (fails) => {
      const media = Promise.withResolvers<void>();
      mocks.stopMedia.mockReturnValue(media.promise);
      const error = new Error("http_close_failed");
      if (fails) mocks.appClose.mockRejectedValue(error);
      const runtime = await createProductionRuntime(config);
      const closing = runtime.close().then(
        () => undefined,
        (value) => value
      );
      await vi.advanceTimersByTimeAsync(0);
      const httpStarted = mocks.appClose.mock.calls.length;
      const redisEarly = mocks.redisClose.mock.calls.length;
      const pgEarly = mocks.pgEnd.mock.calls.length;
      media.resolve();
      expect(await closing).toBe(fails ? error : undefined);
      expect(httpStarted).toBe(1);
      expect(redisEarly).toBe(0);
      expect(pgEarly).toBe(0);
      expect(mocks.stopMedia).toHaveBeenCalledOnce();
      expect(mocks.redisClose).toHaveBeenCalledOnce();
      expect(mocks.pgEnd).toHaveBeenCalledOnce();
    }
  );

  it("still closes PG if Redis close fails after media join", async () => {
    const error = new Error("redis_close_failed");
    mocks.redisClose.mockRejectedValue(error);
    const runtime = await createProductionRuntime(config);
    await expect(runtime.close()).rejects.toBe(error);
    expect(mocks.pgEnd).toHaveBeenCalledOnce();
  });
});

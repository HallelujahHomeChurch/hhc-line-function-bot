import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MediaSyncWorkerModule from "../media-sync/worker.js";

const mocks = vi.hoisted(() => ({
  createAssetApiClient: vi.fn(),
  createPostgresRuntime: vi.fn(),
  createRedisRuntime: vi.fn(),
  isWarm: vi.fn(),
  startOutbox: vi.fn(),
  stopOutbox: vi.fn(),
  complete: vi.fn(),
  postgresEnd: vi.fn(),
  receiveMessages: vi.fn(),
  redisQuit: vi.fn(),
  runMediaSyncWorker: vi.fn()
}));

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class ManagedIdentityCredential {}
}));
vi.mock("@azure/storage-queue", () => ({
  QueueClient: class QueueClient {
    receiveMessages(options: unknown) {
      return mocks.receiveMessages(options);
    }
    deleteMessage(...args: unknown[]) {
      return mocks.complete(...args);
    }
  }
}));
vi.mock("../agent/jobs.js", () => ({ RedisAgentJobStore: class RedisAgentJobStore {} }));
vi.mock("../attachments/asset-worker.js", () => ({ runAttachmentAssetWorker: vi.fn() }));
vi.mock("../attachments/scan-work-store.js", () => ({
  RedisAttachmentScanWorkStore: class RedisAttachmentScanWorkStore {}
}));
vi.mock("../attachments/scan-worker-config.js", () => ({
  loadAttachmentScanWorkerConfigFromEnv: () => ({
    attachments: {
      maxBytes: 25 * 1024 * 1024,
      lineDownloadTimeoutMs: 30_000
    },
    database: {},
    externalResources: {
      downloadTimeoutMs: 30_000,
      maxRedirects: 3
    },
    graph: {},
    mediaSyncMaxBytes: 200 * 1024 * 1024,
    profiles: [],
    redis: {}
  })
}));
vi.mock("../catalog/create-catalog-store.js", () => ({
  createCatalogStore: vi.fn().mockResolvedValue({})
}));
vi.mock("../catalog/source-seeds.js", () => ({
  buildCatalogSourceSeedsForProfiles: vi.fn().mockReturnValue([]),
  seedCatalogSources: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../clients/asset-api.js", () => ({
  assetAccessTokenScope: (audience: string) => `${audience}/.default`,
  createAssetApiClient: mocks.createAssetApiClient
}));
vi.mock("../clients/external-binary.js", () => ({
  createExternalBinaryClient: vi.fn().mockReturnValue({})
}));
vi.mock("../clients/graph.js", () => ({ createGraphDriveClient: vi.fn().mockReturnValue({}) }));
vi.mock("../clients/line.js", () => ({ createLineSdkContentClient: vi.fn().mockReturnValue({}) }));
vi.mock("../db/postgres.js", () => ({
  createPostgresRuntime: mocks.createPostgresRuntime
}));
vi.mock("../functions/resource-binary-publisher.js", () => ({
  createResourceBinaryPublisher: vi.fn().mockReturnValue({})
}));
vi.mock("../media-sync/worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MediaSyncWorkerModule>()),
  runMediaSyncWorker: mocks.runMediaSyncWorker
}));
vi.mock("../redis.js", () => ({
  createRedisRuntime: mocks.createRedisRuntime
}));
vi.mock("../attachments/scan-outbox.js", () => ({
  startWarmMediaSyncOutboxDispatcher: mocks.startOutbox
}));
vi.mock("../media-sync/meeting-client.js", () => ({
  meetingAccessTokenScope: (audience: string) => `${audience}/.default`,
  MeetingWindowClient: class MeetingWindowClient {
    isWarm = mocks.isWarm;
  }
}));
import { runAttachmentWorker, runAttachmentWorkerLoop } from "../tools/run-attachment-worker.js";

describe("attachment asset job lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createRedisRuntime.mockResolvedValue({
      client: { quit: mocks.redisQuit },
      keyPrefix: "test"
    });
    mocks.runMediaSyncWorker.mockResolvedValue({ status: "completed" });
    mocks.createPostgresRuntime.mockResolvedValue({
      mediaSyncStore: {},
      pool: { end: mocks.postgresEnd }
    });
    mocks.isWarm.mockResolvedValue(false);
    mocks.startOutbox.mockReturnValue(mocks.stopOutbox);
    mocks.stopOutbox.mockResolvedValue(undefined);
    mocks.createAssetApiClient.mockReturnValue({});
    mocks.complete.mockResolvedValue(undefined);
    mocks.postgresEnd.mockResolvedValue(undefined);
    mocks.receiveMessages.mockResolvedValue({
      receivedMessageItems: [
        {
          messageText: JSON.stringify({
            kind: "media-sync",
            workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
          }),
          messageId: "opaque-message",
          popReceipt: "opaque-receipt"
        }
      ]
    });
    mocks.redisQuit.mockResolvedValue(undefined);
  });

  it("keeps Redis and PostgreSQL open until media work and its ACK settle", async () => {
    let resolveWorker!: (result: { status: "completed" }) => void;
    mocks.runMediaSyncWorker.mockReturnValue(
      new Promise((resolve) => {
        resolveWorker = resolve;
      })
    );

    const running = runAttachmentWorker({
      ASSET_API_AUDIENCE: "api://asset-api",
      ASSET_API_URL: "https://asset-api.internal.example",
      ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/media-sync",
      AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
    });
    await vi.waitFor(() => expect(mocks.runMediaSyncWorker).toHaveBeenCalledTimes(1));

    expect(mocks.redisQuit).not.toHaveBeenCalled();
    expect(mocks.postgresEnd).not.toHaveBeenCalled();

    resolveWorker({ status: "completed" });

    await expect(running).resolves.toEqual({ exitCode: 0, status: { status: "completed" } });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
    expect(mocks.postgresEnd).toHaveBeenCalledTimes(1);
  });

  it("emits only safe Asset rejection telemetry", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.createAssetApiClient.mockImplementation((options) => {
      options.onRejection({
        operationStage: "create_upload",
        httpStatus: 403,
        category: "authorization_rejected"
      });
      return {};
    });

    await runAttachmentWorker({
      ASSET_API_AUDIENCE: "api://asset-api",
      ASSET_API_URL: "https://tenant-private.example/blob-key-private",
      ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/media-private-id",
      AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
    });

    const serialized = write.mock.calls.map(([value]) => String(value)).join("");
    expect(JSON.parse(serialized)).toEqual({
      operationStage: "create_upload",
      httpStatus: 403,
      category: "authorization_rejected"
    });
    for (const fixture of ["tenant-private", "blob-key-private", "media-private-id"]) {
      expect(serialized).not.toContain(fixture);
    }
    write.mockRestore();
  });
  const env = {
    ASSET_API_AUDIENCE: "api://asset-api",
    ASSET_API_URL: "https://asset-api.internal.example",
    ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/media-sync",
    AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
    MEETING_API_BASE_URL: "https://meeting.internal.example",
    MEETING_API_AUDIENCE: "api://operations-api",
    MEDIA_SYNC_WARM_QUEUE_URL: "https://assetscan.queue.core.windows.net/warm"
  };
  it.each([
    "MEETING_API_BASE_URL",
    "MEETING_API_AUDIENCE",
    "MEDIA_SYNC_WARM_QUEUE_URL",
    "dispatcher"
  ])("awaits pool cleanup when loop initialization fails at %s", async (stage) => {
    const loopEnv = { ...env };
    if (stage === "dispatcher")
      mocks.startOutbox.mockImplementationOnce(() => {
        throw new Error("dispatcher failed");
      });
    else Object.assign(loopEnv, { [stage]: "" });
    let releaseClose!: () => void;
    let closingStarted!: () => void;
    const closing = new Promise<void>((resolve) => {
      closingStarted = resolve;
    });
    mocks.postgresEnd.mockImplementationOnce(() => {
      closingStarted();
      return new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    });
    let settled = false;
    let failure: unknown;
    const running = runAttachmentWorkerLoop(loopEnv)
      .catch((error: unknown) => {
        failure = error;
      })
      .then(() => {
        settled = true;
      });
    try {
      expect(
        await Promise.race([closing.then(() => "closing"), running.then(() => "settled")])
      ).toBe("closing");
      expect(settled).toBe(false);
      expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
      expect(mocks.postgresEnd).toHaveBeenCalledTimes(1);
      expect(mocks.stopOutbox).not.toHaveBeenCalled();
    } finally {
      releaseClose?.();
      await running;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      stage === "dispatcher" ? "dispatcher failed" : stage
    );
  });

  const message = {
    messageText: JSON.stringify({
      kind: "media-sync",
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
    }),
    messageId: "work-message",
    popReceipt: "work-receipt"
  };
  const empty = { receivedMessageItems: [] };

  it("does not bootstrap an already stopped loop", async () => {
    await runAttachmentWorkerLoop(env, { signal: AbortSignal.abort() });
    expect(mocks.createPostgresRuntime).not.toHaveBeenCalled();
    expect(mocks.startOutbox).not.toHaveBeenCalled();
  });

  it("waits for bootstrap that ignores stop before closing without starting intake", async () => {
    const controller = new AbortController();
    const bootstrap = Promise.withResolvers<unknown>();
    mocks.createPostgresRuntime.mockReturnValue(bootstrap.promise);
    const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.createPostgresRuntime).toHaveBeenCalledOnce());
    controller.abort();
    expect(mocks.redisQuit).not.toHaveBeenCalled();
    bootstrap.resolve({ mediaSyncStore: {}, pool: { end: mocks.postgresEnd } });
    await running;
    expect(mocks.startOutbox).not.toHaveBeenCalled();
    expect(mocks.receiveMessages).not.toHaveBeenCalled();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it.each(["warm", "work-valid", "work-malformed"])(
    "leaves late %s messages unacknowledged when receive ignores abort",
    async (phase) => {
      const controller = new AbortController();
      const receive = Promise.withResolvers<{ receivedMessageItems: (typeof message)[] }>();
      if (phase !== "warm") mocks.receiveMessages.mockResolvedValueOnce(empty);
      mocks.receiveMessages.mockReturnValueOnce(receive.promise).mockResolvedValue(empty);
      const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
      const calls = phase === "warm" ? 1 : 2;
      await vi.waitFor(() => expect(mocks.receiveMessages).toHaveBeenCalledTimes(calls));
      controller.abort();
      const stoppedImmediately = mocks.stopOutbox.mock.calls.length;
      expect(mocks.redisQuit).not.toHaveBeenCalled();
      receive.resolve({
        receivedMessageItems: [
          { ...message, messageText: phase === "work-malformed" ? "invalid" : message.messageText }
        ]
      });
      await running;
      expect(stoppedImmediately).toBe(1);
      expect(mocks.receiveMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      );
      expect(mocks.receiveMessages).toHaveBeenCalledTimes(calls);
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.isWarm).not.toHaveBeenCalled();
      expect(mocks.runMediaSyncWorker).not.toHaveBeenCalled();
    }
  );

  it("awaits a warm delete already in progress without starting work receive", async () => {
    const controller = new AbortController();
    const ack = Promise.withResolvers<void>();
    mocks.complete.mockReturnValue(ack.promise);
    const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    controller.abort();
    expect(mocks.redisQuit).not.toHaveBeenCalled();
    ack.resolve();
    await running;
    expect(mocks.receiveMessages).toHaveBeenCalledOnce();
    expect(mocks.runMediaSyncWorker).not.toHaveBeenCalled();
  });

  it.each(["warm", "work"])("treats own %s receive AbortError as normal stop", async (phase) => {
    const controller = new AbortController();
    const receive = Promise.withResolvers<unknown>();
    if (phase === "work") mocks.receiveMessages.mockResolvedValueOnce(empty);
    mocks.receiveMessages.mockReturnValueOnce(receive.promise);
    const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
    const outcome = running.then(
      () => "stopped",
      (error) => error
    );
    await vi.waitFor(() =>
      expect(mocks.receiveMessages).toHaveBeenCalledTimes(phase === "warm" ? 1 : 2)
    );
    controller.abort();
    receive.reject(new DOMException("stopped", "AbortError"));
    expect(await outcome).toBe("stopped");
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves non-owned intake errors (aborted=%s)", async (aborted) => {
    const controller = new AbortController();
    const receive = Promise.withResolvers<unknown>();
    const error = aborted
      ? new Error("dependency_failed")
      : new DOMException("foreign_abort", "AbortError");
    mocks.receiveMessages.mockReturnValue(receive.promise);
    const outcome = runAttachmentWorkerLoop(env, { signal: controller.signal }).catch(
      (value) => value
    );
    await vi.waitFor(() => expect(mocks.receiveMessages).toHaveBeenCalledOnce());
    if (aborted) controller.abort();
    receive.reject(error);
    expect(await outcome).toBe(error);
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("does not start a handler when warm lookup ignores stop", async () => {
    const controller = new AbortController();
    const warm = Promise.withResolvers<boolean>();
    mocks.receiveMessages
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ receivedMessageItems: [message] });
    mocks.isWarm.mockReturnValue(warm.promise);
    const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.isWarm).toHaveBeenCalledOnce());
    controller.abort();
    expect(mocks.postgresEnd).not.toHaveBeenCalled();
    warm.reject(new Error("lookup_failed"));
    await running;
    expect(mocks.runMediaSyncWorker).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("stops ticks immediately but joins actual work, ACK and outbox before closing", async () => {
    const controller = new AbortController();
    const work = Promise.withResolvers<{ status: "completed" }>();
    const ack = Promise.withResolvers<void>();
    const outbox = Promise.withResolvers<void>();
    mocks.receiveMessages
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ receivedMessageItems: [message] });
    mocks.runMediaSyncWorker.mockReturnValue(work.promise);
    mocks.complete.mockReturnValue(ack.promise);
    mocks.stopOutbox.mockReturnValue(outbox.promise);
    const running = runAttachmentWorkerLoop(env, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.runMediaSyncWorker).toHaveBeenCalledOnce());
    controller.abort();
    const stoppedImmediately = mocks.stopOutbox.mock.calls.length;
    expect(mocks.redisQuit).not.toHaveBeenCalled();
    work.resolve({ status: "completed" });
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(mocks.complete).toHaveBeenCalledWith(message.messageId, message.popReceipt);
    expect(mocks.postgresEnd).not.toHaveBeenCalled();
    ack.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const closedBeforeJoin = mocks.postgresEnd.mock.calls.length;
    outbox.resolve();
    await running;
    expect(stoppedImmediately).toBe(1);
    expect(closedBeforeJoin).toBe(0);
    expect(mocks.stopOutbox).toHaveBeenCalledOnce();
    expect(mocks.receiveMessages).toHaveBeenCalledTimes(2);
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("preserves an active handler error after stop and still joins outbox", async () => {
    const controller = new AbortController();
    const work = Promise.withResolvers<unknown>();
    const outbox = Promise.withResolvers<void>();
    mocks.receiveMessages
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ receivedMessageItems: [message] });
    mocks.runMediaSyncWorker.mockReturnValue(work.promise);
    mocks.stopOutbox.mockReturnValue(outbox.promise);
    const outcome = runAttachmentWorkerLoop(env, { signal: controller.signal }).catch(
      (value) => value
    );
    await vi.waitFor(() => expect(mocks.runMediaSyncWorker).toHaveBeenCalledOnce());
    controller.abort();
    const error = new DOMException("work_uncertain", "AbortError");
    work.reject(error);
    await Promise.resolve();
    await Promise.resolve();
    const earlyClose = mocks.postgresEnd.mock.calls.length;
    outbox.resolve();
    expect(await outcome).toBe(error);
    expect(earlyClose).toBe(0);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("preserves a failed ACK after completed work while joining active flushes", async () => {
    const controller = new AbortController();
    const ack = Promise.withResolvers<void>();
    const outbox = Promise.withResolvers<void>();
    mocks.receiveMessages
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ receivedMessageItems: [message] });
    mocks.complete.mockReturnValue(ack.promise);
    mocks.stopOutbox.mockReturnValue(outbox.promise);
    const outcome = runAttachmentWorkerLoop(env, { signal: controller.signal }).catch(
      (value) => value
    );
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    controller.abort();
    const error = new Error("ack_uncertain");
    ack.reject(error);
    await Promise.resolve();
    await Promise.resolve();
    const earlyClose = mocks.postgresEnd.mock.calls.length;
    outbox.resolve();
    expect(await outcome).toBe(error);
    expect(earlyClose).toBe(0);
    expect(mocks.runMediaSyncWorker).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("starts PG close even while Redis quit is pending", async () => {
    const quit = Promise.withResolvers<void>();
    mocks.redisQuit.mockReturnValue(quit.promise);
    mocks.runMediaSyncWorker.mockResolvedValue({ status: "completed" });
    let settled = false;
    const running = runAttachmentWorker(env).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(mocks.redisQuit).toHaveBeenCalledOnce());
    const pgStarted = mocks.postgresEnd.mock.calls.length;
    const falselySettled = settled;
    quit.resolve();
    await running;
    expect(pgStarted).toBe(1);
    expect(falselySettled).toBe(false);
  });

  it("starts PG close when Redis quit throws synchronously", async () => {
    mocks.redisQuit.mockImplementation(() => {
      throw new Error("closed");
    });
    mocks.runMediaSyncWorker.mockResolvedValue({ status: "completed" });
    await runAttachmentWorker(env);
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });
});

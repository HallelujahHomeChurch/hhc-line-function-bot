import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MediaSyncWorkerModule from "../media-sync/worker.js";

const mocks = vi.hoisted(() => ({
  createAssetApiClient: vi.fn(),
  complete: vi.fn(),
  postgresEnd: vi.fn(),
  receiveMessages: vi.fn(),
  redisQuit: vi.fn(),
  startOutbox: vi.fn(),
  stopOutbox: vi.fn(),
  runMediaSyncWorker: vi.fn()
}));

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class ManagedIdentityCredential {}
}));
vi.mock("@azure/storage-queue", () => ({
  QueueClient: class QueueClient {
    receiveMessages() {
      return mocks.receiveMessages();
    }
    deleteMessage() {
      return mocks.complete();
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
  createPostgresRuntime: vi.fn().mockImplementation(async () => ({
    mediaSyncStore: {},
    pool: { end: mocks.postgresEnd }
  }))
}));
vi.mock("../functions/resource-binary-publisher.js", () => ({
  createResourceBinaryPublisher: vi.fn().mockReturnValue({})
}));
vi.mock("../media-sync/worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MediaSyncWorkerModule>()),
  runMediaSyncWorker: mocks.runMediaSyncWorker
}));
vi.mock("../redis.js", () => ({
  createRedisRuntime: vi.fn().mockImplementation(async () => ({
    client: { quit: mocks.redisQuit },
    keyPrefix: "test"
  }))
}));
vi.mock("../attachments/scan-outbox.js", () => ({
  startWarmMediaSyncOutboxDispatcher: mocks.startOutbox
}));
import { runAttachmentWorker, runAttachmentWorkerLoop } from "../tools/run-attachment-worker.js";

describe("attachment asset job lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startOutbox.mockReturnValue(mocks.stopOutbox);
    mocks.createAssetApiClient.mockReturnValue({});
    mocks.complete.mockResolvedValue(undefined);
    mocks.postgresEnd.mockReset().mockResolvedValue(undefined);
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

  const loopEnvironment = {
    ASSET_API_AUDIENCE: "api://asset-api",
    ASSET_API_URL: "https://asset-api.internal.example",
    ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/media-sync",
    AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
    MEETING_API_BASE_URL: "https://meeting.internal.example",
    MEETING_API_AUDIENCE: "api://meeting-api",
    MEDIA_SYNC_WARM_QUEUE_URL: "https://assetscan.queue.core.windows.net/warm"
  };

  it.each([
    "MEETING_API_BASE_URL",
    "MEETING_API_AUDIENCE",
    "MEDIA_SYNC_WARM_QUEUE_URL",
    "dispatcher"
  ])("awaits pool cleanup when loop initialization fails at %s", async (stage) => {
    const env = { ...loopEnvironment };
    if (stage === "dispatcher")
      mocks.startOutbox.mockImplementationOnce(() => {
        throw new Error("dispatcher failed");
      });
    else Object.assign(env, { [stage]: "" });
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
    const running = runAttachmentWorkerLoop(env)
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

  it("closes the loop runtime after an already-canceled signal without receiving work", async () => {
    await runAttachmentWorkerLoop(loopEnvironment, { signal: AbortSignal.abort() });
    expect(mocks.stopOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
    expect(mocks.postgresEnd).toHaveBeenCalledTimes(1);
    expect(mocks.receiveMessages).not.toHaveBeenCalled();
  });
});

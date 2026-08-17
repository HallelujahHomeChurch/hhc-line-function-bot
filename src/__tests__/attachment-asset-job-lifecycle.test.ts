import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MediaSyncWorkerModule from "../media-sync/worker.js";
import type * as AttachmentScanJobModule from "../tools/run-attachment-scan-job.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  postgresEnd: vi.fn(),
  receiveWork: vi.fn(),
  redisQuit: vi.fn(),
  runMediaSyncWorker: vi.fn()
}));

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class ManagedIdentityCredential {}
}));
vi.mock("@azure/storage-queue", () => ({
  QueueClient: class QueueClient {}
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
  createAssetApiClient: vi.fn().mockReturnValue({})
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
vi.mock("../tools/run-attachment-scan-job.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentScanJobModule>()),
  receiveAttachmentScanWork: mocks.receiveWork
}));

import { runAttachmentAssetJob } from "../tools/run-attachment-asset-job.js";

describe("attachment asset job lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue(undefined);
    mocks.postgresEnd.mockResolvedValue(undefined);
    mocks.receiveWork.mockResolvedValue({
      kind: "media-sync",
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
      complete: mocks.complete
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

    const running = runAttachmentAssetJob({
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
});

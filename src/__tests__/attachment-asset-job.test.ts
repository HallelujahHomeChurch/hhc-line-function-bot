import { describe, expect, it, vi } from "vitest";

import {
  assetAccessTokenScope,
  readAttachmentWorkerEnvironment,
  runAttachmentWorkerQueueLease
} from "../tools/run-attachment-worker.js";

describe("attachment asset job environment", () => {
  it("requires one dedicated managed identity and private Asset endpoint", () => {
    expect(
      readAttachmentWorkerEnvironment({
        ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/line-attachment-scan",
        ASSET_API_URL: "https://asset-api.internal.example",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
      })
    ).toEqual({
      queueUrl: "https://assetscan.queue.core.windows.net/line-attachment-scan",
      assetApiUrl: "https://asset-api.internal.example",
      assetApiAudience: "api://asset-api",
      managedIdentityClientId: "11111111-1111-4111-8111-111111111111"
    });
  });

  it.each([
    ["ATTACHMENT_SCAN_QUEUE_URL", { ATTACHMENT_SCAN_QUEUE_URL: "http://queue.invalid" }],
    ["ASSET_API_URL", { ASSET_API_URL: "http://asset.invalid" }],
    ["ASSET_API_AUDIENCE", { ASSET_API_AUDIENCE: "asset-api" }],
    ["AZURE_CLIENT_ID", { AZURE_CLIENT_ID: "not-a-uuid" }]
  ])("rejects an invalid %s", (field, override) => {
    expect(() =>
      readAttachmentWorkerEnvironment({
        ATTACHMENT_SCAN_QUEUE_URL: "https://assetscan.queue.core.windows.net/line-attachment-scan",
        ASSET_API_URL: "https://asset-api.internal.example",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
        ...override
      })
    ).toThrow(field);
  });

  it("uses the application scope required by managed identity", () => {
    expect(assetAccessTokenScope("api://asset-api")).toBe("api://asset-api/.default");
  });

  it("routes media-sync work to the finite media worker and ACKs a durable retry", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const runAttachment = vi.fn();
    const runMediaSync = vi.fn().mockResolvedValue({
      status: "rescheduled",
      reason: "scan_pending"
    });

    await expect(
      runAttachmentWorkerQueueLease(
        {
          kind: "media-sync",
          workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
          complete
        },
        { runAttachment, runMediaSync }
      )
    ).resolves.toEqual({
      exitCode: 0,
      status: { status: "rescheduled", reason: "scan_pending" }
    });
    expect(runMediaSync).toHaveBeenCalledWith("4c03465b-8a87-45a2-9d0d-54f904f4e6ab");
    expect(runAttachment).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("leaves the queue message unacknowledged after media-sync lease contention", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);

    await expect(
      runAttachmentWorkerQueueLease(
        {
          kind: "media-sync",
          workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
          complete
        },
        {
          runAttachment: vi.fn(),
          runMediaSync: vi.fn().mockResolvedValue({ status: "contention" })
        }
      )
    ).resolves.toEqual({ exitCode: 1, status: { status: "contention" } });
    expect(complete).not.toHaveBeenCalled();
  });
});

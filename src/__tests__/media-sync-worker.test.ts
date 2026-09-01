import { access, readdir } from "node:fs/promises";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MEDIA_SYNC_MAX_BYTES,
  nextDelay,
  runMediaSyncWorker,
  safeMediaFileName,
  shouldAcknowledgeMediaSyncResult
} from "../media-sync/worker.js";
import {
  createAssetApiClient,
  type AssetApiClient,
  type AssetRecord
} from "../clients/asset-api.js";
import type { MediaSyncWork } from "../media-sync/types.js";
import type { AgentJobStore } from "../agent/jobs.js";
import type { ResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import type { LineContentClient } from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

describe("media sync cadence", () => {
  it("retries pending scans in 2 seconds only while warm", () => {
    expect(nextDelay("pending", true)).toBe(2_000);
    expect(nextDelay("scanning", true)).toBe(2_000);
    expect(nextDelay("pending", false)).toBe(30_000);
    expect(nextDelay("clean", true)).toBe(30_000);
  });
});

describe("media sync source stage", () => {
  it("claims only the opaque work ID and loads through the exact lease token", async () => {
    const fixture = newUploadFixture();

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });

    expect(fixture.store.claimWork).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      operation: "intake",
      leaseMs: 600_000,
      now: new Date("2026-08-16T00:00:00.000Z")
    });
    expect(fixture.store.loadClaimedWork).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      operation: "intake",
      expectedClaimedUntil: fixture.claim.claimedUntil
    });
    expect(fixture.store.loadClaimedWork).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: expect.anything() })
    );
  });

  it("reschedules LINE transcoding and never opens a premature stream", async () => {
    const fixture = newUploadFixture();
    fixture.line.getMessageContentTranscodingStatus.mockResolvedValue("processing");

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "transcoding_processing"
    });
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith({
      sourceKey: "line:helper:message-1",
      operation: "intake",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      availableAt: new Date("2026-08-16T00:00:30.000Z"),
      lastErrorCategory: "transcoding_processing"
    });
    expect(fixture.line.getMessageContentStream).not.toHaveBeenCalled();
  });

  it("terminalizes LINE transcoding failure without downloading", async () => {
    const fixture = newUploadFixture();
    fixture.line.getMessageContentTranscodingStatus.mockResolvedValue("failed");

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "transcoding_failed"
    });
    expect(fixture.store.failClaimedWork).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      failureCategory: "transcoding_failed"
    });
    expect(fixture.line.getMessageContentStream).not.toHaveBeenCalled();
  });

  it("streams LINE content once and removes the temporary directory after inspection", async () => {
    const fixture = newUploadFixture();
    let temporaryDirectory = "";
    fixture.assets.uploadFile.mockImplementation(async (_target, path) => {
      temporaryDirectory = path.replace(/\/content$/u, "");
      await expect(access(path)).resolves.toBeUndefined();
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });

    expect(fixture.line.getMessageContentStream).toHaveBeenCalledTimes(1);
    expect(fixture.assets.uploadFile).toHaveBeenCalledTimes(1);
    await expect(readdir(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts one byte and the exact 200 MiB policy boundary", async () => {
    expect(MEDIA_SYNC_MAX_BYTES).toBe(209_715_200);
    const one = newUploadFixture(Readable.from([Buffer.from([1])]));
    await expect(runMediaSyncWorker("work-opaque-1", one.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });
    expect(one.assets.complete).toHaveBeenCalledWith(
      "asset-1",
      expect.objectContaining({ sizeBytes: 1 }),
      { signal: undefined }
    );

    const megabyte = Buffer.alloc(1024 * 1024);
    const boundary = newUploadFixture(Readable.from(Array.from({ length: 200 }, () => megabyte)));
    await expect(runMediaSyncWorker("work-opaque-1", boundary.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });
    expect(boundary.assets.complete).toHaveBeenCalledWith(
      "asset-1",
      expect.objectContaining({ sizeBytes: MEDIA_SYNC_MAX_BYTES }),
      { signal: undefined }
    );
  }, 20_000);

  it("rejects empty and above-limit content and always cleans up", async () => {
    const empty = newUploadFixture(Readable.from([]));
    await expect(runMediaSyncWorker("work-opaque-1", empty.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "line_content_empty"
    });

    const fixture = newUploadFixture(Readable.from([Buffer.alloc(4), Buffer.alloc(1)]));
    fixture.options.maxBytes = 4;
    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "line_content_too_large"
    });
    expect(fixture.store.failClaimedWork).toHaveBeenCalledTimes(1);
  });

  it("cancels the LINE stream at the deadline and releases the claim for retry", async () => {
    const stream = new Readable({ read() {} });
    const fixture = newUploadFixture(stream);
    fixture.options.lineDownloadTimeoutMs = 5;

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "line_content_timeout"
    });
    expect(stream.destroyed).toBe(true);
    expect(fixture.store.retryOutbox).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation and removes the partial file", async () => {
    const stream = new Readable({ read() {} });
    const fixture = newUploadFixture(stream);
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    setImmediate(() => controller.abort());

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "line_content_cancelled"
    });
    expect(stream.destroyed).toBe(true);
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ lastErrorCategory: "line_content_cancelled" })
    );
  });

  it("defends the upload filename boundary with a deterministic safe fallback", () => {
    const work = createWork();
    work.ingest.displayName = "../\u0000evil.mp4";
    expect(safeMediaFileName(work.ingest)).toMatch(/^video-[0-9a-f]{12}\.mp4$/u);
    work.ingest.displayName = `${"界".repeat(86)}.mp4`;
    expect(Buffer.byteLength(work.ingest.displayName)).toBeGreaterThan(255);
    expect(safeMediaFileName(work.ingest)).toMatch(/^video-[0-9a-f]{12}\.mp4$/u);
  });
});

describe("media sync Asset and collection stage", () => {
  it("ACKs only returned outcomes after durable retry or terminal state", () => {
    expect(
      shouldAcknowledgeMediaSyncResult({ status: "rescheduled", reason: "scan_pending" })
    ).toBe(true);
    expect(
      shouldAcknowledgeMediaSyncResult({ status: "rescheduled", reason: "processing_pending" })
    ).toBe(true);
    expect(shouldAcknowledgeMediaSyncResult({ status: "completed" })).toBe(true);
    expect(
      shouldAcknowledgeMediaSyncResult({
        status: "permanent_failure",
        reason: "scan_infected"
      })
    ).toBe(true);
    expect(shouldAcknowledgeMediaSyncResult({ status: "contention" })).toBe(false);
  });

  it("uploads the temp file once and persists a pending Asset before scheduling retry", async () => {
    const fixture = createAssetFixture();
    fixture.assets.createUpload.mockResolvedValue({
      asset: asset({ uploadStatus: "created", scanStatus: "pending" }),
      uploadTarget: { url: "https://blob.invalid/opaque", method: "PUT", headers: {} }
    });
    fixture.assets.uploadFile.mockImplementation(async (_target, path) => access(path));
    fixture.assets.complete.mockResolvedValue(
      asset({ uploadStatus: "completed", scanStatus: "pending", processingStatus: "pending" })
    );

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });

    expect(fixture.line.getMessageContentStream).toHaveBeenCalledTimes(1);
    expect(fixture.assets.uploadFile).toHaveBeenCalledTimes(1);
    expect(fixture.assets.get).not.toHaveBeenCalled();
    expect(fixture.assets.createUpload).toHaveBeenCalledWith(
      {
        namespace: "line.group.media-sync",
        idempotencyKey: expect.stringMatching(/^media-sync-upload:/u),
        ownerType: "media_sync_ingest",
        ownerId: "work-opaque-1",
        purpose: "media-sync",
        fileName: "video.mp4",
        mimeType: "video/mp4",
        maxSizeBytes: 5
      },
      { signal: undefined }
    );
    expect(fixture.store.loadClaimedWork).toHaveBeenCalledTimes(5);
    expect(fixture.store.persistCompletedAsset).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      assetId: "asset-1",
      assetEtag: "etag-1",
      sizeBytes: 5,
      checksumSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedClaimedUntil: fixture.claim.claimedUntil,
        lastErrorCategory: "scan_pending"
      })
    );
  });

  it.each([
    ["pending", "not_required"],
    ["scanning", "not_required"],
    ["clean", "pending"]
  ] as const)(
    "reads Asset once and reschedules scan=%s processing=%s",
    async (scanStatus, processingStatus) => {
      const fixture = createAssetFixture();
      fixture.work.ingest.assetId = "asset-1";
      fixture.work.ingest.assetEtag = "etag-1";
      fixture.work.ingest.state = "awaiting_scan";
      fixture.assets.get.mockResolvedValue(asset({ scanStatus, processingStatus }));

      await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
        status: "rescheduled",
        reason: scanStatus === "clean" ? "processing_pending" : "scan_pending"
      });
      expect(fixture.assets.get).toHaveBeenCalledTimes(1);
      expect(fixture.assets.addCollectionItem).not.toHaveBeenCalled();
    }
  );

  it("reschedules a warm pending scan after 2 seconds", async () => {
    const fixture = createAssetFixture();
    fixture.work.ingest.assetId = "asset-1";
    fixture.work.ingest.assetEtag = "etag-1";
    fixture.assets.get.mockResolvedValue(asset({ scanStatus: "pending" }));
    fixture.options.warm = true;

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "scan_pending"
    });
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date("2026-08-16T00:00:02.000Z") })
    );
  });

  it.each([
    ["inactive binding", "binding_inactive"],
    ["infected Asset", "scan_infected"]
  ] as const)(
    "compensates every persisted owner before terminalizing an %s",
    async (scenario, reason) => {
      const fixture = cleanAssetFixture();
      fixture.work.publications[0]!.state = "published";
      fixture.work.publications[0]!.targetId = "occurrence-actual-1";
      fixture.work.publications.push({
        ...manualPublication(),
        state: "published",
        targetId: "resource-actual-1"
      });
      if (scenario === "inactive binding") {
        fixture.store.findActiveBinding.mockResolvedValue(undefined);
      } else {
        fixture.assets.get.mockResolvedValue(asset({ scanStatus: "infected" }));
      }

      await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
        status: "permanent_failure",
        reason
      });
      expect(fixture.assets.softDelete).toHaveBeenCalledWith("asset-1");
      expect(fixture.assets.deleteCollectionItem).toHaveBeenCalledWith(
        "collection-1",
        "occurrence-actual-1",
        expect.stringMatching(/^media-sync-collection-compensate:/u)
      );
      expect(fixture.publisher.tombstonePublishedResource).toHaveBeenCalledWith(
        "resource-actual-1",
        new Date("2026-08-16T00:00:00.000Z")
      );
      expect(fixture.store.failClaimedWork).toHaveBeenCalledWith(
        expect.objectContaining({ failureCategory: reason })
      );
    }
  );

  it("atomically tombstones current work after terminal owner compensation fails", async () => {
    const fixture = cleanAssetFixture();
    fixture.work.publications[0]!.state = "published";
    fixture.work.publications[0]!.targetId = "occurrence-actual-1";
    fixture.store.findActiveBinding.mockResolvedValue(undefined);
    fixture.assets.softDelete.mockRejectedValue(new Error("asset unavailable"));
    fixture.assets.deleteCollectionItem.mockRejectedValue(new Error("asset unavailable"));

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "binding_inactive"
    });
    expect(fixture.store.rememberOwnedAsset).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      assetId: "asset-1",
      assetEtag: "etag-1"
    });
    expect(fixture.store.rememberExternalHandle).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      publicationType: "collection",
      destinationId: "collection-1",
      targetId: "occurrence-actual-1"
    });
    expect(fixture.store.tombstoneClaimedWorkForCleanup).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil
    });
    expect(fixture.store.failClaimedWork).not.toHaveBeenCalled();
    expect(fixture.store.rememberOwnedAsset.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.store.tombstoneClaimedWorkForCleanup.mock.invocationCallOrder[0]!
    );
    expect(fixture.store.rememberExternalHandle.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.store.tombstoneClaimedWorkForCleanup.mock.invocationCallOrder[0]!
    );
  });

  it("publishes only a clean ready Asset and persists the actual returned occurrence ID", async () => {
    const fixture = cleanAssetFixture();
    const onTiming = vi.fn();
    fixture.options.onTiming = onTiming;

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.get).toHaveBeenCalledTimes(1);
    expect(fixture.assets.addCollectionItem).toHaveBeenCalledWith(
      "collection-1",
      {
        assetId: "asset-1",
        remoteItemId: "work-opaque-1",
        displayName: "video.mp4",
        sourceRevision: "a".repeat(64)
      },
      expect.stringMatching(/^media-sync-collection:/u),
      { signal: undefined }
    );
    expect(fixture.store.finalizeCollectionPublication).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      collectionId: "collection-1",
      occurrenceId: "occurrence-actual-1"
    });
    expect(fixture.store.completeClaimedWork).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil
    });
    expect(onTiming.mock.calls).toEqual([
      ["clean_observed", "work-opaque-1"],
      ["collection_published", "work-opaque-1"]
    ]);
  });

  it("persists a production-shaped Asset occurrence without owner compensation", async () => {
    const fixture = cleanAssetFixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          asset({
            scanStatus: "clean",
            scanSignatureVersion: "daily-20260816",
            processingStatus: "ready"
          })
        )
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            collection: {
              id: "collection-1",
              namespace: "line.group.media-sync",
              name: "Media",
              revision: 2,
              retentionDays: 14,
              createdAt: "2026-08-16T00:00:00Z",
              updatedAt: "2026-08-16T00:01:00Z"
            },
            item: {
              id: "occurrence-actual-1",
              collectionId: "collection-1",
              assetId: "asset-1",
              remoteItemId: "work-opaque-1",
              displayName: "video.mp4",
              sourceRevision: "a".repeat(64),
              createdRevision: 2,
              retentionExempt: false,
              updatedRevision: 2,
              mimeType: "video/mp4",
              sizeBytes: 5,
              etag: "etag-1",
              createdAt: "2026-08-16T00:01:00Z",
              updatedAt: "2026-08-16T00:01:00Z"
            }
          },
          { status: 201 }
        )
      );
    fixture.options.assets = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.work.publications[0]).toMatchObject({
      state: "published",
      targetId: "occurrence-actual-1"
    });
    expect(fixture.store.failClaimedWork).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => String(url).endsWith("/assets/asset-1") && init?.method === "DELETE"
      )
    ).toBe(false);
  });

  it.each([
    ["infected", "not_required", "scan_infected"],
    ["failed", "not_required", "scan_failed"],
    ["clean", "failed", "processing_failed"]
  ] as const)(
    "terminalizes scan=%s processing=%s",
    async (scanStatus, processingStatus, reason) => {
      const fixture = createAssetFixture();
      fixture.work.ingest.assetId = "asset-1";
      fixture.work.ingest.state = "awaiting_scan";
      fixture.assets.get.mockResolvedValue(asset({ scanStatus, processingStatus }));

      await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
        status: "permanent_failure",
        reason
      });
      expect(fixture.store.failClaimedWork).toHaveBeenCalledWith(
        expect.objectContaining({ failureCategory: reason })
      );
    }
  );

  it.each(["missing", "terminal"] as const)(
    "acknowledges %s queue work without loading or downloading",
    async (status) => {
      const fixture = createAssetFixture();
      fixture.store.claimWork.mockResolvedValue(status);

      await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
        status
      });
      expect(fixture.store.loadClaimedWork).not.toHaveBeenCalled();
      expect(fixture.line.getMessageContentStream).not.toHaveBeenCalled();
      expect(shouldAcknowledgeMediaSyncResult({ status })).toBe(true);
    }
  );

  it("keeps busy queue work unacknowledged", async () => {
    const fixture = createAssetFixture();
    fixture.store.claimWork.mockResolvedValue("busy");

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(shouldAcknowledgeMediaSyncResult({ status: "contention" })).toBe(false);
  });

  it("terminalizes a permanent Asset policy rejection", async () => {
    const fixture = createAssetFixture();
    fixture.options.assets = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 }))
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "asset_policy_rejected"
    });
  });

  it("settles an Asset created before the collection deletion fence without an active item", async () => {
    const fixture = cleanAssetFixture();
    let tombstoned = false;
    let assetActive = true;
    let softDeleteAttempts = 0;
    const activeCollectionItems: string[] = [];
    const rejectingAssets = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 }))
    });
    fixture.store.claimWork.mockImplementation(async ({ operation }) => {
      if (operation === "intake") return tombstoned ? "terminal" : fixture.claim;
      return fixture.claim;
    });
    fixture.store.tombstoneClaimedWorkForCleanup.mockImplementation(async () => {
      tombstoned = true;
      fixture.work.ingest.state = "tombstoned";
      return true;
    });
    fixture.assets.get
      .mockResolvedValueOnce(
        asset({
          scanStatus: "clean",
          scanSignatureVersion: "daily-20260816",
          processingStatus: "ready"
        })
      )
      .mockResolvedValueOnce(
        asset({
          ownerService: "hhc-line-function-bot",
          ownerType: "media_sync_ingest",
          ownerId: "work-opaque-1"
        })
      );
    fixture.assets.addCollectionItem.mockImplementation(async (...args) => {
      const mutation = await rejectingAssets.addCollectionItem(...args);
      activeCollectionItems.push(mutation.item.id);
      return mutation;
    });
    fixture.assets.softDelete.mockImplementation(async () => {
      softDeleteAttempts += 1;
      if (softDeleteAttempts === 1) throw new Error("asset_api_503");
      assetActive = false;
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      reason: "asset_policy_rejected"
    });
    expect(fixture.assets.softDelete).toHaveBeenNthCalledWith(1, "asset-1");
    expect(fixture.store.rememberOwnedAsset).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      assetId: "asset-1",
      assetEtag: "etag-1"
    });
    expect(fixture.store.tombstoneClaimedWorkForCleanup).toHaveBeenCalledOnce();
    expect(fixture.store.finalizeCollectionPublication).not.toHaveBeenCalled();
    expect(activeCollectionItems).toEqual([]);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.softDelete).toHaveBeenNthCalledWith(2, "asset-1", {
      signal: undefined
    });
    expect(fixture.store.completeDeleteWork).toHaveBeenCalledOnce();
    expect(assetActive).toBe(false);
    expect(activeCollectionItems).toEqual([]);
  });

  it("compensates the actual occurrence when the finalize lease/tombstone fence rejects it", async () => {
    const fixture = cleanAssetFixture();
    fixture.store.finalizeCollectionPublication.mockResolvedValue(false);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.assets.deleteCollectionItem).toHaveBeenCalledWith(
      "collection-1",
      "occurrence-actual-1",
      expect.stringMatching(/^media-sync-collection-compensate:/u)
    );
    expect(fixture.store.rememberExternalHandle).not.toHaveBeenCalled();
  });

  it("durably remembers the actual occurrence when immediate compensation fails", async () => {
    const fixture = cleanAssetFixture();
    fixture.store.finalizeCollectionPublication.mockResolvedValue(false);
    fixture.assets.deleteCollectionItem.mockRejectedValue(new Error("asset unavailable"));

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.store.rememberExternalHandle).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      publicationType: "collection",
      destinationId: "collection-1",
      targetId: "occurrence-actual-1"
    });
    expect(fixture.store.tombstoneClaimedWorkForCleanup).not.toHaveBeenCalled();
  });

  it("owner-deletes a completed Asset when its lease is lost, or remembers it for delete retry", async () => {
    const fixture = createAssetFixture();
    fixture.assets.createUpload.mockResolvedValue({
      asset: asset({ uploadStatus: "created" }),
      uploadTarget: { url: "https://blob.invalid/opaque", method: "PUT", headers: {} }
    });
    fixture.assets.complete.mockResolvedValue(asset({ scanStatus: "pending" }));
    fixture.store.persistCompletedAsset.mockResolvedValue(false);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.assets.softDelete).toHaveBeenCalledWith("asset-1");

    const failedCompensation = createAssetFixture();
    failedCompensation.assets.createUpload.mockResolvedValue({
      asset: asset({ uploadStatus: "created" }),
      uploadTarget: { url: "https://blob.invalid/opaque", method: "PUT", headers: {} }
    });
    failedCompensation.assets.complete.mockResolvedValue(asset({ scanStatus: "pending" }));
    failedCompensation.store.persistCompletedAsset.mockResolvedValue(false);
    failedCompensation.assets.softDelete.mockRejectedValue(new Error("asset unavailable"));

    await runMediaSyncWorker("work-opaque-1", failedCompensation.options);
    expect(failedCompensation.store.rememberOwnedAsset).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      assetId: "asset-1",
      assetEtag: "etag-1"
    });
    expect(failedCompensation.store.tombstoneClaimedWorkForCleanup).not.toHaveBeenCalled();
  });

  it("resumes a remembered collection occurrence under the replacement lease", async () => {
    const fixture = cleanAssetFixture();
    fixture.work.publications[0]!.targetId = "occurrence-remembered";
    fixture.work.publications[0]!.state = "pending";

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.addCollectionItem).not.toHaveBeenCalled();
    expect(fixture.store.finalizeCollectionPublication).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      collectionId: "collection-1",
      occurrenceId: "occurrence-remembered"
    });
  });

  it("resumes a remembered manual resource without publishing another copy", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push({
      ...manualPublication(),
      targetId: "resource-remembered"
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.download).not.toHaveBeenCalled();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
    expect(fixture.store.finalizeManualPublication).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      destinationId: "pending-attachment-1",
      resourceId: "resource-remembered"
    });
    expect(fixture.agentJobs.complete).toHaveBeenCalledOnce();
  });

  it("publishes a confirmed manual intent from the same clean Asset and persists its actual resource ID", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push(manualPublication());
    fixture.assets.download.mockResolvedValue({
      data: pptxBytes,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });

    expect(fixture.line.getMessageContentStream).not.toHaveBeenCalled();
    expect(fixture.assets.createUpload).not.toHaveBeenCalled();
    expect(fixture.assets.download).toHaveBeenCalledTimes(1);
    expect(fixture.publisher.publishVerifiedResource).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          target: {
            profileName: "helper",
            sourceKey: "ppt_slides",
            itemKind: "ppt_slide",
            domain: "presentation",
            title: "SundayDeck"
          }
        }),
        scan: { status: "clean", signatureVersion: "daily-20260816" }
      })
    );
    expect(fixture.store.finalizeManualPublication).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      destinationId: "pending-attachment-1",
      resourceId: "resource-actual-1"
    });
    expect(fixture.agentJobs.complete).toHaveBeenCalledWith(
      "job-manual-1",
      expect.objectContaining({ ok: true, executedAction: "save_resource" }),
      "save_resource"
    );
  });

  it("fails only the manual branch when its clean Asset exceeds 25 MiB", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.ingest.sizeBytes = 25 * 1024 * 1024 + 1;
    fixture.work.publications.push(manualPublication());

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });

    expect(fixture.assets.download).not.toHaveBeenCalled();
    expect(fixture.store.failManualPublication).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      destinationId: "pending-attachment-1",
      failureCategory: "manual_file_too_large"
    });
    expect(fixture.store.finalizeCollectionPublication).toHaveBeenCalledTimes(1);
    expect(fixture.store.failClaimedWork).not.toHaveBeenCalled();
    expect(fixture.agentJobs.fail).toHaveBeenCalledWith("job-manual-1", "manual_file_too_large");
  });

  it("does not publish an unconfirmed manual placeholder or block automatic completion", async () => {
    const fixture = cleanAssetFixture();
    fixture.work.publications.push({
      sourceKey: fixture.work.ingest.sourceKey,
      publicationType: "manual",
      destinationId: "pending-attachment-1",
      state: "pending",
      requesterUserId: "U1"
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.download).not.toHaveBeenCalled();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
    expect(fixture.store.failManualPublication).not.toHaveBeenCalled();
  });

  it("fails only the manual branch when curated format validation rejects the clean Asset", async () => {
    const fixture = cleanAssetFixture();
    fixture.work.ingest.displayName = "notes.txt";
    fixture.work.ingest.mediaKind = "file";
    fixture.work.ingest.expectedMime = "text/plain";
    fixture.work.publications.push(manualPublication());
    fixture.assets.download.mockResolvedValue({
      data: new TextEncoder().encode("unsupported"),
      contentType: "text/plain"
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.store.failManualPublication).toHaveBeenCalledWith(
      expect.objectContaining({ failureCategory: "manual_format_rejected" })
    );
    expect(fixture.store.failClaimedWork).not.toHaveBeenCalled();
    expect(fixture.store.finalizeCollectionPublication).toHaveBeenCalledTimes(1);
  });

  it("keeps the published collection when manual Asset access is permanently rejected", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push(manualPublication());
    const rejected = createAssetApiClient({
      baseUrl: "https://asset.internal",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }))
    });
    fixture.assets.grantServiceRead.mockImplementation(() =>
      rejected.grantServiceRead("asset-1", "manual-read")
    );

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.store.failManualPublication).toHaveBeenCalledWith(
      expect.objectContaining({ failureCategory: "manual_asset_rejected" })
    );
    expect(fixture.store.failClaimedWork).not.toHaveBeenCalled();
    expect(fixture.store.finalizeCollectionPublication).toHaveBeenCalledTimes(1);
  });

  it("does not claim or compensate an existing catalog resource returned as a duplicate", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push(manualPublication());
    fixture.assets.download.mockResolvedValue({ data: pptxBytes });
    fixture.publisher.publishVerifiedResource.mockResolvedValue({
      status: "duplicate",
      resourceId: "resource-existing-1",
      result: { ok: true, replyText: "已經有相同檔案。" }
    });

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.store.failManualPublication).toHaveBeenCalledWith(
      expect.objectContaining({ failureCategory: "manual_duplicate" })
    );
    expect(fixture.store.finalizeManualPublication).not.toHaveBeenCalled();
    expect(fixture.publisher.tombstonePublishedResource).not.toHaveBeenCalled();
    expect(fixture.agentJobs.complete).toHaveBeenCalledWith(
      "job-manual-1",
      expect.objectContaining({ replyText: "已經有相同檔案。" }),
      "save_resource"
    );
  });

  it("immediately compensates an actual catalog resource rejected by the finalize fence", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push(manualPublication());
    fixture.assets.download.mockResolvedValue({ data: pptxBytes });
    fixture.store.finalizeManualPublication.mockResolvedValue(false);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.publisher.tombstonePublishedResource).toHaveBeenCalledWith(
      "resource-actual-1",
      new Date("2026-08-16T00:00:00.000Z")
    );
    expect(fixture.store.rememberExternalHandle).not.toHaveBeenCalledWith(
      expect.objectContaining({ publicationType: "manual" })
    );
  });

  it("durably remembers the actual catalog owner handle when compensation fails", async () => {
    const fixture = cleanAssetFixture();
    makePptxManual(fixture.work);
    fixture.work.publications.push(manualPublication());
    fixture.assets.download.mockResolvedValue({ data: pptxBytes });
    fixture.store.finalizeManualPublication.mockResolvedValue(false);
    fixture.publisher.tombstonePublishedResource.mockResolvedValue(false);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.store.rememberExternalHandle).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      publicationType: "manual",
      destinationId: "pending-attachment-1",
      targetId: "resource-actual-1"
    });
  });
});

describe("media sync tombstone deletion", () => {
  it("deletes exact persisted owners and completes only the delete lease", async () => {
    const fixture = deleteFixture();

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.store.claimWork).toHaveBeenNthCalledWith(1, {
      workId: "work-opaque-1",
      operation: "intake",
      leaseMs: 600_000,
      now: new Date("2026-08-16T00:00:00.000Z")
    });
    expect(fixture.store.claimWork).toHaveBeenNthCalledWith(2, {
      workId: "work-opaque-1",
      operation: "delete",
      leaseMs: 600_000,
      now: new Date("2026-08-16T00:00:00.000Z")
    });
    expect(fixture.assets.deleteCollectionItem).toHaveBeenCalledWith(
      "collection-1",
      "occurrence-actual-1",
      expect.stringMatching(/^media-sync-delete-collection:/u),
      { signal: undefined }
    );
    expect(fixture.publisher.tombstonePublishedResource).toHaveBeenCalledWith(
      "resource-actual-1",
      new Date("2026-08-16T00:00:00.000Z")
    );
    expect(fixture.assets.get).toHaveBeenCalledWith("asset-1", { signal: undefined });
    expect(fixture.assets.softDelete).toHaveBeenCalledWith("asset-1", { signal: undefined });
    expect(fixture.store.completeDeleteWork).toHaveBeenCalledWith({
      workId: "work-opaque-1",
      expectedClaimedUntil: fixture.claim.claimedUntil
    });
  });

  it("treats already-gone collection and Asset owners as idempotent success", async () => {
    const fixture = deleteFixture();
    fixture.assets.deleteCollectionItem.mockRejectedValue(new Error("asset_api_404"));
    fixture.assets.get.mockRejectedValue(new Error("asset_api_404"));

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "completed"
    });
    expect(fixture.assets.softDelete).not.toHaveBeenCalled();
    expect(fixture.store.completeDeleteWork).toHaveBeenCalledTimes(1);
  });

  it("retries the tombstoned delete lease after an external failure", async () => {
    const fixture = deleteFixture();
    fixture.assets.deleteCollectionItem.mockRejectedValue(new Error("asset_api_503"));

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "cleanup_unavailable"
    });
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith({
      sourceKey: "line:helper:message-1",
      operation: "delete",
      expectedClaimedUntil: fixture.claim.claimedUntil,
      availableAt: new Date("2026-08-16T00:00:30.000Z"),
      lastErrorCategory: "cleanup_unavailable"
    });
    expect(fixture.store.completeDeleteWork).not.toHaveBeenCalled();
  });

  it("durably retries when catalog owner cleanup throws", async () => {
    const fixture = deleteFixture();
    fixture.work.publications = fixture.work.publications.filter(
      (publication) => publication.publicationType === "manual"
    );
    fixture.publisher.tombstonePublishedResource.mockRejectedValue(
      new Error("catalog unavailable")
    );

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "cleanup_unavailable"
    });
    expect(fixture.store.retryOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "delete", lastErrorCategory: "cleanup_unavailable" })
    );
  });

  it("stops at a late delete lease fence before touching the next owner", async () => {
    const fixture = deleteFixture();
    fixture.store.loadClaimedWork
      .mockResolvedValueOnce(fixture.work)
      .mockResolvedValueOnce(undefined);

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.assets.deleteCollectionItem).toHaveBeenCalledTimes(1);
    expect(fixture.publisher.tombstonePublishedResource).not.toHaveBeenCalled();
    expect(fixture.assets.get).not.toHaveBeenCalled();
    expect(fixture.store.completeDeleteWork).not.toHaveBeenCalled();
  });

  it("fails closed when the Asset is not owned by the exact ingest work", async () => {
    const fixture = deleteFixture();
    fixture.work.publications = [];
    fixture.assets.get.mockResolvedValue(
      asset({
        ownerService: "hhc-line-function-bot",
        ownerType: "media_sync_ingest",
        ownerId: "different-work"
      })
    );

    await expect(runMediaSyncWorker("work-opaque-1", fixture.options)).resolves.toEqual({
      status: "rescheduled",
      reason: "cleanup_unavailable"
    });
    expect(fixture.assets.softDelete).not.toHaveBeenCalled();
  });
});

function cleanAssetFixture() {
  const fixture = createAssetFixture();
  fixture.work.ingest.assetId = "asset-1";
  fixture.work.ingest.assetEtag = "etag-1";
  fixture.work.ingest.checksumSha256 = "a".repeat(64);
  fixture.work.ingest.sizeBytes = 5;
  fixture.work.ingest.state = "awaiting_scan";
  fixture.assets.get.mockResolvedValue(
    asset({
      scanStatus: "clean",
      scanSignatureVersion: "daily-20260816",
      processingStatus: "ready"
    })
  );
  return fixture;
}

function deleteFixture() {
  const claim = {
    workId: "work-opaque-1",
    sourceKey: "line:helper:message-1",
    operation: "delete" as const,
    attempts: 1,
    availableAt: "2026-08-16T00:00:00.000Z",
    claimedUntil: "2099-08-16T00:10:00.000Z",
    dispatchedAt: "2026-08-16T00:00:00.000Z"
  };
  const work = createWork();
  work.ingest.state = "tombstoned";
  work.ingest.assetId = "asset-1";
  work.publications = [
    {
      sourceKey: work.ingest.sourceKey,
      publicationType: "collection",
      destinationId: "collection-1",
      targetId: "occurrence-actual-1",
      state: "revoked"
    },
    {
      sourceKey: work.ingest.sourceKey,
      publicationType: "manual",
      destinationId: "pending-attachment-1",
      targetId: "resource-actual-1",
      state: "revoked"
    }
  ];
  const store = {
    claimWork: vi
      .fn()
      .mockImplementation(async ({ operation }) => (operation === "intake" ? "terminal" : claim)),
    loadClaimedWork: vi.fn().mockResolvedValue(work),
    findActiveBinding: vi.fn(),
    retryOutbox: vi.fn().mockResolvedValue(true),
    failClaimedWork: vi.fn(),
    persistCompletedAsset: vi.fn(),
    finalizeCollectionPublication: vi.fn(),
    completeClaimedWork: vi.fn(),
    completeDeleteWork: vi.fn().mockResolvedValue(true),
    rememberExternalHandle: vi.fn(),
    rememberOwnedAsset: vi.fn(),
    tombstoneClaimedWorkForCleanup: vi.fn(),
    finalizeManualPublication: vi.fn(),
    failManualPublication: vi.fn()
  };
  const assets = {
    get: vi.fn().mockResolvedValue(
      asset({
        ownerService: "hhc-line-function-bot",
        ownerType: "media_sync_ingest",
        ownerId: "work-opaque-1"
      })
    ),
    deleteCollectionItem: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(undefined)
  };
  const publisher = {
    publishVerifiedResource: vi.fn(),
    tombstonePublishedResource: vi.fn().mockResolvedValue(true)
  } satisfies ResourceBinaryPublisher;
  return {
    claim,
    work,
    store,
    assets,
    publisher,
    options: {
      store: store as never,
      assets: assets as unknown as AssetApiClient,
      lineContent: {} as LineContentClient,
      profiles: [],
      workerLeaseMs: 600_000,
      retryDelayMs: 30_000,
      lineDownloadTimeoutMs: 1_000,
      maxBytes: MEDIA_SYNC_MAX_BYTES,
      publisher,
      now: () => new Date("2026-08-16T00:00:00.000Z")
    }
  };
}

function createAssetFixture() {
  const claim = {
    workId: "work-opaque-1",
    sourceKey: "line:helper:message-1",
    operation: "intake" as const,
    attempts: 1,
    availableAt: "2026-08-16T00:00:00.000Z",
    claimedUntil: "2099-08-16T00:10:00.000Z",
    dispatchedAt: "2026-08-16T00:00:00.000Z"
  };
  const work = createWork();
  const store = {
    claimWork: vi.fn().mockResolvedValue(claim),
    loadClaimedWork: vi.fn().mockImplementation(async () => work),
    findActiveBinding: vi.fn().mockResolvedValue({ collectionId: "collection-1" }),
    retryOutbox: vi.fn().mockResolvedValue(true),
    failClaimedWork: vi.fn().mockResolvedValue(true),
    persistCompletedAsset: vi.fn().mockImplementation(async (input) => {
      work.ingest.assetId = input.assetId;
      work.ingest.assetEtag = input.assetEtag;
      work.ingest.sizeBytes = input.sizeBytes;
      work.ingest.checksumSha256 = input.checksumSha256;
      work.ingest.state = "awaiting_scan";
      return true;
    }),
    finalizeCollectionPublication: vi.fn().mockImplementation(async (input) => {
      Object.assign(work.publications[0]!, {
        state: "published",
        targetId: input.occurrenceId
      });
      return true;
    }),
    finalizeManualPublication: vi.fn().mockImplementation(async (input) => {
      Object.assign(
        work.publications.find((item) => item.publicationType === "manual")!,
        {
          state: "published",
          targetId: input.resourceId
        }
      );
      return true;
    }),
    failManualPublication: vi.fn().mockImplementation(async () => {
      Object.assign(
        work.publications.find((item) => item.publicationType === "manual")!,
        {
          state: "failed"
        }
      );
      return true;
    }),
    completeClaimedWork: vi.fn().mockResolvedValue(true),
    completeDeleteWork: vi.fn().mockResolvedValue(true),
    tombstoneClaimedWorkForCleanup: vi.fn().mockResolvedValue(true),
    rememberExternalHandle: vi.fn().mockResolvedValue(true),
    rememberOwnedAsset: vi.fn().mockResolvedValue(true)
  };
  const assets = {
    createUpload: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn(),
    get: vi.fn(),
    grantServiceRead: vi.fn().mockResolvedValue({ id: "grant-1" }),
    download: vi.fn(),
    addCollectionItem: vi.fn().mockResolvedValue({
      collection: { id: "collection-1" },
      item: { id: "occurrence-actual-1" }
    }),
    deleteCollectionItem: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(undefined)
  };
  const publisher = {
    publishVerifiedResource: vi.fn().mockResolvedValue({
      status: "published",
      resourceId: "resource-actual-1",
      result: { ok: true, executedAction: "save_resource", replyText: "檔案已保存。" }
    }),
    tombstonePublishedResource: vi.fn().mockResolvedValue(true)
  } satisfies ResourceBinaryPublisher;
  const agentJobs = {
    createPending: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    get: vi.fn()
  } satisfies AgentJobStore;
  const line = {
    getMessageContent: vi.fn(),
    getMessageContentStream: vi.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from("hello")]),
      contentType: "video/mp4"
    }),
    getMessageContentTranscodingStatus: vi.fn().mockResolvedValue("succeeded")
  };
  return {
    claim,
    work,
    store,
    assets,
    line,
    publisher,
    agentJobs,
    options: {
      store: store as never,
      assets: assets as unknown as AssetApiClient,
      lineContent: line as unknown as LineContentClient,
      profiles: [{ name: "helper", channelAccessToken: "token" }],
      workerLeaseMs: 600_000,
      retryDelayMs: 30_000,
      lineDownloadTimeoutMs: 1_000,
      maxBytes: MEDIA_SYNC_MAX_BYTES,
      manualMaxBytes: 25 * 1024 * 1024,
      publisher,
      agentJobStore: agentJobs,
      now: () => new Date("2026-08-16T00:00:00.000Z")
    }
  };
}

function manualPublication(): MediaSyncWork["publications"][number] {
  return {
    sourceKey: "line:helper:message-1",
    publicationType: "manual",
    destinationId: "pending-attachment-1",
    state: "pending",
    requesterUserId: "U1",
    jobId: "job-manual-1",
    manualSourceKey: "ppt_slides",
    manualItemKind: "ppt_slide",
    manualDomain: "presentation",
    manualTitle: "SundayDeck"
  };
}

function makePptxManual(work: MediaSyncWork): void {
  work.ingest.displayName = "OriginalDeck.pptx";
  work.ingest.mediaKind = "file";
  work.ingest.expectedMime =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function asset(overrides: Partial<AssetRecord>): AssetRecord {
  return {
    id: "asset-1",
    etag: "etag-1",
    uploadStatus: "completed",
    scanStatus: "pending",
    processingStatus: "not_required",
    ...overrides
  };
}

function newUploadFixture(stream: Readable = Readable.from([Buffer.from("hello")])) {
  const fixture = createAssetFixture();
  fixture.line.getMessageContentStream.mockResolvedValue({ stream, contentType: "video/mp4" });
  fixture.assets.createUpload.mockResolvedValue({
    asset: asset({ uploadStatus: "created", scanStatus: "pending" }),
    uploadTarget: { url: "https://blob.invalid/opaque", method: "PUT", headers: {} }
  });
  fixture.assets.complete.mockResolvedValue(
    asset({ uploadStatus: "completed", scanStatus: "pending", processingStatus: "pending" })
  );
  return fixture;
}

function createWork(): MediaSyncWork {
  return {
    ingest: {
      sourceKey: "line:helper:message-1",
      workId: "work-opaque-1",
      profileName: "helper",
      messageId: "message-1",
      groupId: "group-1",
      collectionId: "collection-1",
      state: "pending",
      displayName: "video.mp4",
      mediaKind: "video",
      expectedMime: "video/mp4",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z"
    },
    publications: [
      {
        sourceKey: "line:helper:message-1",
        publicationType: "collection",
        destinationId: "collection-1",
        state: "pending"
      }
    ]
  };
}

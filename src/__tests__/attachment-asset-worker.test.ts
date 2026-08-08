import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { runAttachmentAssetWorker } from "../attachments/asset-worker.js";
import { InMemoryAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import {
  createAssetApiClient,
  type AssetApiClient,
  type AssetRecord
} from "../clients/asset-api.js";
import type { ResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";

const clock = new Date("2026-08-01T08:00:00.000Z");
const pdf = new TextEncoder().encode("%PDF-1.7\nclean");
const descriptor = {
  fileName: "Sunday.pdf",
  mimeType: "application/pdf",
  sizeBytes: 14,
  checksumSha256: "21da2c863a9ab83580b7acacc83c1723039f74f991a4c5795384f2c847a4b574"
};

describe("attachment asset worker", () => {
  it("uploads once, waits for Asset clean status, then publishes verified bytes", async () => {
    const fixture = await setup();

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({ status: "completed", signatureHealth: "current" });
    expect(fixture.assets.createUpload).toHaveBeenCalledTimes(1);
    expect(fixture.assets.upload).toHaveBeenCalledTimes(1);
    expect(fixture.assets.complete).toHaveBeenCalledTimes(1);
    expect(fixture.assets.grantServiceRead).toHaveBeenCalledWith("asset-1", fixture.workId);
    expect(fixture.publisher.publishVerifiedResource).toHaveBeenCalledWith(
      expect.objectContaining({ scan: { status: "clean", signatureVersion: "main-1" } })
    );
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBe("completed");
  });

  it("leaves pending Asset scans retryable without consuming a work failure", async () => {
    const fixture = await setup({ scanStatus: "pending" });

    const result = await runAttachmentAssetWorker(fixture.workId, {
      ...fixture.options,
      now: () => new Date("2026-08-01T08:20:00.000Z"),
      scanDeadline: new Date("2026-08-01T08:10:00.000Z")
    });

    expect(result).toEqual({ status: "scan_pending" });
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBeUndefined();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
  });

  it("keeps infected assets out of Graph and closes the requester work", async () => {
    const fixture = await setup({ scanStatus: "infected" });

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({
      status: "permanent_failure",
      failureCode: "scan_infected"
    });
    expect(fixture.assets.download).not.toHaveBeenCalled();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBe("failed");
  });

  it("resumes an existing Asset without redownloading the LINE source", async () => {
    const fixture = await setup();
    const claim = await fixture.store.claim(fixture.workId);
    await fixture.store.recordUploadDescriptor(fixture.workId, claim!.claimId!, descriptor);
    await fixture.store.recordAsset(fixture.workId, claim!.claimId!, "asset-1");
    await fixture.store.releaseForRetry(fixture.workId, claim!.claimId!);

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({ status: "completed", signatureHealth: "current" });
    expect(fixture.options.lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(fixture.assets.createUpload).not.toHaveBeenCalled();
    expect(fixture.assets.get).toHaveBeenCalledWith("asset-1");
  });

  it("recovers a completed Asset with the same work id before considering a source redownload", async () => {
    const fixture = await setup();
    const claim = await fixture.store.claim(fixture.workId);
    await fixture.store.recordUploadDescriptor(fixture.workId, claim!.claimId!, descriptor);
    await fixture.store.releaseForRetry(fixture.workId, claim!.claimId!);
    vi.mocked(fixture.assets.createUpload).mockResolvedValueOnce({
      asset: cleanAsset()
    });

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({ status: "completed", signatureHealth: "current" });
    expect(fixture.assets.createUpload).toHaveBeenCalledWith({
      workId: fixture.workId,
      lineMessageId: "line-message-1",
      fileName: "Sunday.pdf",
      mimeType: "application/pdf",
      maxSizeBytes: 14
    });
    expect(fixture.options.lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(fixture.assets.upload).not.toHaveBeenCalled();
    expect(fixture.assets.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["checksum", { checksumSha256: "0".repeat(64) }],
    ["size", { sizeBytes: 15 }],
    ["detected MIME", { detectedMimeType: "image/png" }]
  ])("permanently rejects an Asset %s mismatch", async (_label, override) => {
    const fixture = await setup();
    const claim = await fixture.store.claim(fixture.workId);
    await fixture.store.recordUploadDescriptor(fixture.workId, claim!.claimId!, descriptor);
    await fixture.store.recordAsset(fixture.workId, claim!.claimId!, "asset-1");
    await fixture.store.releaseForRetry(fixture.workId, claim!.claimId!);
    vi.mocked(fixture.assets.get).mockResolvedValueOnce({ ...cleanAsset(), ...override });

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({
      status: "permanent_failure",
      failureCode: "validation_failed"
    });
    expect(fixture.options.lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
  });

  it("releases a transient Asset dependency failure for queue redelivery", async () => {
    const fixture = await setup();
    const claim = await fixture.store.claim(fixture.workId);
    await fixture.store.recordUploadDescriptor(fixture.workId, claim!.claimId!, descriptor);
    await fixture.store.recordAsset(fixture.workId, claim!.claimId!, "asset-1");
    await fixture.store.releaseForRetry(fixture.workId, claim!.claimId!);
    vi.mocked(fixture.assets.get).mockRejectedValueOnce(new Error("temporary outage"));

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({
      status: "transient_retry",
      failureCode: "scan_unavailable"
    });
    await expect(fixture.store.claim(fixture.workId)).resolves.toMatchObject({ status: "claimed" });
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBeUndefined();
  });

  it("reports claim contention separately from scan pending", async () => {
    const fixture = await setup();
    await fixture.store.claim(fixture.workId);

    await expect(runAttachmentAssetWorker(fixture.workId, fixture.options)).resolves.toEqual({
      status: "contention"
    });
  });

  it("recovers after Asset completion wins but recording the Asset id crashes", async () => {
    let current = clock;
    const fixture = await setup({ now: () => current, claimLeaseMs: 60_000 });
    vi.spyOn(fixture.store, "recordAsset").mockResolvedValueOnce(false);

    await expect(runAttachmentAssetWorker(fixture.workId, fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.options.lineContent.getMessageContent).toHaveBeenCalledTimes(1);
    expect(fixture.assets.complete).toHaveBeenCalledTimes(1);

    current = new Date("2026-08-01T08:01:00.000Z");
    vi.mocked(fixture.assets.createUpload).mockResolvedValueOnce({ asset: cleanAsset() });

    await expect(runAttachmentAssetWorker(fixture.workId, fixture.options)).resolves.toEqual({
      status: "completed",
      signatureHealth: "current"
    });
    expect(fixture.options.lineContent.getMessageContent).toHaveBeenCalledTimes(1);
    expect(fixture.assets.upload).toHaveBeenCalledTimes(1);
  });

  it("does not republish after publication succeeds but the terminal state write is lost", async () => {
    let current = clock;
    const fixture = await setup({ now: () => current });
    vi.spyOn(fixture.store, "complete").mockResolvedValueOnce(false);

    await expect(runAttachmentAssetWorker(fixture.workId, fixture.options)).resolves.toEqual({
      status: "contention"
    });
    expect(fixture.publisher.publishVerifiedResource).toHaveBeenCalledTimes(1);

    current = new Date("2026-08-01T08:14:00.000Z");
    await expect(runAttachmentAssetWorker(fixture.workId, fixture.options)).resolves.toEqual({
      status: "permanent_failure",
      failureCode: "publication_abandoned"
    });
    expect(fixture.publisher.publishVerifiedResource).toHaveBeenCalledTimes(1);
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBe("failed");
  });

  it("makes a permanent Asset 4xx durable before queue acknowledgement", async () => {
    const fixture = await setup();
    const claim = await fixture.store.claim(fixture.workId);
    await fixture.store.recordUploadDescriptor(fixture.workId, claim!.claimId!, descriptor);
    await fixture.store.recordAsset(fixture.workId, claim!.claimId!, "asset-1");
    await fixture.store.releaseForRetry(fixture.workId, claim!.claimId!);
    const assets = createAssetApiClient({
      baseUrl: "https://asset.internal",
      getAccessToken: vi.fn().mockResolvedValue("token"),
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    });

    await expect(
      runAttachmentAssetWorker(fixture.workId, { ...fixture.options, assets })
    ).resolves.toEqual({
      status: "permanent_failure",
      failureCode: "scan_unavailable"
    });
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBe("failed");
    expect(fixture.options.lineContent.getMessageContent).not.toHaveBeenCalled();
  });

  it("reports expired or absent opaque work as missing", async () => {
    const fixture = await setup();

    await expect(runAttachmentAssetWorker("missing-work", fixture.options)).resolves.toEqual({
      status: "missing"
    });
  });
});

async function setup(
  input: {
    scanStatus?: AssetRecord["scanStatus"];
    now?: () => Date;
    claimLeaseMs?: number;
  } = {}
) {
  const now = input.now ?? (() => clock);
  const jobs = new InMemoryAgentJobStore({ now });
  const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
  const job = await jobs.createPending({ scope, label: "保存檔案", ttlMs: 30 * 60_000 });
  const store = new InMemoryAttachmentScanWorkStore({
    jobStore: jobs,
    now,
    idFactory: () => "work-1",
    claimIdFactory: () => "claim-1",
    claimLeaseMs: input.claimLeaseMs
  });
  const work = await store.create({
    jobId: job.id,
    lineMessageId: "line-message-1",
    scope,
    target: {
      sourceKey: "ppt_slides",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "Sunday"
    },
    ttlMs: 30 * 60_000
  });
  await store.markEnqueued(work.id);
  const terminalStatus = input.scanStatus ?? "clean";
  const assets: AssetApiClient = {
    createUpload: vi.fn().mockResolvedValue({
      asset: { id: "asset-1", uploadStatus: "created", scanStatus: "pending" },
      uploadTarget: { url: "https://blob/upload", method: "PUT", headers: {} }
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({
      id: "asset-1",
      uploadStatus: "completed",
      scanStatus: "pending",
      sizeBytes: descriptor.sizeBytes,
      checksumSha256: descriptor.checksumSha256,
      detectedMimeType: descriptor.mimeType
    }),
    grantServiceRead: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      id: "asset-1",
      uploadStatus: "completed",
      scanStatus: terminalStatus,
      sizeBytes: descriptor.sizeBytes,
      checksumSha256: descriptor.checksumSha256,
      detectedMimeType: descriptor.mimeType,
      ...(terminalStatus === "clean" ? { scanSignatureVersion: "main-1" } : {})
    }),
    download: vi.fn().mockResolvedValue({ data: pdf, contentType: "application/pdf" })
  };
  const publisher: ResourceBinaryPublisher = {
    publishVerifiedResource: vi.fn().mockResolvedValue({
      status: "published",
      result: {
        ok: true,
        executedAction: "save_resource",
        writePhase: "commit",
        replyText: "已保存檔案。"
      }
    })
  };
  return {
    workId: work.id,
    store,
    assets,
    publisher,
    options: {
      workStore: store,
      assets,
      lineContent: {
        getMessageContent: vi.fn().mockResolvedValue({ data: pdf, contentType: "application/pdf" })
      },
      profiles: [{ name: "helper", channelAccessToken: "token" }],
      publisher,
      maxBytes: 25 << 20,
      lineDownloadTimeoutMs: 30_000,
      scanDeadline: new Date("2026-08-01T08:10:00.000Z"),
      publicationDeadline: new Date("2026-08-01T08:14:00.000Z"),
      now,
      sleep: vi.fn().mockResolvedValue(undefined)
    }
  };
}

function cleanAsset(): AssetRecord {
  return {
    id: "asset-1",
    uploadStatus: "completed",
    scanStatus: "clean",
    scanSignatureVersion: "main-1",
    sizeBytes: descriptor.sizeBytes,
    checksumSha256: descriptor.checksumSha256,
    detectedMimeType: descriptor.mimeType
  };
}

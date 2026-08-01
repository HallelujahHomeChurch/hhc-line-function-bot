import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { runAttachmentAssetWorker } from "../attachments/asset-worker.js";
import { InMemoryAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import type { AssetApiClient, AssetRecord } from "../clients/asset-api.js";
import type { ResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";

const clock = new Date("2026-08-01T08:00:00.000Z");
const pdf = new TextEncoder().encode("%PDF-1.7\nclean");

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

    expect(result).toEqual({ status: "ignored", reason: "active" });
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBeUndefined();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
  });

  it("keeps infected assets out of Graph and closes the requester work", async () => {
    const fixture = await setup({ scanStatus: "infected" });

    const result = await runAttachmentAssetWorker(fixture.workId, fixture.options);

    expect(result).toEqual({
      status: "failed",
      failureCode: "scan_infected",
      infrastructureFailure: false
    });
    expect(fixture.assets.download).not.toHaveBeenCalled();
    expect(fixture.publisher.publishVerifiedResource).not.toHaveBeenCalled();
    await expect(fixture.store.terminalStatus(fixture.workId)).resolves.toBe("failed");
  });
});

async function setup(input: { scanStatus?: AssetRecord["scanStatus"] } = {}) {
  const jobs = new InMemoryAgentJobStore({ now: () => clock });
  const scope = { profileName: "helper", sourceKey: "group:C1", requesterUserId: "U1" };
  const job = await jobs.createPending({ scope, label: "保存檔案", ttlMs: 30 * 60_000 });
  const store = new InMemoryAttachmentScanWorkStore({
    jobStore: jobs,
    now: () => clock,
    idFactory: () => "work-1",
    claimIdFactory: () => "claim-1"
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
    complete: vi
      .fn()
      .mockResolvedValue({ id: "asset-1", uploadStatus: "completed", scanStatus: "pending" }),
    grantServiceRead: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      id: "asset-1",
      uploadStatus: "completed",
      scanStatus: terminalStatus,
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
      publicationDeadline: new Date("2026-08-01T08:15:00.000Z"),
      now: () => clock,
      sleep: vi.fn().mockResolvedValue(undefined)
    }
  };
}

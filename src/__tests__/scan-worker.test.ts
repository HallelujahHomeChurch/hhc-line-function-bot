import { access } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import {
  runAttachmentScanWorker,
  type AttachmentFileScanner,
  type ClamAvSignatureManifest
} from "../attachments/scan-worker.js";
import { InMemoryCatalogStore } from "../catalog/store.js";
import { createResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import type { BotProfileConfig, GraphDriveClient, LineContentClient } from "../types.js";

const now = new Date("2026-07-24T04:00:00.000Z");
const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const profile: BotProfileConfig = {
  name: "helper",
  webhookPath: "/api/line/webhook/helper",
  channelSecret: "secret",
  channelAccessToken: "token",
  allowDirectUser: true,
  allowRooms: false,
  allowedMessageTypes: ["text", "file"],
  groupRequireWakeWord: true,
  wakeKeywords: ["小哈"],
  acceptMention: true,
  enabledFunctions: ["save_resource"]
};
const freshSignature: ClamAvSignatureManifest = {
  version: 1,
  signatureVersion: "daily-20260724",
  lastSuccessfulAt: "2026-07-24T03:00:00.000Z",
  databaseDirectory: "sets/daily-20260724"
};

async function setup(
  options: {
    scanStatus?: "clean" | "infected" | "unavailable";
    signatureManifest?: ClamAvSignatureManifest;
    externalUrl?: string;
  } = {}
) {
  const agentJobStore = new InMemoryAgentJobStore({ now: () => now });
  const scope = {
    profileName: "helper",
    sourceKey: "group:C1",
    requesterUserId: "U1"
  };
  const job = await agentJobStore.createPending({
    scope,
    label: "保存檔案",
    ttlMs: 600_000
  });
  const workStore = new InMemoryAttachmentScanWorkStore({
    jobStore: agentJobStore,
    now: () => now,
    idFactory: () => "4c03465b-8a87-45a2-9d0d-54f904f4e6ab"
  });
  const work = await workStore.create({
    jobId: job.id,
    ...(options.externalUrl
      ? { externalUrl: options.externalUrl }
      : { lineMessageId: "line-message-opaque-id" }),
    scope,
    target: {
      sourceKey: "ppt_slides",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: "SundayDeck"
    },
    ttlMs: 600_000
  });
  await workStore.markEnqueued(work.id);
  const catalog = new InMemoryCatalogStore();
  await catalog.upsertSource({
    profileName: "helper",
    sourceKey: "ppt_slides",
    adapterType: "onedrive",
    domain: "presentation",
    defaultItemKind: "ppt_slide",
    rootLocation: { driveId: "drive-1", folderItemId: "ppt-root" },
    enabled: true,
    syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
    capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
  });
  const graph: GraphDriveClient = {
    listFolderChildren: vi.fn(),
    createSharingLink: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue({
      id: "uploaded-ppt",
      driveId: "drive-1",
      name: "SundayDeck.pptx",
      path: "SundayDeck.pptx"
    }),
    deleteItem: vi.fn().mockResolvedValue(undefined)
  };
  const lineContent: LineContentClient = {
    getMessageContent: vi.fn().mockResolvedValue({
      data: pptxBytes,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    })
  };
  const scanner: AttachmentFileScanner = {
    scan: vi.fn().mockResolvedValue({ status: options.scanStatus ?? "clean" })
  };
  const externalBinary = {
    download: vi.fn().mockResolvedValue({
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      finalUrl: options.externalUrl ?? "https://example.org/unused.pdf",
      fileName: "amazing-grace.pdf",
      contentType: "application/pdf"
    })
  };
  return {
    agentJobStore,
    scope,
    job,
    workStore,
    work,
    catalog,
    graph,
    lineContent,
    externalBinary,
    scanner,
    workerOptions: {
      workStore,
      lineContent,
      externalBinary,
      profiles: [profile],
      publisher: createResourceBinaryPublisher({ catalog, graph }),
      scanner,
      readSignatureManifest: vi.fn().mockResolvedValue(options.signatureManifest ?? freshSignature),
      databaseDirectory: "/var/lib/clamav/current",
      maxBytes: 25 * 1024 * 1024,
      lineDownloadTimeoutMs: 30_000,
      externalDownloadTimeoutMs: 15_000,
      externalMaxRedirects: 3,
      now: () => now
    }
  };
}

describe("attachment scan worker", () => {
  it("claims, downloads, scans, publishes, completes, and deletes its ephemeral file", async () => {
    const { agentJobStore, scope, job, graph, lineContent, scanner, work, workerOptions } =
      await setup();
    let ephemeralPath = "";
    vi.mocked(scanner.scan).mockImplementationOnce(async ({ filePath }) => {
      ephemeralPath = filePath;
      await expect(access(filePath)).resolves.toBeUndefined();
      return { status: "clean" };
    });

    const result = await runAttachmentScanWorker(work.id, workerOptions);

    expect(result).toEqual({ status: "completed" });
    expect(lineContent.getMessageContent).toHaveBeenCalledTimes(1);
    expect(scanner.scan).toHaveBeenCalledWith({
      filePath: expect.any(String),
      databaseDirectory: "/var/lib/clamav/current/sets/daily-20260724",
      timeoutMs: 15_000
    });
    expect(graph.uploadFile).toHaveBeenCalledTimes(1);
    await expect(agentJobStore.get(job.id, scope)).resolves.toMatchObject({
      status: "completed",
      result: { executedAction: "save_resource" }
    });
    await expect(access(ephemeralPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for an infected file", async () => {
    const { agentJobStore, scope, job, graph, work, workerOptions } = await setup({
      scanStatus: "infected"
    });

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toEqual({
      status: "failed",
      failureCode: "scan_infected",
      infrastructureFailure: false
    });

    expect(graph.uploadFile).not.toHaveBeenCalled();
    await expect(agentJobStore.get(job.id, scope)).resolves.toMatchObject({
      status: "failed",
      error: "scan_infected"
    });
  });

  it("downloads a confirmed direct external file only inside the worker", async () => {
    const { externalBinary, graph, lineContent, work, workerOptions } = await setup({
      externalUrl: "https://example.org/amazing-grace.pdf"
    });

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toEqual({
      status: "completed"
    });

    expect(externalBinary.download).toHaveBeenCalledWith({
      url: "https://example.org/amazing-grace.pdf",
      maxBytes: 25 * 1024 * 1024,
      timeoutMs: 15_000,
      maxRedirects: 3
    });
    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed when ClamAV times out", async () => {
    const { graph, scanner, work, workerOptions } = await setup();
    vi.mocked(scanner.scan).mockResolvedValueOnce({ status: "unavailable" });

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "scan_unavailable",
      infrastructureFailure: true
    });

    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("fails closed when the scanner executable is unavailable", async () => {
    const { graph, scanner, work, workerOptions } = await setup();
    vi.mocked(scanner.scan).mockRejectedValueOnce(new Error("scanner missing"));

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "scan_unavailable",
      infrastructureFailure: true
    });

    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects a stale signature before scanning or publishing", async () => {
    const { graph, scanner, work, workerOptions } = await setup({
      signatureManifest: {
        ...freshSignature,
        lastSuccessfulAt: "2026-07-20T03:00:00.000Z"
      }
    });

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "signature_stale",
      infrastructureFailure: true
    });

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("re-reads the replaced signature manifest immediately before publishing", async () => {
    const { graph, scanner, work, workerOptions } = await setup();
    const readSignatureManifest = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(freshSignature)
      .mockResolvedValueOnce({
        ...freshSignature,
        lastSuccessfulAt: "2026-07-20T03:00:00.000Z"
      });
    workerOptions.readSignatureManifest = readSignatureManifest;

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "signature_stale",
      infrastructureFailure: true
    });

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(graph.uploadFile).not.toHaveBeenCalled();
    expect(readSignatureManifest).toHaveBeenCalledTimes(2);
  });

  it("does not publish a scan when the active signature set changes during execution", async () => {
    const { graph, scanner, work, workerOptions } = await setup();
    workerOptions.readSignatureManifest = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(freshSignature)
      .mockResolvedValueOnce({
        ...freshSignature,
        signatureVersion: "daily-20260725",
        databaseDirectory: "sets/daily-20260725"
      });

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "signature_stale",
      infrastructureFailure: true
    });

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("does not download or publish duplicate claimed work", async () => {
    const { graph, lineContent, work, workerOptions } = await setup();

    await runAttachmentScanWorker(work.id, workerOptions);
    vi.mocked(graph.uploadFile).mockClear();
    vi.mocked(lineContent.getMessageContent).mockClear();

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toEqual({
      status: "ignored",
      reason: "not_claimed"
    });

    expect(lineContent.getMessageContent).not.toHaveBeenCalled();
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("marks Graph upload failure as an infrastructure failure", async () => {
    const { agentJobStore, scope, job, graph, work, workerOptions } = await setup();
    vi.mocked(graph.uploadFile!).mockRejectedValueOnce(new Error("graph unavailable"));

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "publish_failed",
      infrastructureFailure: true
    });
    await expect(agentJobStore.get(job.id, scope)).resolves.toMatchObject({
      status: "failed",
      error: "publish_failed"
    });
  });

  it("compensates Graph and marks catalog failure as infrastructure failure", async () => {
    const { catalog, graph, work, workerOptions } = await setup();
    vi.spyOn(catalog, "upsertItem").mockRejectedValueOnce(new Error("catalog unavailable"));

    await expect(runAttachmentScanWorker(work.id, workerOptions)).resolves.toMatchObject({
      status: "failed",
      failureCode: "publish_failed",
      infrastructureFailure: true
    });

    expect(graph.uploadFile).toHaveBeenCalledTimes(1);
    expect(graph.deleteItem).toHaveBeenCalledWith("drive-1", "uploaded-ppt");
  });
});

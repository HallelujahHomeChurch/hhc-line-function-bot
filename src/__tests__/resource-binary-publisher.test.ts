import { describe, expect, it, vi } from "vitest";

import { InMemoryCatalogStore } from "../catalog/store.js";
import {
  createResourceBinaryPublisher,
  prepareResourceBinary
} from "../functions/resource-binary-publisher.js";
import type { GraphDriveClient } from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const target = {
  profileName: "helper",
  sourceKey: "ppt_slides",
  itemKind: "ppt_slide" as const,
  domain: "presentation",
  title: "SundayDeck"
};

async function setup() {
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
    deleteItem: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({
      id: "uploaded-ppt",
      driveId: "drive-1",
      name: "SundayDeck.pptx",
      path: "SundayDeck.pptx"
    })
  };
  return {
    catalog,
    graph,
    publisher: createResourceBinaryPublisher({ catalog, graph })
  };
}

function prepare() {
  const result = prepareResourceBinary({
    binary: {
      data: pptxBytes,
      declaredFileName: "OriginalDeck.pptx",
      declaredContentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sourceKind: "line"
    },
    target,
    maxBytes: 25 * 1024 * 1024
  });
  if (!result.ok) {
    throw new Error(`unexpected preparation failure: ${result.result.replyText}`);
  }
  return result.resource;
}

describe("resource binary publisher", () => {
  it("validates and prepares bytes without scanning or publishing them", () => {
    const prepared = prepare();

    expect(prepared).toMatchObject({
      target,
      fileName: "SundayDeck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      sizeBytes: pptxBytes.byteLength
    });
    expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("compensates the OneDrive upload when catalog publication fails", async () => {
    const { catalog, graph, publisher } = await setup();
    vi.spyOn(catalog, "upsertItem").mockRejectedValueOnce(new Error("db unavailable"));
    graph.deleteItem = vi.fn().mockResolvedValue(undefined);

    const outcome = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result.writePhase).toBeUndefined();
    expect(outcome.result.replyText).toContain("沒有完成保存");
    expect(graph.deleteItem).toHaveBeenCalledWith("drive-1", "uploaded-ppt");
  });

  it("does not expose the backing publish provider when upload is unavailable", async () => {
    const { catalog, graph } = await setup();
    graph.uploadFile = undefined;
    const publisher = createResourceBinaryPublisher({ catalog, graph });

    const outcome = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result.replyText).toContain("檔案發布服務");
    expect(outcome.result.replyText).not.toContain("OneDrive");
  });

  it("treats Graph 404 and an already tombstoned catalog owner as idempotent cleanup", async () => {
    const { graph, publisher } = await setup();
    const outcome = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });
    if (outcome.status !== "published") throw new Error("expected published resource");
    graph.deleteItem = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { statusCode: 404 }));

    await expect(
      publisher.tombstonePublishedResource(outcome.resourceId, new Date("2026-07-11T10:01:00.000Z"))
    ).resolves.toBe(true);
    await expect(
      publisher.tombstonePublishedResource(outcome.resourceId, new Date("2026-07-11T10:02:00.000Z"))
    ).resolves.toBe(true);
    expect(graph.deleteItem).toHaveBeenCalledTimes(1);
  });

  it("treats a missing catalog owner as already cleaned", async () => {
    const { publisher } = await setup();

    await expect(
      publisher.tombstonePublishedResource("missing-resource", new Date("2026-07-11T10:00:00.000Z"))
    ).resolves.toBe(true);
  });

  it("uploads and indexes a verified binary exactly once", async () => {
    const { catalog, graph, publisher } = await setup();

    const outcome = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(outcome.status).toBe("published");
    expect(outcome.result).toMatchObject({ executedAction: "save_resource" });
    expect(graph.uploadFile).toHaveBeenCalledTimes(1);
    const indexed = await catalog.searchItems({
      profileName: "helper",
      query: "SundayDeck",
      itemKinds: ["ppt_slide"]
    });
    expect(indexed).toHaveLength(1);
    expect(outcome.result.agentResult?.anchors?.resourceId).toBe(indexed[0].id);
    expect(outcome.result.agentResult?.anchors?.resourceId).not.toBe("uploaded-ppt");
    expect(outcome.resourceId).toBe(indexed[0].id);
  });

  it("owner-loads and tombstones an exact resource ID independent of search visibility", async () => {
    const { catalog, publisher } = await setup();
    const outcome = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });
    if (outcome.status !== "published") throw new Error("expected publication");

    await catalog.updateSourceEnabled({
      profileName: "helper",
      sourceKey: "ppt_slides",
      enabled: false
    });
    await expect(
      catalog.searchItems({ profileName: "helper", itemIds: [outcome.resourceId] })
    ).resolves.toEqual([]);
    await expect(catalog.getItemById(outcome.resourceId)).resolves.toMatchObject({
      id: outcome.resourceId
    });

    await expect(
      publisher.tombstonePublishedResource(outcome.resourceId, new Date("2026-07-11T10:01:00.000Z"))
    ).resolves.toBe(true);
    await expect(catalog.getItemById(outcome.resourceId)).resolves.toMatchObject({
      id: outcome.resourceId,
      deletedAt: "2026-07-11T10:01:00.000Z"
    });
  });

  it("returns the existing actual resource ID for a duplicate", async () => {
    const { publisher } = await setup();
    const first = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:00:00.000Z")
    });
    if (first.status !== "published") throw new Error("expected publication");

    const duplicate = await publisher.publishVerifiedResource({
      resource: prepare(),
      scan: { status: "clean", signatureVersion: "daily-20260724" },
      now: new Date("2026-07-11T10:01:00.000Z")
    });

    expect(duplicate).toMatchObject({ status: "duplicate", resourceId: first.resourceId });
  });
});

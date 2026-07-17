import { describe, expect, it, vi } from "vitest";

import { InMemoryCatalogStore } from "../catalog/store.js";
import { createResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import type { GraphDriveClient, VirusScanner } from "../types.js";

const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

async function setup(scanStatus: "clean" | "infected" | "unavailable" = "clean") {
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
    })
  };
  const scanner: VirusScanner = {
    scan: vi.fn().mockResolvedValue({ status: scanStatus })
  };
  return {
    catalog,
    graph,
    scanner,
    publisher: createResourceBinaryPublisher({
      catalog,
      graph,
      scanner,
      maxBytes: 25 * 1024 * 1024
    })
  };
}

describe("resource binary publisher", () => {
  it("compensates the OneDrive upload when catalog publication fails", async () => {
    const { catalog, graph, scanner } = await setup();
    vi.spyOn(catalog, "upsertItem").mockRejectedValueOnce(new Error("db unavailable"));
    graph.deleteItem = vi.fn().mockResolvedValue(undefined);
    const publisher = createResourceBinaryPublisher({
      catalog,
      graph,
      scanner,
      maxBytes: 25 * 1024 * 1024
    });

    const result = await publisher.publish({
      binary: {
        data: pptxBytes,
        declaredFileName: "OriginalDeck.pptx",
        declaredContentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sourceKind: "line"
      },
      target: {
        profileName: "helper",
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(result.writePhase).toBeUndefined();
    expect(result.replyText).toContain("沒有完成保存");
    expect(graph.deleteItem).toHaveBeenCalledWith("drive-1", "uploaded-ppt");
  });

  it("fails closed when scanning is not clean", async () => {
    const { graph, publisher } = await setup("unavailable");

    const result = await publisher.publish({
      binary: {
        data: pptxBytes,
        declaredFileName: "OriginalDeck.pptx",
        declaredContentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sourceKind: "line"
      },
      target: {
        profileName: "helper",
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(result.replyText).toContain("掃毒服務目前不可用");
    expect(graph.uploadFile).not.toHaveBeenCalled();
  });

  it("uploads and indexes a validated binary exactly once", async () => {
    const { catalog, graph, scanner, publisher } = await setup();

    const result = await publisher.publish({
      binary: {
        data: pptxBytes,
        declaredFileName: "OriginalDeck.pptx",
        declaredContentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sourceKind: "line"
      },
      target: {
        profileName: "helper",
        sourceKey: "ppt_slides",
        itemKind: "ppt_slide",
        domain: "presentation",
        title: "SundayDeck"
      },
      now: new Date("2026-07-11T10:00:00.000Z")
    });

    expect(result).toMatchObject({ executedAction: "save_resource" });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(graph.uploadFile).toHaveBeenCalledTimes(1);
    const indexed = await catalog.searchItems({
      profileName: "helper",
      query: "SundayDeck",
      itemKinds: ["ppt_slide"]
    });
    expect(indexed).toHaveLength(1);
    expect(result.agentResult?.anchors?.resourceId).toBe(indexed[0].id);
    expect(result.agentResult?.anchors?.resourceId).not.toBe("uploaded-ppt");
    await expect(
      catalog.searchItems({
        profileName: "helper",
        query: "SundayDeck",
        itemKinds: ["ppt_slide"]
      })
    ).resolves.toHaveLength(1);
  });
});

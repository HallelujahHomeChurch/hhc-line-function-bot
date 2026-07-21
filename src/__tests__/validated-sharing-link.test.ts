import { describe, expect, it, vi } from "vitest";

import { createValidatedSharingLink } from "../functions/validated-sharing-link.js";
import type { GraphDriveClient } from "../types.js";

describe("validated sharing links", () => {
  it("fails closed when current-item validation is unavailable", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/unsafe")
    };

    await expect(
      createValidatedSharingLink({
        graph,
        driveId: "drive-1",
        itemId: "item-without-validator",
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    ).resolves.toEqual({ status: "unavailable", reason: "validator_unavailable" });
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("fails closed when the current Graph item no longer exists", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      getItemById: vi.fn().mockResolvedValue(undefined),
      createSharingLink: vi.fn()
    };

    await expect(
      createValidatedSharingLink({
        graph,
        driveId: "drive-1",
        itemId: "deleted-item",
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    ).resolves.toEqual({ status: "unavailable", reason: "item_missing" });
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("validates the current item before creating a new temporary link", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      getItemById: vi.fn().mockResolvedValue({ id: "item-1", name: "現行檔案.pdf" }),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/current")
    };

    await expect(
      createValidatedSharingLink({
        graph,
        driveId: "drive-1",
        itemId: "item-1",
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "available",
      item: { id: "item-1", name: "現行檔案.pdf" },
      link: "https://download.invalid/current"
    });
    expect(graph.getItemById).toHaveBeenCalledBefore(vi.mocked(graph.createSharingLink));
  });

  it("fails closed when Graph reports the current item as deleted", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      getItemById: vi.fn().mockResolvedValue({
        id: "deleted-item",
        name: "已刪除.pdf",
        deleted: true
      }),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/deleted")
    };

    await expect(
      createValidatedSharingLink({
        graph,
        driveId: "drive-1",
        itemId: "deleted-item",
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    ).resolves.toEqual({ status: "unavailable", reason: "item_deleted" });
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });

  it("fails closed when current-item validation errors", async () => {
    const graph: GraphDriveClient = {
      listFolderChildren: vi.fn(),
      getItemById: vi.fn().mockRejectedValue(new Error("graph_unavailable")),
      createSharingLink: vi.fn().mockResolvedValue("https://download.invalid/unsafe")
    };

    await expect(
      createValidatedSharingLink({
        graph,
        driveId: "drive-1",
        itemId: "item-1",
        expiresAt: "2026-07-21T00:00:00.000Z"
      })
    ).resolves.toEqual({ status: "unavailable", reason: "validation_failed" });
    expect(graph.createSharingLink).not.toHaveBeenCalled();
  });
});

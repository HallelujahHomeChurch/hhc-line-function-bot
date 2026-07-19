import { describe, expect, it, vi } from "vitest";

import { createValidatedSharingLink } from "../functions/validated-sharing-link.js";
import type { GraphDriveClient } from "../types.js";

describe("validated sharing links", () => {
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
    ).resolves.toEqual({});
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
      item: { id: "item-1", name: "現行檔案.pdf" },
      link: "https://download.invalid/current"
    });
    expect(graph.getItemById).toHaveBeenCalledBefore(vi.mocked(graph.createSharingLink));
  });
});

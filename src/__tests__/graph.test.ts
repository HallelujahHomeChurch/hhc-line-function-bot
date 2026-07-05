import { describe, expect, it } from "vitest";

import { resolveDriveItemTraversalTarget } from "../clients/graph.js";

describe("Graph drive traversal", () => {
  it("uses remoteItem target ids when traversing OneDrive shortcut folders", () => {
    const target = resolveDriveItemTraversalTarget(
      {
        id: "shortcut-id",
        driveId: "source-drive",
        name: "流行歌譜 (捷徑)",
        isFolder: true,
        remoteItem: {
          id: "remote-folder-id",
          parentReference: {
            driveId: "remote-drive"
          }
        }
      },
      "fallback-drive"
    );

    expect(target).toEqual({ driveId: "remote-drive", itemId: "remote-folder-id" });
  });

  it("falls back to the item drive when a folder is not a shortcut", () => {
    const target = resolveDriveItemTraversalTarget(
      {
        id: "folder-id",
        driveId: "drive-id",
        name: "一般資料夾",
        isFolder: true
      },
      "fallback-drive"
    );

    expect(target).toEqual({ driveId: "drive-id", itemId: "folder-id" });
  });
});

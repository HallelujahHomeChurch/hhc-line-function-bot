import { beforeEach, describe, expect, it, vi } from "vitest";

const graph = vi.hoisted(() => ({
  api: vi.fn()
}));

vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {}
}));

vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: {
    initWithMiddleware: () => ({ api: graph.api })
  },
  RetryHandlerOptions: class {
    readonly maxRetries: number;

    constructor(_delay: number, maxRetries: number) {
      this.maxRetries = maxRetries;
    }
  }
}));

import { createGraphDriveClient, resolveDriveItemTraversalTarget } from "../clients/graph.js";

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  driveId: "drive",
  pptFolderItemId: "ppt",
  sheetMusicAllowedExtensions: [".pdf"],
  allowedExtensions: [".pdf"],
  defaultIncludePdf: true,
  linkType: "view" as const,
  linkScope: "organization" as const
};

describe("Graph drive traversal", () => {
  beforeEach(() => {
    graph.api.mockReset();
  });

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

describe("Graph diagnostics folder", () => {
  beforeEach(() => {
    graph.api.mockReset();
  });

  it("creates the folder once with conflict-safe semantics", async () => {
    const post = vi.fn().mockResolvedValue({
      id: "diagnostics-id",
      name: "assurance-diagnostics",
      folder: {},
      parentReference: { driveId: "drive-1" }
    });
    graph.api.mockReturnValue({ post });
    const client = createGraphDriveClient(CONFIG);

    const item = await client.ensureFolder!("drive-1", "parent-1", "assurance-diagnostics");

    expect(item).toEqual({
      id: "diagnostics-id",
      driveId: "drive-1",
      name: "assurance-diagnostics",
      isFolder: true
    });
    expect(graph.api).toHaveBeenCalledOnce();
    expect(graph.api).toHaveBeenCalledWith("/drives/drive-1/items/parent-1/children");
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      name: "assurance-diagnostics",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail"
    });
  });

  it("resolves one existing folder read after a create conflict without retrying", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("private"), { statusCode: 409 }));
    const get = vi.fn().mockResolvedValue({
      id: "existing-id",
      name: "assurance-diagnostics",
      folder: {},
      parentReference: { driveId: "drive-1" }
    });
    graph.api.mockReturnValueOnce({ post }).mockReturnValueOnce({ get });
    const client = createGraphDriveClient(CONFIG);

    const item = await client.ensureFolder!("drive-1", "parent-1", "assurance-diagnostics");

    expect(item.id).toBe("existing-id");
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(graph.api).toHaveBeenNthCalledWith(
      2,
      "/drives/drive-1/items/parent-1:/assurance-diagnostics?$select=id,name,webUrl,folder,parentReference"
    );
  });

  it("applies a zero-retry middleware option only when the caller requests it", async () => {
    const request = {
      middlewareOptions: vi.fn(),
      get: vi.fn().mockResolvedValue({
        id: "item-1",
        name: "item",
        parentReference: { driveId: "drive-1" }
      })
    };
    request.middlewareOptions.mockReturnValue(request);
    graph.api.mockReturnValue(request);

    const noRetryClient = createGraphDriveClient(CONFIG, { noRetry: true });
    await noRetryClient.getItemById!("drive-1", "item-1");

    expect(request.middlewareOptions).toHaveBeenCalledOnce();
    const [options] = request.middlewareOptions.mock.calls[0] as [[{ maxRetries: number }]];
    expect(options).toHaveLength(1);
    expect(options[0]?.maxRetries).toBe(0);

    request.middlewareOptions.mockClear();
    const defaultClient = createGraphDriveClient(CONFIG);
    await defaultClient.getItemById!("drive-1", "item-1");

    expect(request.middlewareOptions).not.toHaveBeenCalled();
  });
});

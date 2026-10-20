import { beforeEach, describe, expect, it, vi } from "vitest";

const graph = vi.hoisted(() => ({
  api: vi.fn(),
  token: vi.fn(),
  auth: undefined as unknown as { getAccessToken(): Promise<string> }
}));

vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    getToken(...args: unknown[]) {
      return graph.token(...args);
    }
  }
}));

vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: {
    initWithMiddleware: (options: { authProvider: typeof graph.auth }) => {
      graph.auth = options.authProvider;
      return { api: graph.api };
    }
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

describe("job-owned Graph cancellation", () => {
  it("forwards the signal and stops pagination after a late page", async () => {
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    const request = {
      option: vi.fn(),
      middlewareOptions: vi.fn(),
      get: vi.fn(async () => {
        controller.abort(reason);
        return { value: [], "@odata.nextLink": "https://graph.microsoft.com/next" };
      })
    };
    request.option.mockReturnValue(request);
    request.middlewareOptions.mockReturnValue(request);
    graph.api.mockReset().mockReturnValue(request);
    const client = createGraphDriveClient(CONFIG, { signal: controller.signal, noRetry: true });
    await expect(client.listFolderChildren("drive", "folder")).rejects.toBe(reason);
    expect(request.option).toHaveBeenCalledWith("signal", controller.signal);
    expect(graph.api).toHaveBeenCalledOnce();
    expect(request.middlewareOptions.mock.calls[0]?.[0][0].maxRetries).toBe(0);
  });
  it("does not pretend ignored auth aborted while PG shutdown can start independently", async () => {
    const { createCatalogSyncPostgres } = await import("../tools/catalog-sync-postgres.js");
    const controller = new AbortController();
    const reason = new Error("job_stopped");
    const pg = createCatalogSyncPostgres(
      { url: "postgres://fixture.invalid/test", ssl: false },
      { signal: controller.signal, deadline: Date.now() + 540_000 }
    );
    const end = vi.spyOn(pg.pool, "end");
    const token = Promise.withResolvers<{ token: string }>();
    graph.token.mockReturnValue(token.promise);
    const request = {
      option: vi.fn(),
      get: vi.fn(async () => {
        await graph.auth.getAccessToken();
        return { value: [] };
      })
    };
    request.option.mockReturnValue(request);
    graph.api.mockReset().mockReturnValue(request);
    const client = createGraphDriveClient(CONFIG, { signal: controller.signal });
    let settled = false;
    const work = client.listFolderChildren("drive", "folder").then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(graph.token).toHaveBeenCalled());
    controller.abort(reason);
    await pg.close();
    const early = settled;
    token.resolve({ token: "fixture" });
    expect(await work).toBe(reason);
    expect(early).toBe(false);
    expect(end).toHaveBeenCalledOnce();
    expect(graph.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", {
      abortSignal: controller.signal
    });
  });
});

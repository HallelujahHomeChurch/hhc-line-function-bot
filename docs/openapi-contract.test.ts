import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Operation = {
  tags?: unknown;
  security?: unknown;
  [key: `x-hhc-${string}`]: unknown;
};

type OpenApiDocument = {
  openapi?: unknown;
  paths?: Record<string, Record<string, Operation>>;
  [key: `x-hhc-${string}`]: unknown;
};

const methods = new Set(["delete", "get", "patch", "post", "put"]);
const expectedOperations = [
  "GET /api/line/media-sync/acl-subjects",
  "GET /api/line/media-sync/collections",
  "DELETE /api/line/media-sync/collections/{collectionId}",
  "PATCH /api/line/media-sync/collections/{collectionId}",
  "POST /api/line/media-sync/collections",
  "POST /api/line/media-sync/collections/{collectionId}/acl",
  "DELETE /api/line/media-sync/collections/{collectionId}/acl/{aclId}",
  "POST /api/line/media-sync/collections/{collectionId}/binding-code",
  "GET /api/line/media-sync/collections/{collectionId}/items",
  "PATCH /api/line/media-sync/collections/{collectionId}/items/{itemId}",
  "POST /api/line/media-sync/collections/{collectionId}/items/content-tickets",
  "POST /api/line/media-sync/collections/{collectionId}/items/delete",
  "POST /api/line/media-sync/collections/{collectionId}/items/retention",
  "PATCH /api/line/media-sync/collections/{collectionId}/retention",
  "POST /api/line/webhook/{profileName}",
  "GET /healthz",
  "GET /readyz"
].sort();

describe("LINE Function Bot OpenAPI contract", () => {
  let directory: string;
  let document: OpenApiDocument;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "line-openapi-"));
    const output = join(directory, "openapi.json");
    const result = spawnSync(
      "pnpm",
      [
        "--package=@redocly/cli@2.47.0",
        "dlx",
        "redocly",
        "bundle",
        "docs/openapi.yaml",
        "--ext=json",
        `--output=${output}`
      ],
      { encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    document = JSON.parse(await readFile(output, "utf8")) as OpenApiDocument;
  }, 30_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("matches the registered HTTP method and path surface", () => {
    const actual = Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
      Object.keys(pathItem)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`)
    );
    expect(actual.sort()).toEqual(expectedOperations);
  });

  it("requires catalog metadata and one matching visibility tag per operation", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document["x-hhc-service"]).toBe("hhc-line-function-bot");
    expect(document["x-hhc-owner"]).toBe("HHC Platform");
    expect(document["x-hhc-repository"]).toBe("HallelujahHomeChurch/hhc-line-function-bot");

    for (const pathItem of Object.values(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method)) continue;
        expect(operation.tags).toHaveLength(1);
        expect(operation.tags).toEqual([
          `${operation["x-hhc-visibility"]}`.replace(/^./u, (value) => value.toUpperCase())
        ]);
        expect(Array.isArray(operation["x-hhc-callers"])).toBe(true);
      }
    }
  });

  it("documents the LINE signature and media-sync trust boundaries", () => {
    const webhook = document.paths?.["/api/line/webhook/{profileName}"]?.post;
    expect(webhook?.security).toEqual([{ lineSignature: [] }]);
    expect(webhook?.["x-hhc-callers"]).toEqual(["LINE"]);

    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      if (!path.startsWith("/api/line/media-sync/")) continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method)) continue;
        expect(operation.tags).toEqual(["Admin"]);
        expect(operation["x-hhc-callers"]).toEqual(["admin-fe"]);
        expect(operation.security).toEqual([
          { gatewayCaller: [], appApiToken: [], trustedUser: [] }
        ]);
      }
    }
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Operation = {
  tags?: unknown;
  security?: unknown;
  responses?: Record<string, unknown>;
  [key: `x-hhc-${string}`]: unknown;
};

type Schema = {
  type?: unknown;
  format?: unknown;
  pattern?: unknown;
  description?: unknown;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  allOf?: Schema[];
  not?: Schema;
};

type OpenApiDocument = {
  openapi?: unknown;
  paths?: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, Schema>;
    responses?: Record<string, { description?: unknown }>;
  };
  [key: `x-hhc-${string}`]: unknown;
};

const methods = new Set(["delete", "get", "patch", "post", "put"]);
const visibilities = new Set(["public", "admin", "private", "operations"]);
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
const assetBackedOperations = expectedOperations.filter(
  (value) => value.includes("/api/line/media-sync/") && !value.includes("/acl-subjects")
);

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
        expect(visibilities.has(`${operation["x-hhc-visibility"]}`)).toBe(true);
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

  it("matches real webhook acknowledgements and downstream media error statuses", () => {
    const acknowledgement = document.components?.schemas?.WebhookAcknowledgement;
    expect(acknowledgement?.properties?.ignored?.oneOf).toEqual([
      { type: "boolean", const: true },
      { type: "string" }
    ]);

    for (const value of assetBackedOperations) {
      const [method, path] = value.split(" ");
      const responses = document.paths?.[path]?.[method.toLowerCase()]?.responses;
      expect(Object.keys(responses ?? {}), value).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "429", "502", "503"])
      );
    }
    expect(`${document.components?.responses?.AssetUnauthorized?.description}`).toContain("Asset");
    expect(`${document.components?.responses?.AssetForbidden?.description}`).toContain("Asset");
  });

  it("matches media-sync UUID and item-name request constraints", () => {
    const userId = document.components?.schemas?.HhcUserId;
    expect(userId?.format).toBe("uuid");
    expect(userId?.pattern).toBe(
      "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"
    );

    const displayName = document.components?.schemas?.ItemNameRequest?.properties?.displayName;
    expect(displayName?.not?.pattern).toBe("[/\\\\]|\\p{Cc}|[\\uD800-\\uDFFF]");
    expect(`${displayName?.description}`).toContain("255 UTF-8 bytes");
  });
});

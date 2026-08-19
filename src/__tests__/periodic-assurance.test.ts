import { describe, expect, it, vi } from "vitest";

import {
  mapPeriodicAssuranceCodeToReport,
  runPeriodicAssurance,
  type PeriodicAssuranceDependencies,
  type PeriodicAssuranceInput
} from "../assurance/periodic-probe.js";
import { buildAssuranceReport } from "../assurance/report.js";
import type { AssetApiClient } from "../clients/asset-api.js";
import {
  createPeriodicAssuranceDependencies,
  readOneNotionResult,
  runPeriodicAssuranceCli
} from "../tools/run-periodic-assurance.js";

const NOW = new Date("2026-07-27T01:00:00.000Z");
const INPUT: PeriodicAssuranceInput = {
  graphDriveId: "drive-1",
  graphOtherFolderItemId: "other-folder",
  notionDatabaseId: "notion-data-source",
  clamavSignatureManifestPath: "/var/lib/clamav/manifest.json",
  scanTimeoutMs: 15_000
};
const MANIFEST = {
  version: 1,
  signatureVersion: "20260727",
  lastSuccessfulAt: "2026-07-27T00:00:00.000Z",
  databaseDirectory: "sets/20260727"
};
const PERIODIC_FAILURE_CODES = [
  "graph_metadata_failed",
  "notion_query_failed",
  "attachment_queue_failed",
  "clamav_manifest_invalid",
  "clamav_clean_failed",
  "clamav_eicar_failed",
  "diagnostic_folder_failed",
  "diagnostic_upload_failed",
  "diagnostic_delete_failed",
  "asset_lifecycle_failed",
  "asset_cleanup_failed"
] as const;

function dependencies(): PeriodicAssuranceDependencies {
  return {
    readGraphMetadata: vi.fn().mockResolvedValue({
      id: "other-folder",
      name: "other",
      isFolder: true
    }),
    readNotionOne: vi.fn().mockResolvedValue(1),
    inspectQueue: vi.fn().mockResolvedValue({
      depth: 3,
      oldestInsertedAt: new Date("2026-07-27T00:58:30.000Z")
    }),
    readSignatureManifest: vi.fn().mockResolvedValue(MANIFEST),
    scanSample: vi.fn().mockImplementation(async ({ kind }) => ({
      status: kind === "clean" ? "clean" : "infected"
    })),
    ensureDiagnosticsFolder: vi.fn().mockResolvedValue({
      id: "diagnostics-folder",
      name: "assurance-diagnostics",
      isFolder: true
    }),
    uploadDiagnostic: vi.fn().mockResolvedValue({
      id: "diagnostic-item",
      name: "periodic-assurance.txt"
    }),
    deleteDiagnostic: vi.fn().mockResolvedValue(undefined),
    runAssetLifecycle: vi.fn().mockResolvedValue({ status: "passed", code: "none" }),
    now: () => new Date(NOW)
  };
}

describe("periodic assurance", () => {
  it("runs each bounded dependency once and returns only sanitized observations", async () => {
    const deps = dependencies();

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result).toEqual({
      status: "passed",
      checks: [
        { name: "graph_metadata", status: "passed", code: "none" },
        { name: "notion_query", status: "passed", code: "none" },
        { name: "attachment_queue", status: "passed", code: "none" },
        { name: "clamav_signature", status: "passed", code: "none" },
        { name: "clamav_clean", status: "passed", code: "none" },
        { name: "clamav_eicar", status: "passed", code: "none" },
        { name: "diagnostic_write_delete", status: "passed", code: "none" },
        { name: "asset_lifecycle", status: "passed", code: "none" }
      ],
      queue: { depth: 3, oldestAgeSeconds: 90 },
      providerRequests: { deepseek: 0, embedding: 0 }
    });
    expect(deps.readGraphMetadata).toHaveBeenCalledOnce();
    expect(deps.readGraphMetadata).toHaveBeenCalledWith("drive-1", "other-folder");
    expect(deps.readNotionOne).toHaveBeenCalledOnce();
    expect(deps.readNotionOne).toHaveBeenCalledWith("notion-data-source", 1);
    expect(deps.inspectQueue).toHaveBeenCalledOnce();
    expect(deps.readSignatureManifest).toHaveBeenCalledOnce();
    expect(deps.readSignatureManifest).toHaveBeenCalledWith("/var/lib/clamav/manifest.json");
    expect(deps.scanSample).toHaveBeenCalledTimes(2);
    expect(deps.ensureDiagnosticsFolder).toHaveBeenCalledOnce();
    expect(deps.ensureDiagnosticsFolder).toHaveBeenCalledWith(
      "drive-1",
      "other-folder",
      "assurance-diagnostics"
    );
    expect(deps.uploadDiagnostic).toHaveBeenCalledOnce();
    expect(deps.uploadDiagnostic).toHaveBeenCalledWith(
      "drive-1",
      "diagnostics-folder",
      "periodic-assurance.txt",
      new TextEncoder().encode("HHC periodic assurance\n"),
      "text/plain"
    );
    expect(deps.deleteDiagnostic).toHaveBeenCalledOnce();
    expect(deps.deleteDiagnostic).toHaveBeenCalledWith("drive-1", "diagnostic-item");
    expect(deps.runAssetLifecycle).toHaveBeenCalledOnce();
  });

  it("makes sanitized Asset cleanup failure fail the periodic report", async () => {
    const deps = dependencies();
    vi.mocked(deps.runAssetLifecycle).mockResolvedValue({
      status: "failed",
      code: "asset_cleanup_failed"
    });

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "asset_lifecycle")).toEqual({
      name: "asset_lifecycle",
      status: "failed",
      code: "asset_cleanup_failed"
    });
    expect(JSON.stringify(result)).not.toMatch(/token|sas|https:/iu);
  });

  it("accepts the clean sample and requires the EICAR sample to be rejected", async () => {
    const deps = dependencies();

    await runPeriodicAssurance(INPUT, deps);

    expect(deps.scanSample).toHaveBeenNthCalledWith(1, {
      kind: "clean",
      fileName: "periodic-clean.txt",
      data: new TextEncoder().encode("HHC periodic assurance\n"),
      databaseDirectory: "/var/lib/clamav/sets/20260727",
      timeoutMs: 15_000
    });
    expect(deps.scanSample).toHaveBeenNthCalledWith(2, {
      kind: "eicar",
      fileName: "periodic-eicar.txt",
      data: new TextEncoder().encode(
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
      ),
      databaseDirectory: "/var/lib/clamav/sets/20260727",
      timeoutMs: 15_000
    });
  });

  it("always attempts deletion after a successful upload and sanitizes cleanup failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.deleteDiagnostic).mockRejectedValue(new Error("private Graph adapter details"));

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(deps.deleteDiagnostic).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "diagnostic_write_delete")).toEqual({
      name: "diagnostic_write_delete",
      status: "failed",
      code: "diagnostic_delete_failed"
    });
    expect(JSON.stringify(result)).not.toContain("private Graph adapter details");
  });

  it.each([
    {
      name: "Graph metadata",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.readGraphMetadata).mockRejectedValue(new Error("private graph")),
      check: "graph_metadata",
      code: "graph_metadata_failed"
    },
    {
      name: "Notion",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.readNotionOne).mockRejectedValue(new Error("private notion")),
      check: "notion_query",
      code: "notion_query_failed"
    },
    {
      name: "queue",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.inspectQueue).mockRejectedValue(new Error("private queue")),
      check: "attachment_queue",
      code: "attachment_queue_failed"
    },
    {
      name: "signature manifest",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.readSignatureManifest).mockRejectedValue(new Error("private manifest path")),
      check: "clamav_signature",
      code: "clamav_manifest_invalid"
    },
    {
      name: "clean scan",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.scanSample).mockImplementation(async ({ kind }) => {
          if (kind === "clean") throw new Error("private scanner output");
          return { status: "infected" };
        }),
      check: "clamav_clean",
      code: "clamav_clean_failed"
    },
    {
      name: "EICAR scan",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.scanSample).mockImplementation(async ({ kind }) => {
          if (kind === "eicar") throw new Error("private signature name");
          return { status: "clean" };
        }),
      check: "clamav_eicar",
      code: "clamav_eicar_failed"
    },
    {
      name: "diagnostics folder",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.ensureDiagnosticsFolder).mockRejectedValue(new Error("private folder name")),
      check: "diagnostic_write_delete",
      code: "diagnostic_folder_failed"
    },
    {
      name: "diagnostic upload",
      breakDependency: (deps: PeriodicAssuranceDependencies) =>
        vi.mocked(deps.uploadDiagnostic).mockRejectedValue(new Error("private upload URL")),
      check: "diagnostic_write_delete",
      code: "diagnostic_upload_failed"
    }
  ])("maps $name failure to a stable code without retrying or leaking errors", async (scenario) => {
    const deps = dependencies();
    scenario.breakDependency(deps);

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result.status).toBe("failed");
    expect(result.checks).toContainEqual({
      name: scenario.check,
      status: "failed",
      code: scenario.code
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reports unexpected scan outcomes as stable failures", async () => {
    const deps = dependencies();
    vi.mocked(deps.scanSample)
      .mockResolvedValueOnce({ status: "infected" })
      .mockResolvedValueOnce({ status: "clean" });

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result.checks).toContainEqual({
      name: "clamav_clean",
      status: "failed",
      code: "clamav_clean_failed"
    });
    expect(result.checks).toContainEqual({
      name: "clamav_eicar",
      status: "failed",
      code: "clamav_eicar_failed"
    });
  });

  it("continues both scans when an old valid signature manifest is a warning", async () => {
    const deps = dependencies();
    vi.mocked(deps.readSignatureManifest).mockResolvedValue({
      ...MANIFEST,
      lastSuccessfulAt: "2026-07-19T00:00:00.000Z"
    });

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result.checks).toContainEqual({
      name: "clamav_signature",
      status: "warning",
      code: "signature_warning"
    });
    expect(deps.scanSample).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "future",
      manifest: { ...MANIFEST, lastSuccessfulAt: "2026-07-27T02:00:00.000Z" }
    },
    { name: "invalid", manifest: { ...MANIFEST, databaseDirectory: "sets/other" } }
  ])("fails a $name manifest without scanning", async ({ manifest }) => {
    const deps = dependencies();
    vi.mocked(deps.readSignatureManifest).mockResolvedValue(manifest);

    const result = await runPeriodicAssurance(INPUT, deps);

    expect(result.checks).toContainEqual({
      name: "clamav_signature",
      status: "failed",
      code: "clamav_manifest_invalid"
    });
    expect(deps.scanSample).not.toHaveBeenCalled();
  });

  it("maps periodic failures into the assurance report allowlist", async () => {
    const deps = dependencies();
    vi.mocked(deps.deleteDiagnostic).mockRejectedValue(new Error("private Graph error"));
    const result = await runPeriodicAssurance(INPUT, deps);
    const observedAt = NOW.toISOString();

    const report = buildAssuranceReport({
      version: 1,
      kind: "periodic",
      releaseId: "periodic-20260727",
      commitSha: "a".repeat(40),
      startedAt: observedAt,
      completedAt: observedAt,
      status: result.status,
      failureCode: mapPeriodicAssuranceCodeToReport(
        result.checks.find((check) => check.status === "failed")!.code
      ),
      target: {
        resource: "periodic_assurance",
        revision: "weekly",
        image: `sha256:${"b".repeat(64)}`,
        status: "failed"
      },
      knownGood: {
        revision: "weekly-previous",
        image: `sha256:${"c".repeat(64)}`
      },
      checks: result.checks.map((check) => ({
        name: check.name,
        status: check.status,
        observedAt,
        code: mapPeriodicAssuranceCodeToReport(check.code)
      })),
      rollback: { status: "not_required" },
      providerRequests: result.providerRequests
    });

    expect(report.failureCode).toBe("diagnostic_delete_failed");
    expect(report.checks.find((check) => check.name === "diagnostic_write_delete")?.code).toBe(
      "diagnostic_delete_failed"
    );
  });

  it.each(PERIODIC_FAILURE_CODES)(
    "preserves periodic failure code %s through the versioned report allowlist",
    (code) => {
      const observedAt = NOW.toISOString();
      const mapped = mapPeriodicAssuranceCodeToReport(code);

      const report = buildAssuranceReport({
        version: 1,
        kind: "periodic",
        releaseId: "periodic-20260727",
        commitSha: "a".repeat(40),
        startedAt: observedAt,
        completedAt: observedAt,
        status: "failed",
        failureCode: mapped,
        target: {
          resource: "periodic_assurance",
          revision: "weekly",
          image: `sha256:${"b".repeat(64)}`,
          status: "failed"
        },
        knownGood: {
          revision: "weekly-previous",
          image: `sha256:${"c".repeat(64)}`
        },
        checks: [
          {
            name: "graph_metadata",
            status: "failed",
            observedAt,
            code: mapped
          }
        ],
        rollback: { status: "not_required" },
        providerRequests: { deepseek: 0, embedding: 0 }
      });

      expect(report.failureCode).toBe(code);
      expect(report.checks[0]?.code).toBe(code);
    }
  );
});

describe("periodic assurance CLI", () => {
  it("configures every real SDK adapter with retries disabled", async () => {
    const createGraph = vi.fn().mockReturnValue({
      getItemById: vi.fn(),
      ensureFolder: vi.fn(),
      uploadFile: vi.fn(),
      deleteItem: vi.fn()
    });
    const createNotion = vi.fn().mockReturnValue({
      databases: { retrieve: vi.fn() },
      dataSources: { retrieve: vi.fn(), query: vi.fn() }
    });
    const createQueue = vi.fn().mockReturnValue({
      getProperties: vi.fn(),
      peekMessages: vi.fn()
    });
    const getToken = vi.fn().mockResolvedValue({ token: "workload-token" });
    const createCredential = vi.fn().mockReturnValue({ getToken });
    const createAsset = vi.fn().mockReturnValue({} as AssetApiClient);

    const deps = createPeriodicAssuranceDependencies(
      {
        GRAPH_TENANT_ID: "tenant",
        GRAPH_CLIENT_ID: "client",
        GRAPH_CLIENT_SECRET: "secret",
        GRAPH_DRIVE_ID: "drive-1",
        GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID: "other-folder",
        NOTION_TOKEN: "notion-token",
        ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING: "queue-connection",
        ATTACHMENT_SCAN_QUEUE_NAME: "attachment-scan",
        ASSET_API_URL: "https://asset.internal",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
      },
      {
        createGraph,
        createNotion,
        createQueue,
        createCredential,
        createAsset
      }
    );

    expect(createGraph).toHaveBeenCalledWith(expect.any(Object), { noRetry: true });
    expect(createNotion).toHaveBeenCalledWith({
      auth: "notion-token",
      logLevel: "error",
      retry: false
    });
    expect(createQueue).toHaveBeenCalledWith("queue-connection", "attachment-scan", {
      retryOptions: { maxTries: 1 }
    });
    expect(createCredential).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(createAsset).toHaveBeenCalledWith({
      baseUrl: "https://asset.internal",
      getAccessToken: expect.any(Function),
      onRejection: expect.any(Function)
    });
    const getAssetAccessToken = createAsset.mock.calls[0]?.[0].getAccessToken;
    const signal = AbortSignal.timeout(1_000);
    await expect(getAssetAccessToken(signal)).resolves.toBe("workload-token");
    expect(getToken).toHaveBeenCalledWith("api://asset-api/.default", {
      abortSignal: signal
    });
    expect(deps.runAssetLifecycle).toEqual(expect.any(Function));
  });

  it("emits only safe Asset rejection telemetry", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const createAsset = vi.fn().mockImplementation((options) => {
      options.onRejection({
        operationStage: "create_upload",
        httpStatus: 429,
        category: "rate_limited"
      });
      return {} as AssetApiClient;
    });

    createPeriodicAssuranceDependencies(
      {
        GRAPH_TENANT_ID: "tenant-private",
        GRAPH_CLIENT_ID: "client",
        GRAPH_CLIENT_SECRET: "secret",
        GRAPH_DRIVE_ID: "drive-1",
        GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID: "other-folder",
        NOTION_TOKEN: "notion-token",
        ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING: "queue-connection",
        ATTACHMENT_SCAN_QUEUE_NAME: "attachment-scan",
        ASSET_API_URL: "https://tenant-private.example/blob-key-private",
        ASSET_API_AUDIENCE: "api://asset-api",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111"
      },
      {
        createGraph: vi.fn().mockReturnValue({
          getItemById: vi.fn(),
          ensureFolder: vi.fn(),
          uploadFile: vi.fn(),
          deleteItem: vi.fn()
        }),
        createNotion: vi.fn().mockReturnValue({
          databases: { retrieve: vi.fn() },
          dataSources: { retrieve: vi.fn(), query: vi.fn() }
        }),
        createQueue: vi.fn().mockReturnValue({
          getProperties: vi.fn(),
          peekMessages: vi.fn()
        }),
        createCredential: vi.fn().mockReturnValue({ getToken: vi.fn() }),
        createAsset
      }
    );

    const serialized = write.mock.calls.map(([value]) => String(value)).join("");
    expect(JSON.parse(serialized)).toEqual({
      operationStage: "create_upload",
      httpStatus: 429,
      category: "rate_limited"
    });
    for (const fixture of ["tenant-private", "blob-key-private", "secret", "notion-token"]) {
      expect(serialized).not.toContain(fixture);
    }
    write.mockRestore();
  });

  it("resolves an existing Notion database to one bounded data-source result", async () => {
    const retrieveDataSource = vi.fn().mockRejectedValue(new Error("not a data source"));
    const retrieveDatabase = vi.fn().mockResolvedValue({
      data_sources: [{ id: "data-source-1" }]
    });
    const query = vi.fn().mockResolvedValue({
      results: [{ id: "page-1" }],
      has_more: true,
      next_cursor: "unused"
    });

    const count = await readOneNotionResult(
      {
        databases: { retrieve: retrieveDatabase },
        dataSources: { retrieve: retrieveDataSource, query }
      },
      "database-1",
      1
    );

    expect(count).toBe(1);
    expect(retrieveDataSource).toHaveBeenCalledOnce();
    expect(retrieveDatabase).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      data_source_id: "data-source-1",
      page_size: 1
    });
  });

  it("prints one sanitized result and returns a failing exit code without constructing providers", async () => {
    const deps = dependencies();
    vi.mocked(deps.readGraphMetadata).mockRejectedValue(new Error("private Graph URL"));
    const lines: string[] = [];

    const exitCode = await runPeriodicAssuranceCli(
      {
        GRAPH_DRIVE_ID: "drive-1",
        GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID: "other-folder",
        NOTION_SERVICE_DATABASE_ID: "notion-data-source",
        CLAMAV_SIGNATURE_MANIFEST_PATH: "/var/lib/clamav/manifest.json"
      },
      deps,
      (line) => lines.push(line)
    );

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private Graph URL");
    expect(JSON.parse(lines[0]!)).toEqual(
      expect.objectContaining({
        status: "failed",
        providerRequests: { deepseek: 0, embedding: 0 }
      })
    );
  });
});

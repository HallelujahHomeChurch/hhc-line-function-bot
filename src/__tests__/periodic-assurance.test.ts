import { describe, expect, it, vi } from "vitest";

import {
  runPeriodicAssurance,
  type PeriodicAssuranceDependencies,
  type PeriodicAssuranceInput
} from "../assurance/periodic-probe.js";
import { readOneNotionResult, runPeriodicAssuranceCli } from "../tools/run-periodic-assurance.js";

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
        { name: "diagnostic_write_delete", status: "passed", code: "none" }
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
    expect(result.checks.at(-1)).toEqual({
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
});

describe("periodic assurance CLI", () => {
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

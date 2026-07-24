import { describe, expect, it } from "vitest";

import { readAttachmentScanJobEnvironment } from "../tools/run-attachment-scan-job.js";

describe("attachment scan job environment", () => {
  it("accepts one opaque work id and bounded local scanner settings", () => {
    expect(
      readAttachmentScanJobEnvironment({
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
        CLAMAV_SIGNATURE_MANIFEST_PATH: "/var/lib/clamav/manifest.json",
        CLAMAV_SCAN_TIMEOUT_MS: "15000"
      })
    ).toEqual({
      workId: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
      databaseDirectory: "/var/lib/clamav/current",
      signatureManifestPath: "/var/lib/clamav/manifest.json",
      scanTimeoutMs: 15_000
    });
  });

  it.each([
    [{}, "WORK_ID"],
    [{ WORK_ID: "not-opaque" }, "WORK_ID"],
    [
      {
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "relative"
      },
      "CLAMAV_DATABASE_DIRECTORY"
    ],
    [
      {
        WORK_ID: "4c03465b-8a87-45a2-9d0d-54f904f4e6ab",
        CLAMAV_DATABASE_DIRECTORY: "/var/lib/clamav/current",
        CLAMAV_SCAN_TIMEOUT_MS: "0"
      },
      "CLAMAV_SCAN_TIMEOUT_MS"
    ]
  ])("rejects invalid worker environment without echoing values", (env, field) => {
    expect(() => readAttachmentScanJobEnvironment(env)).toThrow(field);
  });
});

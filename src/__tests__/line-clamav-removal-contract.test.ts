import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("LINE local ClamAV removal contract", () => {
  it("keeps one attachment worker runtime and no local scanner artifacts", () => {
    for (const path of [
      "aca.attachment-scan-job.yaml",
      "aca.clamav-signature-refresh-job.yaml",
      "src/tools/run-attachment-asset-job.ts",
      "src/tools/run-attachment-scan-job.ts",
      "src/tools/refresh-clamav-signatures.ts",
      "src/attachments/scan-worker.ts",
      "src/attachments/clamav-cli.ts",
      "src/attachments/clamav-signature-policy.ts"
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }

    expect(read("package.json")).not.toMatch(/attachment-scan:(?:run|legacy)/u);
    expect(read("Dockerfile")).not.toMatch(/attachment-scan-worker|clamav/iu);
    expect(read(".github/workflows/release.yml")).not.toMatch(
      /SCAN_IMAGE_REPOSITORY|clamav|aca\.attachment-scan-job/iu
    );
    expect(read("scripts/deploy-aca.sh")).not.toMatch(/CLAMAV_|clamav-|aca\.attachment-scan-job/iu);
    expect(read("src/assurance/periodic-probe.ts")).not.toMatch(/clamav/iu);
    expect(read("src/assurance/release-probe.ts")).not.toMatch(/clamav/iu);
  });
});

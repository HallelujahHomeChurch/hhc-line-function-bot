import { spawnSync } from "node:child_process";

import { expect, it } from "vitest";

it("checks attachment app cron coverage against meeting occurrences offline", () => {
  const result = spawnSync("python3", ["scripts/meeting-cron-drift.test.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);

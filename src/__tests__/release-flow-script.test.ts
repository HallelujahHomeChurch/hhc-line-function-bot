import { spawnSync } from "node:child_process";

import { expect, it } from "vitest";

it("checks real catalog and deferred acceptance boundaries with offline control-plane faults", () => {
  const result = spawnSync("python3", ["scripts/release-flow.test.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);

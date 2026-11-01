import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function runRead(command: string, failures = 0, output = "fixture-app") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-metadata-"));
  const calls = path.join(directory, "calls");
  const sleeps = path.join(directory, "sleeps");
  try {
    await Promise.all([writeFile(calls, ""), writeFile(sleeps, "")]);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source scripts/release-assurance.sh
RESOURCE_GROUP=fixture-rg
sleep() { printf '%s\n' "$1" >> "$SLEEPS"; }
az() {
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    'containerapp show'|'containerapp list')
      if [[ "$(wc -l < "$CALLS")" -le "$FAILURES" ]]; then
        printf 'discard-partial-response'
        printf 'discard-upstream-error\n' >&2
        return 55
      fi
      printf '%s\n' "$READ_OUTPUT"
      ;;
    'containerapp create'|'containerapp update') printf 'MUTATION:%s\n' "$2" ;;
    *) return 98 ;;
  esac
}
${command}
`
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CALLS: calls,
          SLEEPS: sleeps,
          FAILURES: String(failures),
          READ_OUTPUT: output
        }
      }
    );
    return {
      ...result,
      calls: (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean),
      sleeps: (await readFile(sleeps, "utf8")).trim().split("\n").filter(Boolean)
    };
  } finally {
    await rm(directory, { recursive: true });
  }
}

describe("release Azure metadata reads", () => {
  it.each([0, 1, 2])(
    "returns only the successful response after %i failed reads",
    async (failures) => {
      const result = await runRead(
        "release_containerapp_read show --resource-group fixture-rg --name fixture-app --output tsv",
        failures
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("fixture-app\n");
      expect(result.stderr).not.toContain("discard-upstream-error");
      expect(result.calls).toHaveLength(failures + 1);
      expect(result.sleeps).toEqual(Array(failures).fill("2"));
      expect(result.calls.every((call) => call.startsWith("containerapp show "))).toBe(true);
    }
  );

  it("fails after three reads without leaking a partial response", async () => {
    const result = await runRead("release_containerapp_read show --name fixture-app", 3);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls).toHaveLength(3);
    expect(result.sleeps).toEqual(["2", "2"]);
    expect(result.stderr).not.toContain("discard-upstream-error");
  });

  it.each(["update", "create", "secret"])(
    "never retries or invokes a %s operation",
    async (operation) => {
      const result = await runRead(`release_containerapp_read ${operation} --name fixture-app`);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.sleeps).toEqual([]);
    }
  );

  it("reports absence only after a successful empty metadata list", async () => {
    const result = await runRead('release_containerapp_exists "fixture-search"', 0, "");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(result.calls).toHaveLength(1);
  });
});

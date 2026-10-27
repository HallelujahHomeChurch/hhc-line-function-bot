import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const deployment = readFileSync("scripts/deploy-aca.sh", "utf8");
const renderer = deployment
  .slice(deployment.indexOf('BOT_MANIFEST_TEMPLATE="${bot_manifest_template}"'))
  .split("python3 - <<'PY'\n")[1]
  .split("\nPY\n")[0];
const template = readFileSync("aca.containerapp.yaml", "utf8");

function render(recovery: Record<string, string>, manifest = template) {
  const directory = mkdtempSync(join(tmpdir(), "bot-manifest-"));
  const input = join(directory, "input.yaml");
  const output = join(directory, "output.yaml");
  try {
    writeFileSync(input, manifest);
    const sourceNames = renderer.split("source_env_names = [\n")[1].split("\n]")[0];
    const result = spawnSync("python3", ["-c", renderer], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...Object.fromEntries(
          [...renderer.matchAll(/os\.environ\[\s*"([A-Z0-9_]+)"\s*\]/g)].map((match) => [
            match[1],
            `fixture-${match[1]}`
          ])
        ),
        BOT_ENV_JSON: JSON.stringify(
          [...sourceNames.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => ({
            name: match[1],
            value: `fixture-${match[1]}`
          }))
        ),
        BOT_MANIFEST_TEMPLATE: input,
        BOT_MANIFEST: output,
        RELEASE_RECOVERY_ENV_JSON: JSON.stringify(recovery)
      }
    });
    return { ...result, manifest: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("production bot manifest renderer", () => {
  it.each([
    {
      REDIS_KEY_PREFIX: "hhc-line-function-bot",
      LINE_REDIS_RECOVERY: "null",
      LINE_REDIS_RECOVERY_CUTOFF_MS: ""
    },
    {
      REDIS_KEY_PREFIX: "hhc-line-function-bot:recovery:fixture",
      LINE_REDIS_RECOVERY: JSON.stringify({ operationId: "fixture", cutoffMs: 1792960000000 }),
      LINE_REDIS_RECOVERY_CUTOFF_MS: "1792960000000"
    }
  ])("renders overlapping recovery placeholders while retaining %j", (recovery) => {
    const result = render(recovery);
    expect(result.status, result.stderr).toBe(0);
    expect(result.manifest).not.toContain("PLACEHOLDER_");
    for (const [name, value] of Object.entries(recovery)) {
      expect(result.manifest).toContain(
        `- name: ${name}\n            value: ${JSON.stringify(value)}`
      );
    }
  });

  it.each(["missing", "duplicate"])("still rejects a %s recovery placeholder", (scenario) => {
    const placeholder = "PLACEHOLDER_LINE_REDIS_RECOVERY_CUTOFF_MS";
    const manifest = template.replace(
      placeholder,
      scenario === "missing" ? '""' : `${placeholder} ${placeholder}`
    );
    const result = render(
      {
        REDIS_KEY_PREFIX: "hhc-line-function-bot",
        LINE_REDIS_RECOVERY: "null",
        LINE_REDIS_RECOVERY_CUTOFF_MS: ""
      },
      manifest
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected one bot manifest placeholder:");
    expect(result.manifest).toBe("");
  });
});

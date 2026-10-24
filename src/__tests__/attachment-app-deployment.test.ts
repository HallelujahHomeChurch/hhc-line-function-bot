import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("attachment app deployment", () => {
  it.each([true, false])(
    "preserves the assigned identity in the full manifest when app exists=%s",
    async (exists) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "attachment-app-deploy-"));
      try {
        const script = await readFile(path.join(ROOT, "scripts/deploy-aca.sh"), "utf8");
        const start = script.indexOf("\nmark_release_attachment_app_mutated\n");
        const end = script.indexOf(
          '\nmark_release_job_mutated "${MEDIA_SYNC_WARMER_JOB_NAME}"',
          start
        );
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const manifestPath = path.join(directory, "manifest.json");
        const identity =
          "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/attachment";
        const manifest = {
          identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } },
          properties: {
            configuration: { registries: [{ server: "fixture.azurecr.io", identity }] },
            template: {
              containers: [{ name: "attachment-worker", image: "fixture/image:release" }],
              scale: { rules: [{ name: "attachment-work", azureQueue: { identity } }] }
            }
          }
        };
        await writeFile(manifestPath, JSON.stringify(manifest));
        const result = spawnSync(
          "bash",
          [
            "-c",
            `
set -euo pipefail
RESOURCE_GROUP=fixture
ATTACHMENT_WORKER_APP_NAME=fixture-worker
attachment_worker_app_manifest="$1"
mark_release_attachment_app_mutated() { echo rollback-tracked; }
az() {
  if [[ "$1 $2" == 'containerapp show' ]]; then
    return ${exists ? 0 : 1}
  fi
  if [[ "$1 $2" == 'containerapp update' ]]; then
    echo 'IdentityDoesNotExist: update --yaml drops empty userAssignedIdentities' >&2
    return 1
  fi
  [[ "$1 $2" == 'containerapp create' ]]
  shift 2
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == --yaml ]]; then cat "$2"; return; fi
    shift
  done
  return 91
}
${script.slice(start, end)}
`,
            "fixture",
            manifestPath
          ],
          { cwd: ROOT, encoding: "utf8" }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.startsWith("rollback-tracked\n")).toBe(true);
        expect(JSON.parse(result.stdout.slice("rollback-tracked\n".length))).toEqual(manifest);
      } finally {
        await rm(directory, { recursive: true });
      }
    }
  );
});

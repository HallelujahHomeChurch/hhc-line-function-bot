import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("Asset deployment access contract", () => {
  it("wires the periodic job to the existing workload identity and token-free Asset transport", async () => {
    const [deploy, manifest] = await Promise.all([
      readFile(path.join(ROOT, "scripts/deploy-aca.sh"), "utf8"),
      readFile(path.join(ROOT, "aca.periodic-assurance-job.yaml"), "utf8")
    ]);

    expect(deploy).toContain("verify_asset_access_contract");
    expect(deploy).toMatch(
      /deploy_job \\\n+ {2}"\$\{PERIODIC_ASSURANCE_JOB_NAME\}" \\\n+ {2}"\$\{periodic_assurance_job_manifest\}" \\\n+ {2}"\$\{attachment_job_identity_id\}"/u
    );
    expect(manifest).toContain("PLACEHOLDER_ATTACHMENT_JOB_IDENTITY_ID");
    expect(manifest).toContain("identity: PLACEHOLDER_ATTACHMENT_JOB_IDENTITY_ID");
    expect(manifest).toContain(
      "name: AZURE_CLIENT_ID\n            value: PLACEHOLDER_ATTACHMENT_JOB_CLIENT_ID"
    );
    expect(manifest).toContain("name: ASSET_API_URL");
    expect(manifest).not.toContain("ASSET_API_AUDIENCE");
    expect(manifest).toContain("name: AZURE_CLIENT_ID");
  });

  it.each([
    ["success", 0],
    ["missing_caller", 1],
    ["auth_enabled", 1],
    ["external_ingress", 1],
    ["wrong_origin", 1],
    ["unsettled", 1],
    ["mutable_image", 1]
  ])("fails closed for %s", async (scenario, expectedStatus) => {
    const fixture = await createFixture(scenario);

    const result = spawnSync("bash", [fixture.driver], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` }
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|api:\/\/asset-api/u
    );
  });
});

async function createFixture(scenario: string): Promise<{ bin: string; driver: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-deployment-contract-"));
  directories.push(directory);
  const bin = path.join(directory, "bin");
  const driver = path.join(directory, "driver.sh");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "az"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "containerapp auth show" ]]; then
  [[ "${scenario}" == auth_enabled ]] && echo true || echo false
elif [[ "$1 $2" == "containerapp show" ]]; then
  jq -nc --arg scenario "${scenario}" '{latest:"asset-r1",ready:(if $scenario == "unsettled" then "old" else "asset-r1" end),image:(if $scenario == "mutable_image" then "alive.azurecr.io/alive/asset-api:latest" else "alive.azurecr.io/alive/asset-api@sha256:${"a".repeat(64)}" end),ingress:{external:($scenario == "external_ingress"),allowInsecure:false,targetPort:8080,transport:"Auto",fqdn:(if $scenario == "wrong_origin" then "evil.example" else "asset-api.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io" end)},callers:[(if $scenario == "missing_caller" then "account-api" else "account-api,hhc-web-api,hhc-line-function-bot" end)]}'
else
  exit 91
fi
`,
    { mode: 0o700 }
  );
  await chmod(path.join(bin, "az"), 0o700);
  await writeFile(
    driver,
    `#!/usr/bin/env bash
set -euo pipefail
source "${path.join(ROOT, "scripts/release-assurance.sh")}"
verify_asset_access_contract fixture-resource-group asset-api
`,
    { mode: 0o700 }
  );
  return { bin, driver };
}

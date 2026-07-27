import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("Kernel local live disposable runner", () => {
  it("keeps secrets, networks, budgets, and cleanup fail closed", async () => {
    const [shell, compose, dockerfile] = await Promise.all([
      readFile(path.join(ROOT, "scripts/run-kernel-local-live.sh"), "utf8"),
      readFile(path.join(ROOT, "compose.kernel-local-live.yml"), "utf8"),
      readFile(path.join(ROOT, "Dockerfile"), "utf8")
    ]);

    expect(shell.indexOf("set +x")).toBeLessThan(shell.indexOf("az containerapp secret list"));
    expect(shell).toContain('COMPOSE_FILE="compose.kernel-local-live.yml"');
    expect(shell.indexOf("trap ")).toBeLessThan(
      shell.indexOf('"${DOCKER_TIMEOUT_COMMAND[@]}" compose -f "$COMPOSE_FILE" up')
    );
    expect(shell).toContain("mktemp -d /dev/shm/kernel-local-live.XXXXXXXX");
    expect(shell).toContain("chmod 0700");
    expect(shell).toContain("chmod 0600");
    expect(shell).toContain("--opt type=tmpfs");
    expect(shell).toContain("docker exec -i");
    expect(shell).toContain('docker volume rm "$SECRET_VOLUME"');
    expect(shell).toContain("deepseek-api-key");
    expect(shell).toContain("azure-openai-embedding-key");
    expect(shell.match(/--show-values/gu)).toHaveLength(2);
    expect(shell).toContain("timeout --signal=TERM --kill-after=15s 10m");
    expect(shell).toContain('"${DOCKER_TIMEOUT_COMMAND[@]}" compose');
    expect(shell).toContain("down --volumes --remove-orphans");
    expect(shell).toContain("kernel_local_live_failed_stage:");
    expect(shell.indexOf('CURRENT_STAGE="driver_result"')).toBeGreaterThan(
      shell.indexOf("cleanup")
    );
    expect(shell).toContain("git status --porcelain --untracked-files=all");
    expect(shell.indexOf("git status --porcelain")).toBeLessThan(
      shell.indexOf("git rev-parse HEAD")
    );
    expect(shell).not.toMatch(/\b(for|while)\b.*\b(retry|rerun)\b/u);

    expect(compose.match(/^ {2}[a-z][a-z-]+:\s*$/gmu)?.length).toBeGreaterThanOrEqual(4);
    for (const service of ["acceptance-app", "acceptance-driver", "postgres", "redis"]) {
      expect(compose).toContain(`  ${service}:`);
    }
    expect(compose).toContain("provider-egress");
    expect(compose).toContain("internal: true");
    expect(compose).toContain("target: /run/secrets");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("secret-data");
    expect(compose).not.toContain("KERNEL_DEEPSEEK_SECRET_FILE");
    expect(compose).not.toContain("KERNEL_AZURE_EMBEDDING_SECRET_FILE");
    expect(compose).not.toMatch(/^\s+ports:/mu);
    expect(compose).not.toMatch(/\brestart:\s*(always|on-failure)/u);
    expect(dockerfile).toContain("AS kernel-local-live");
    expect(dockerfile).not.toMatch(/FROM [\s\S]*AS kernel-local-live[\s\S]*\bARG .*SECRET/iu);
  });

  it.each([
    ["success", "", 0],
    ["azure failure", "az", 2],
    ["compose failure", "compose-up", 2],
    ["cleanup failure", "compose-down", 2],
    ["secret cleanup failure", "secret-volume-rm", 2],
    ["secret resource listing failure", "resource-list-failure", 2],
    ["already-clean secret resources", "resources-absent", 0]
  ])(
    "executes the %s cleanup path with fake binaries",
    async (_name, failure, expectedExit) => {
      const fixture = await createFakeRuntime(failure);
      const result = fixture.run();
      const log = await readFile(fixture.logPath, "utf8");

      expect(result.status, `${result.stdout}\n${result.stderr}\n${log}`).toBe(expectedExit);
      if (failure !== "az") {
        expect(log).toMatch(/compose .* down --volumes --remove-orphans/u);
        if (failure === "resources-absent" || failure === "resource-list-failure") {
          expect(log).not.toMatch(/rm -f kernel-local-live-secret-loader-/u);
          expect(log).not.toMatch(/volume rm kernel-local-live-secrets-/u);
        } else {
          expect(log).toMatch(/rm -f kernel-local-live-secret-loader-/u);
          expect(log).toMatch(/volume rm kernel-local-live-secrets-/u);
        }
      }
    },
    30_000
  );
});

async function createFakeRuntime(failure: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kernel-local-live-runner-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const logPath = path.join(directory, "calls.log");
  const artifactRoot = path.join(directory, "artifacts-root");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([
      mkdir(binDirectory),
      mkdir(path.join(artifactRoot, "artifacts/kernel-v1"), { recursive: true })
    ])
  );
  await writeExecutable(
    path.join(binDirectory, "az"),
    `#!/usr/bin/env bash
if [[ "\${FAKE_FAILURE:-}" == "az" ]]; then exit 9; fi
if [[ "$*" == *"deepseek-api-key"* ]]; then printf 'deepseek-test-secret'; else printf 'azure-test-secret'; fi
`
  );
  await writeExecutable(
    path.join(binDirectory, "timeout"),
    `#!/usr/bin/env bash
shift 3
if [[ "$1" == "docker" ]]; then
  shift
  exec bash "\${KERNEL_LOCAL_LIVE_FAKE_BIN_DIRECTORY}/docker" "$@"
fi
exec "$@"
`
  );
  await writeExecutable(
    path.join(binDirectory, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_LOG}"
if [[ "$1" == "build" ]]; then exit 0; fi
if [[ "$1" == "run" && "$*" == *"--validate-case"* ]]; then exit 0; fi
if [[ "$1" == "compose" && "$*" == *" up "* ]]; then
  [[ "\${FAKE_FAILURE:-}" == "compose-up" ]] && exit 7
  printf '{"schemaVersion":1}' > "\${KERNEL_LOCAL_LIVE_ARTIFACT_ROOT}/artifacts/kernel-v1/local-live-suite-result.json"
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" down "* ]]; then
  [[ "\${FAKE_FAILURE:-}" == "compose-down" ]] && exit 8
  exit 0
fi
if [[ "$1" == "compose" && "$*" == *" config "* ]]; then printf 'safe compose'; exit 0; fi
if [[ "$1" == "container" && "$2" == "ls" && "$*" == *"label=com.docker.compose.project="* ]]; then
  [[ "\${FAKE_FAILURE:-}" == "resource-list-failure" ]] && exit 8
  [[ "\${FAKE_FAILURE:-}" == "compose-down" ]] && printf 'compose-container-id'
  exit 0
fi
if [[ "$1" == "network" && "$2" == "ls" ]]; then
  [[ "\${FAKE_FAILURE:-}" == "resource-list-failure" ]] && exit 8
  exit 0
fi
if [[ "$1" == "volume" && "$2" == "ls" && "$*" == *"label=com.docker.compose.project="* ]]; then
  [[ "\${FAKE_FAILURE:-}" == "resource-list-failure" ]] && exit 8
  exit 0
fi
if [[ "$1" == "container" && "$2" == "ls" ]]; then
  [[ "\${FAKE_FAILURE:-}" == "resource-list-failure" ]] && exit 8
  [[ "\${FAKE_FAILURE:-}" == "resources-absent" ]] || printf 'loader-id'
  exit 0
fi
if [[ "$1" == "volume" && "$2" == "ls" ]]; then
  [[ "\${FAKE_FAILURE:-}" == "resource-list-failure" ]] && exit 8
  [[ "\${FAKE_FAILURE:-}" == "resources-absent" ]] || printf 'volume-name'
  exit 0
fi
if [[ "$1" == "volume" && "$2" == "rm" && "\${FAKE_FAILURE:-}" == "secret-volume-rm" ]]; then exit 8; fi
if [[ "$1" == "run" && "$*" == *"--finalize-cleanup"* ]]; then
  printf '{"passed":true}' > "\${KERNEL_LOCAL_LIVE_ARTIFACT_ROOT}/artifacts/kernel-v1/local-live-report.json"
  printf '# safe report\\n' > "\${KERNEL_LOCAL_LIVE_ARTIFACT_ROOT}/artifacts/kernel-v1/local-live-report.md"
  exit 0
fi
exit 0
`
  );
  const spawnSync = (await import("node:child_process")).spawnSync;
  const command = [
    `cd '${toBashPath(ROOT)}' &&`,
    `FAKE_FAILURE='${failure}'`,
    `FAKE_LOG='${toBashPath(logPath)}'`,
    `KERNEL_LOCAL_LIVE_FAKE_BIN_DIRECTORY='${toBashPath(binDirectory)}'`,
    `KERNEL_LOCAL_LIVE_ARTIFACT_ROOT='${toBashPath(artifactRoot)}'`,
    "KERNEL_LOCAL_LIVE_TEST_MODE=1",
    "bash scripts/run-kernel-local-live.sh"
  ].join(" ");
  return {
    logPath,
    run: () =>
      spawnSync(
        process.platform === "win32" ? "C:\\Windows\\System32\\bash.exe" : "bash",
        ["-lc", command],
        {
          cwd: ROOT,
          encoding: "utf8"
        }
      )
  };
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o700 });
}

function toBashPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  return match ? `/mnt/${match[1]!.toLowerCase()}/${match[2]}` : normalized;
}

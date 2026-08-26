import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = process.cwd();
const publicationScript = resolve(root, "scripts/publish-openapi.sh");
const commit = "0123456789abcdef0123456789abcdef01234567";
const image =
  "alive.azurecr.io/alive/hhc-line-function-bot@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("API docs publication", () => {
  let fixture: string;
  let container: string;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "line-api-docs-"));
    container = join(fixture, "blobs", "api-docs-hhc-line-function-bot");
    await mkdir(join(fixture, "docs"), { recursive: true });
    await mkdir(join(fixture, "bin"), { recursive: true });
    await mkdir(container, { recursive: true });
    await writeFile(join(fixture, "docs", "openapi.yaml"), "openapi: 3.1.0\n");
    await writeFile(
      join(fixture, "bin", "az"),
      `#!/usr/bin/env bash
set -euo pipefail
operation="$1 $2 $3"
shift 3
name=""
file=""
overwrite="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --file) file="$2"; shift 2 ;;
    --overwrite) overwrite="$2"; shift 2 ;;
    --account-name|--container-name|--auth-mode|--query|--output) shift 2 ;;
    --only-show-errors|--no-progress) shift ;;
    *) echo "unexpected az argument: $1" >&2; exit 2 ;;
  esac
done
blob="${fixture}/blobs/api-docs-hhc-line-function-bot/$name"
case "$operation" in
  "storage blob exists") [[ -e "$blob" ]] && printf true || printf false ;;
  "storage blob download") mkdir -p "$(dirname "$file")"; cp "$blob" "$file" ;;
  "storage blob upload")
    if [[ -e "$blob" && "$overwrite" != true ]]; then exit 1; fi
    mkdir -p "$(dirname "$blob")"
    cp "$file" "$blob"
    ;;
  *) echo "unexpected az operation: $operation" >&2; exit 2 ;;
esac
`
    );
    await chmod(join(fixture, "bin", "az"), 0o755);
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  async function seed(path: string, contents: string): Promise<void> {
    const target = join(container, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  async function pointer(): Promise<string> {
    return readFile(join(container, "current.json"), "utf8");
  }

  function run(runId: string, failBeforePointer = false) {
    return spawnSync("bash", [publicationScript], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(fixture, "bin")}:${process.env.PATH}`,
        STORAGE_ACCOUNT: "hhcapidocsprod",
        CONTAINER: "api-docs-hhc-line-function-bot",
        RELEASE_COMMIT: commit,
        RELEASE_IMAGE: image,
        GITHUB_SHA: commit,
        GITHUB_REPOSITORY: "HallelujahHomeChurch/hhc-line-function-bot",
        GITHUB_RUN_ID: runId,
        FAIL_OPENAPI_BEFORE_POINTER: `${failBeforePointer}`
      }
    });
  }

  it("uploads immutable content before the production pointer", async () => {
    const result = run("20");

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(container, `specs/${commit}/openapi.yaml`), "utf8")).toBe(
      "openapi: 3.1.0\n"
    );
    expect(JSON.parse(await pointer())).toMatchObject({
      schemaVersion: 1,
      service: "hhc-line-function-bot",
      commit,
      image,
      specBlob: `specs/${commit}/openapi.yaml`,
      specSha256: "f39db8e8ede3dc2457c613e2a304e6d478f6e5ec660e4746464f41e76ac77006",
      releaseUrl: "https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/20"
    });
  });

  it("fails closed on an immutable spec hash mismatch", async () => {
    const previous =
      '{"releaseUrl":"https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/20"}\n';
    await seed(`specs/${commit}/openapi.yaml`, "different\n");
    await seed("current.json", previous);

    const result = run("21");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Existing OpenAPI spec hash does not match");
    expect(await pointer()).toBe(previous);
  });

  it("preserves the pointer when the controlled pre-pointer failure is requested", async () => {
    const previous =
      '{"releaseUrl":"https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/20"}\n';
    await seed("current.json", previous);

    const result = run("21", true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Requested failure before API docs pointer upload");
    expect(await pointer()).toBe(previous);
    expect(await readFile(join(container, `specs/${commit}/openapi.yaml`), "utf8")).toBe(
      "openapi: 3.1.0\n"
    );
  });

  it("skips stale and same-run pointers but advances a newer run", async () => {
    const previous =
      '{"releaseUrl":"https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/20"}\n';
    await seed(`specs/${commit}/openapi.yaml`, "openapi: 3.1.0\n");
    await seed("current.json", previous);

    expect(run("19").status).toBe(0);
    expect(await pointer()).toBe(previous);
    expect(run("20").status).toBe(0);
    expect(await pointer()).toBe(previous);
    expect(run("21").status).toBe(0);
    expect(JSON.parse(await pointer()).releaseUrl).toMatch(/\/runs\/21$/u);
  });

  it("compares large workflow run IDs as decimal integers", async () => {
    await seed(`specs/${commit}/openapi.yaml`, "openapi: 3.1.0\n");
    await seed(
      "current.json",
      '{"releaseUrl":"https://github.com/HallelujahHomeChurch/hhc-line-function-bot/actions/runs/99999999999999999999"}\n'
    );

    const result = run("100000000000000000000");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await pointer()).releaseUrl).toMatch(/\/runs\/100000000000000000000$/u);
  });

  it.each(["{", "{}", '{"releaseUrl":null}', '{"releaseUrl":"https://example.com/runs/20"}'])(
    "rejects malformed existing pointer %s",
    async (invalidPointer) => {
      await seed(`specs/${commit}/openapi.yaml`, "openapi: 3.1.0\n");
      await seed("current.json", `${invalidPointer}\n`);

      const result = run("21");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Invalid existing API docs pointer: expected canonical GitHub workflow run ID"
      );
    }
  );

  it.each(["0", "01"])("rejects non-canonical candidate run ID %s", (runId) => {
    const result = run(runId);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid GITHUB_RUN_ID: expected canonical positive decimal");
  });
});

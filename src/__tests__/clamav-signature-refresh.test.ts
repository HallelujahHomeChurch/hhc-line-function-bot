import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  refreshClamAvSignatures,
  type ClamAvRefreshExecFile
} from "../tools/refresh-clamav-signatures.js";
import { isCurrentClamAvSignatureManifest } from "../attachments/scan-worker.js";

const temporaryRoots: string[] = [];
const fixedNow = new Date("2026-07-24T04:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function createSignatureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hhc-clamav-refresh-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "current"));
  await writeFile(join(root, "current", "old.cvd"), "old signatures");
  await writeFile(
    join(root, "current", "manifest.json"),
    JSON.stringify({
      version: 1,
      signatureVersion: "previous",
      lastSuccessfulAt: "2026-07-22T04:00:00.000Z"
    })
  );
  return root;
}

function successfulExec(options?: {
  omit?: "main" | "daily" | "bytecode";
  rejectValidation?: boolean;
}): ClamAvRefreshExecFile {
  return vi.fn((command, args, _execOptions, callback) => {
    void (async () => {
      if (command === "freshclam") {
        const databaseArgument = args.find((argument) => argument.startsWith("--datadir="));
        const stagingDirectory = databaseArgument?.slice("--datadir=".length);
        if (!stagingDirectory) {
          callback(Object.assign(new Error("missing datadir"), { code: 2 }), "", "");
          return;
        }
        for (const name of ["main", "daily", "bytecode"] as const) {
          if (name !== options?.omit) {
            await writeFile(join(stagingDirectory, `${name}.cvd`), `${name} signatures`);
          }
        }
        callback(null, "private freshclam output", "");
        return;
      }

      expect(command).toBe("sigtool");
      expect(args[0]).toBe("--info");
      expect(existsSync(join(dirname(args[1] ?? ""), "manifest.json"))).toBe(false);
      callback(
        options?.rejectValidation
          ? Object.assign(new Error("private validation output"), { code: 2 })
          : null,
        "private sigtool output",
        ""
      );
    })();
    return undefined;
  });
}

describe("ClamAV signature refresh", () => {
  it("provides a dedicated safe refresh module", async () => {
    await expect(import("../tools/refresh-clamav-signatures.js")).resolves.toHaveProperty(
      "refreshClamAvSignatures"
    );
  });

  it.each([
    undefined,
    {},
    {
      version: 1,
      signatureVersion: "daily-20260724",
      lastSuccessfulAt: "not-a-timestamp"
    },
    {
      version: 1,
      signatureVersion: "daily-20260724",
      lastSuccessfulAt: "2026-07-21T03:59:59.999Z"
    }
  ])("rejects a missing, malformed, or over-72-hour manifest", (manifest) => {
    expect(isCurrentClamAvSignatureManifest(manifest, new Date("2026-07-24T04:00:00.000Z"))).toBe(
      false
    );
  });

  it("downloads and validates a complete staged set before atomically promoting its manifest", async () => {
    const root = await createSignatureRoot();
    const execFile = successfulExec();

    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => fixedNow,
        execFile
      })
    ).resolves.toEqual({
      status: "refreshed",
      signatureVersion: "clamav-20260724T040000000Z"
    });

    expect(execFile).toHaveBeenCalledTimes(4);
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "freshclam",
      expect.arrayContaining(["--log=/dev/null", expect.stringMatching(/^--datadir=.*staging-/u)]),
      expect.objectContaining({ timeout: expect.any(Number), windowsHide: true }),
      expect.any(Function)
    );
    expect((await readdir(join(root, "current"))).sort()).toEqual([
      "manifest.json",
      "old.cvd",
      "sets"
    ]);
    expect(JSON.parse(await readFile(join(root, "current", "manifest.json"), "utf8"))).toEqual({
      version: 1,
      signatureVersion: "clamav-20260724T040000000Z",
      lastSuccessfulAt: "2026-07-24T04:00:00.000Z",
      databaseDirectory: "sets/clamav-20260724T040000000Z"
    });
    expect(
      (await readdir(join(root, "current", "sets", "clamav-20260724T040000000Z"))).sort()
    ).toEqual(["bytecode.cvd", "daily.cvd", "main.cvd"]);
    expect(await readFile(join(root, "current", "old.cvd"), "utf8")).toBe("old signatures");
    expect((await readdir(root)).filter((name) => name !== "current")).toEqual([]);
  });

  it("retains the active set when freshclam fails", async () => {
    const root = await createSignatureRoot();
    const execFile: ClamAvRefreshExecFile = vi.fn((_command, _args, _options, callback) => {
      callback(Object.assign(new Error("private remote details"), { code: 2 }), "", "");
      return undefined;
    });

    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => fixedNow,
        execFile
      })
    ).resolves.toEqual({ status: "failed", failureCode: "freshclam_failed" });

    expect(await readFile(join(root, "current", "old.cvd"), "utf8")).toBe("old signatures");
    expect((await readdir(root)).filter((name) => name !== "current")).toEqual([]);
  });

  it("rejects an incomplete staged database without replacing the active set", async () => {
    const root = await createSignatureRoot();

    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => fixedNow,
        execFile: successfulExec({ omit: "bytecode" })
      })
    ).resolves.toEqual({
      status: "failed",
      failureCode: "signature_set_incomplete"
    });

    expect(await readFile(join(root, "current", "old.cvd"), "utf8")).toBe("old signatures");
    expect(existsSync(join(root, "current", "manifest.json"))).toBe(true);
  });

  it("rejects a database that ClamAV tooling cannot validate without replacing the active set", async () => {
    const root = await createSignatureRoot();

    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => fixedNow,
        execFile: successfulExec({ rejectValidation: true })
      })
    ).resolves.toEqual({
      status: "failed",
      failureCode: "signature_validation_failed"
    });

    expect(await readFile(join(root, "current", "old.cvd"), "utf8")).toBe("old signatures");
    expect(existsSync(join(root, "current", "manifest.json"))).toBe(true);
  });
});

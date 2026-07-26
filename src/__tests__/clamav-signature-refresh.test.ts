import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  replaceClamAvManifest,
  refreshClamAvSignatures,
  type ClamAvRefreshExecFile
} from "../tools/refresh-clamav-signatures.js";
import {
  assessClamAvSignatureManifest,
  CLAMAV_SIGNATURE_WARNING_AGE_MS
} from "../attachments/clamav-signature-policy.js";

const temporaryRoots: string[] = [];
const fixedNow = new Date("2026-07-24T04:00:00.000Z");

function validManifest(lastSuccessfulAt: Date, databaseDirectory?: string) {
  return {
    version: 1 as const,
    signatureVersion: "daily-20260724",
    lastSuccessfulAt: lastSuccessfulAt.toISOString(),
    ...(databaseDirectory === undefined ? {} : { databaseDirectory })
  };
}

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

  it("classifies valid signature manifests as current or warning without expiring them", () => {
    const now = new Date("2026-07-24T04:00:00.000Z");
    const nowMinus = (milliseconds: number) => new Date(now.getTime() - milliseconds);

    expect(assessClamAvSignatureManifest(validManifest(now), now)).toMatchObject({
      status: "usable",
      health: "current"
    });
    expect(
      assessClamAvSignatureManifest(validManifest(nowMinus(CLAMAV_SIGNATURE_WARNING_AGE_MS)), now)
    ).toMatchObject({ status: "usable", health: "warning" });
    expect(
      assessClamAvSignatureManifest(validManifest(nowMinus(30 * 24 * 60 * 60 * 1000)), now)
    ).toMatchObject({ status: "usable", health: "warning" });
  });

  it("rejects missing, malformed, future, and invalid immutable-directory manifests", () => {
    const now = new Date("2026-07-24T04:00:00.000Z");

    expect(assessClamAvSignatureManifest(undefined, now)).toEqual({ status: "invalid" });
    expect(assessClamAvSignatureManifest({ version: 2 }, now)).toEqual({ status: "invalid" });
    expect(assessClamAvSignatureManifest(validManifest(new Date(now.getTime() + 1)), now)).toEqual({
      status: "invalid"
    });
    expect(
      assessClamAvSignatureManifest(validManifest(now, "sets/daily-20260724"), now)
    ).toMatchObject({ status: "usable" });
    expect(assessClamAvSignatureManifest(validManifest(now, "current"), now)).toEqual({
      status: "invalid"
    });
  });

  it("rejects an immutable-directory reference for a different signature version", () => {
    const now = new Date("2026-07-24T04:00:00.000Z");

    expect(assessClamAvSignatureManifest(validManifest(now, "sets/daily-20260723"), now)).toEqual({
      status: "invalid"
    });
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

  it("safely replaces an existing manifest when Azure Files rejects rename-overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhc-clamav-manifest-test-"));
    temporaryRoots.push(root);
    const manifestPath = join(root, "manifest.json");
    const temporaryPath = join(root, "manifest.tmp");
    await writeFile(manifestPath, "old manifest");
    await writeFile(temporaryPath, "new manifest");
    let renameAttempts = 0;

    await replaceClamAvManifest(temporaryPath, manifestPath, {
      renameFile: async (source, destination) => {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          throw Object.assign(new Error("SMB overwrite unsupported"), { code: "EPERM" });
        }
        await rename(source, destination);
      }
    });

    expect(renameAttempts).toBe(2);
    expect(await readFile(manifestPath, "utf8")).toBe("new manifest");
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it("refreshes repeatedly after the current sets directory already exists", async () => {
    const root = await createSignatureRoot();

    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => fixedNow,
        execFile: successfulExec()
      })
    ).resolves.toMatchObject({ status: "refreshed" });
    await expect(
      refreshClamAvSignatures({
        rootDirectory: root,
        now: () => new Date("2026-07-24T04:01:00.000Z"),
        execFile: successfulExec()
      })
    ).resolves.toEqual({
      status: "refreshed",
      signatureVersion: "clamav-20260724T040100000Z"
    });

    expect(
      JSON.parse(await readFile(join(root, "current", "manifest.json"), "utf8"))
    ).toMatchObject({
      signatureVersion: "clamav-20260724T040100000Z"
    });
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

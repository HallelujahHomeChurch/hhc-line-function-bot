import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

type ExecFileError = Error & {
  code?: string | number | null;
};

export type ClamAvRefreshExecFile = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
  },
  callback: (error: ExecFileError | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => unknown;

export type ClamAvSignatureRefreshFailureCode =
  | "freshclam_failed"
  | "signature_set_incomplete"
  | "signature_validation_failed"
  | "promotion_failed";

export type ClamAvSignatureRefreshResult =
  | { status: "refreshed"; signatureVersion: string }
  | { status: "failed"; failureCode: ClamAvSignatureRefreshFailureCode };

export interface ClamAvSignatureRefreshOptions {
  rootDirectory: string;
  execFile?: ClamAvRefreshExecFile;
  now?: () => Date;
  refreshTimeoutMs?: number;
  validationTimeoutMs?: number;
}

export interface ClamAvSignatureRefreshEnvironment {
  rootDirectory: string;
  refreshTimeoutMs: number;
  validationTimeoutMs: number;
}

const REQUIRED_DATABASE_NAMES = ["main", "daily", "bytecode"] as const;
const DEFAULT_REFRESH_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 60 * 1000;

export async function refreshClamAvSignatures(
  options: ClamAvSignatureRefreshOptions
): Promise<ClamAvSignatureRefreshResult> {
  if (!isAbsolute(options.rootDirectory)) {
    throw new Error("CLAMAV_SIGNATURE_ROOT must be an absolute path");
  }

  const execFile = options.execFile ?? (nodeExecFile as ClamAvRefreshExecFile);
  const operationId = randomUUID();
  const stagingDirectory = join(options.rootDirectory, `.staging-${operationId}`);
  const currentDirectory = join(options.rootDirectory, "current");

  await mkdir(options.rootDirectory, { recursive: true });
  await mkdir(stagingDirectory, { mode: 0o700 });

  try {
    const refreshed = await runClamAvCommand(
      execFile,
      "freshclam",
      ["--stdout", "--no-warnings", "--log=/dev/null", `--datadir=${stagingDirectory}`],
      options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
    );
    if (!refreshed) {
      return { status: "failed", failureCode: "freshclam_failed" };
    }

    const databaseFiles = await findCompleteDatabaseSet(stagingDirectory);
    if (!databaseFiles) {
      return { status: "failed", failureCode: "signature_set_incomplete" };
    }

    for (const filePath of databaseFiles) {
      const valid = await runClamAvCommand(
        execFile,
        "sigtool",
        ["--info", filePath],
        options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS
      );
      if (!valid) {
        return { status: "failed", failureCode: "signature_validation_failed" };
      }
    }

    const lastSuccessfulAt = (options.now?.() ?? new Date()).toISOString();
    const signatureVersion = `clamav-${lastSuccessfulAt.replaceAll(/[-:.]/gu, "")}`;
    if (
      !(await promoteStagedSet(stagingDirectory, currentDirectory, operationId, {
        version: 1,
        signatureVersion,
        lastSuccessfulAt,
        databaseDirectory: `sets/${signatureVersion}`
      }))
    ) {
      return { status: "failed", failureCode: "promotion_failed" };
    }

    return { status: "refreshed", signatureVersion };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function readClamAvSignatureRefreshEnvironment(
  env: NodeJS.ProcessEnv
): ClamAvSignatureRefreshEnvironment {
  const rootDirectory = env.CLAMAV_SIGNATURE_ROOT?.trim() || "/var/lib/clamav";
  if (!isAbsolute(rootDirectory)) {
    throw new Error("CLAMAV_SIGNATURE_ROOT must be an absolute path");
  }
  return {
    rootDirectory,
    refreshTimeoutMs: readPositiveInt(
      env.CLAMAV_SIGNATURE_REFRESH_TIMEOUT_MS,
      DEFAULT_REFRESH_TIMEOUT_MS,
      "CLAMAV_SIGNATURE_REFRESH_TIMEOUT_MS"
    ),
    validationTimeoutMs: readPositiveInt(
      env.CLAMAV_SIGNATURE_VALIDATION_TIMEOUT_MS,
      DEFAULT_VALIDATION_TIMEOUT_MS,
      "CLAMAV_SIGNATURE_VALIDATION_TIMEOUT_MS"
    )
  };
}

async function findCompleteDatabaseSet(stagingDirectory: string): Promise<string[] | undefined> {
  let entries: string[];
  try {
    entries = await readdir(stagingDirectory);
  } catch {
    return undefined;
  }

  const selected: string[] = [];
  for (const databaseName of REQUIRED_DATABASE_NAMES) {
    const candidates = entries.filter(
      (entry) => entry === `${databaseName}.cvd` || entry === `${databaseName}.cld`
    );
    if (candidates.length !== 1) return undefined;
    const filePath = join(stagingDirectory, candidates[0]!);
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
    selected.push(filePath);
  }
  return selected;
}

async function promoteStagedSet(
  stagingDirectory: string,
  currentDirectory: string,
  operationId: string,
  manifest: {
    version: 1;
    signatureVersion: string;
    lastSuccessfulAt: string;
    databaseDirectory: string;
  }
): Promise<boolean> {
  const manifestPath = join(currentDirectory, "manifest.json");
  const manifestTemporaryPath = join(currentDirectory, `.manifest-${operationId}.tmp`);
  const setsDirectory = join(currentDirectory, "sets");
  const promotedDirectory = join(setsDirectory, manifest.signatureVersion);
  let databasePromoted = false;
  try {
    try {
      const currentStats = await lstat(currentDirectory);
      if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) return false;
    } catch (error) {
      if (!isMissingFileError(error)) return false;
      await mkdir(currentDirectory, { mode: 0o700 });
    }

    const previousDatabaseDirectory = await readPreviousDatabaseDirectory(manifestPath);
    await mkdir(setsDirectory, { mode: 0o700 });
    await rename(stagingDirectory, promotedDirectory);
    databasePromoted = true;
    await writeFile(manifestTemporaryPath, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(manifestTemporaryPath, manifestPath);
    await removeRetiredDatabaseSets(
      setsDirectory,
      manifest.signatureVersion,
      previousDatabaseDirectory
    );
    return true;
  } catch {
    await rm(manifestTemporaryPath, { force: true }).catch(() => undefined);
    if (databasePromoted) {
      await rm(promotedDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    return false;
  }
}

async function readPreviousDatabaseDirectory(manifestPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      databaseDirectory?: unknown;
    };
    const match =
      typeof manifest.databaseDirectory === "string"
        ? /^sets\/([A-Za-z0-9._-]{1,120})$/u.exec(manifest.databaseDirectory)
        : undefined;
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function removeRetiredDatabaseSets(
  setsDirectory: string,
  currentDatabaseDirectory: string,
  previousDatabaseDirectory: string | undefined
): Promise<void> {
  try {
    const retained = new Set(
      [currentDatabaseDirectory, previousDatabaseDirectory].filter(
        (value): value is string => value !== undefined
      )
    );
    for (const entry of await readdir(setsDirectory)) {
      if (!/^clamav-[A-Za-z0-9._-]{1,113}$/u.test(entry) || retained.has(entry)) continue;
      const entryPath = join(setsDirectory, entry);
      const stats = await lstat(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await rm(entryPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Retired sets are best-effort cleanup after the manifest has been promoted.
  }
}

async function runClamAvCommand(
  execFile: ClamAvRefreshExecFile,
  command: string,
  args: string[],
  timeout: number
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          timeout,
          windowsHide: true,
          maxBuffer: 64 * 1024
        },
        (error) => resolve(!error)
      );
    } catch {
      resolve(false);
    }
  });
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isMissingFileError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function main(): Promise<void> {
  let result: ClamAvSignatureRefreshResult;
  try {
    result = await refreshClamAvSignatures({
      ...readClamAvSignatureRefreshEnvironment(process.env)
    });
  } catch {
    result = { status: "failed", failureCode: "promotion_failed" };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "refreshed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { RedisAgentJobStore } from "../agent/jobs.js";
import { scanWithClamAvCli } from "../attachments/clamav-cli.js";
import { runAttachmentScanWorker } from "../attachments/scan-worker.js";
import { RedisAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createLineSdkContentClient } from "../clients/line.js";
import { loadConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import { createRedisRuntime } from "../redis.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AttachmentScanJobEnvironment {
  workId: string;
  databaseDirectory: string;
  signatureManifestPath: string;
  scanTimeoutMs: number;
}

export function readAttachmentScanJobEnvironment(
  env: NodeJS.ProcessEnv
): AttachmentScanJobEnvironment {
  const workId = env.WORK_ID?.trim();
  if (!workId || !UUID_PATTERN.test(workId)) {
    throw new Error("WORK_ID is required and must be an opaque UUID");
  }
  const databaseDirectory = env.CLAMAV_DATABASE_DIRECTORY?.trim();
  if (!databaseDirectory || !isAbsolute(databaseDirectory)) {
    throw new Error("CLAMAV_DATABASE_DIRECTORY must be an absolute path");
  }
  const signatureManifestPath =
    env.CLAMAV_SIGNATURE_MANIFEST_PATH?.trim() || join(databaseDirectory, "manifest.json");
  if (!isAbsolute(signatureManifestPath)) {
    throw new Error("CLAMAV_SIGNATURE_MANIFEST_PATH must be an absolute path");
  }
  const scanTimeoutMs = readPositiveInt(env.CLAMAV_SCAN_TIMEOUT_MS, 15_000);
  return { workId, databaseDirectory, signatureManifestPath, scanTimeoutMs };
}

export async function runAttachmentScanJob(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ exitCode: number; status: Record<string, string> }> {
  let redis: Awaited<ReturnType<typeof createRedisRuntime>>;
  let postgres: Awaited<ReturnType<typeof createPostgresRuntime>>;
  try {
    const jobEnvironment = readAttachmentScanJobEnvironment(env);
    const config = loadConfigFromEnv(env);
    if (!config.redis) throw new Error("scan_job_redis_required");
    if (!config.database) throw new Error("scan_job_database_required");
    if (!config.graph) throw new Error("scan_job_graph_required");

    redis = await createRedisRuntime(config.redis, { onError: () => undefined });
    postgres = await createPostgresRuntime(config.database);
    if (!redis || !postgres) throw new Error("scan_job_state_unavailable");

    const agentJobStore = new RedisAgentJobStore({
      client: redis.client,
      keyPrefix: redis.keyPrefix
    });
    const workStore = new RedisAttachmentScanWorkStore({
      client: redis.client,
      keyPrefix: redis.keyPrefix,
      jobStore: agentJobStore
    });
    const catalog = await createCatalogStore({ db: postgres.pool });
    await seedCatalogSources({
      catalog,
      sources: buildCatalogSourceSeedsForProfiles(env, config.profiles)
    });
    const graph = createGraphDriveClient(config.graph);
    const signatureManifest = await readSignatureManifest(jobEnvironment.signatureManifestPath);
    const result = await runAttachmentScanWorker(jobEnvironment.workId, {
      workStore,
      lineContent: createLineSdkContentClient(),
      profiles: config.profiles,
      publisher: createResourceBinaryPublisher({ catalog, graph }),
      scanner: {
        scan: (input) => scanWithClamAvCli(input)
      },
      signatureManifest,
      databaseDirectory: jobEnvironment.databaseDirectory,
      maxBytes: config.attachments.maxBytes,
      lineDownloadTimeoutMs: config.attachments.lineDownloadTimeoutMs,
      scanTimeoutMs: jobEnvironment.scanTimeoutMs
    });

    if (result.status === "completed") {
      return { exitCode: 0, status: { status: "completed" } };
    }
    if (result.status === "ignored") {
      return { exitCode: 0, status: { status: "ignored", reason: result.reason } };
    }
    return {
      exitCode: result.infrastructureFailure ? 1 : 0,
      status: { status: "failed", failureCode: result.failureCode }
    };
  } catch {
    return {
      exitCode: 1,
      status: { status: "failed", failureCode: "worker_failed" }
    };
  } finally {
    await closeRuntime(redis, postgres);
  }
}

async function readSignatureManifest(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("CLAMAV_SCAN_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

async function closeRuntime(
  redis: Awaited<ReturnType<typeof createRedisRuntime>>,
  postgres: Awaited<ReturnType<typeof createPostgresRuntime>>
): Promise<void> {
  try {
    const redisClient = redis?.client as
      (NonNullable<typeof redis>["client"] & { quit(): Promise<unknown> }) | undefined;
    await redisClient?.quit();
  } catch {
    // A finite worker is already exiting; do not emit provider details.
  }
  try {
    await postgres?.pool.end();
  } catch {
    // A finite worker is already exiting; do not emit provider details.
  }
}

async function main(): Promise<void> {
  const result = await runAttachmentScanJob();
  process.stdout.write(`${JSON.stringify(result.status)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

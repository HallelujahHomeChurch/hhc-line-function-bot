import { readFile } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { QueueServiceClient } from "@azure/storage-queue";

import { RedisAgentJobStore } from "../agent/jobs.js";
import { scanWithClamAvCli } from "../attachments/clamav-cli.js";
import { runAttachmentScanWorker } from "../attachments/scan-worker.js";
import type { AttachmentScanWorkerResult } from "../attachments/scan-worker.js";
import { loadAttachmentScanWorkerConfigFromEnv } from "../attachments/scan-worker-config.js";
import { RedisAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createExternalBinaryClient } from "../clients/external-binary.js";
import { createLineSdkContentClient } from "../clients/line.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import { createRedisRuntime } from "../redis.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTACHMENT_SCAN_REPLICA_TIMEOUT_MS = 900_000;

export interface AttachmentScanJobEnvironment {
  workId?: string;
  queueConnectionString?: string;
  queueName?: string;
  databaseDirectory: string;
  signatureManifestPath: string;
  scanTimeoutMs: number;
}

export function readAttachmentScanJobEnvironment(
  env: NodeJS.ProcessEnv
): AttachmentScanJobEnvironment {
  const workId = env.WORK_ID?.trim();
  if (workId && !UUID_PATTERN.test(workId)) {
    throw new Error("WORK_ID must be an opaque UUID");
  }
  const queueConnectionString = env.ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING?.trim();
  const queueName = env.ATTACHMENT_SCAN_QUEUE_NAME?.trim();
  if (!workId) {
    if (!queueConnectionString) {
      throw new Error("WORK_ID or ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING is required");
    }
    if (!queueName || !isValidQueueName(queueName)) {
      throw new Error("ATTACHMENT_SCAN_QUEUE_NAME is required and must be valid");
    }
  }
  const databaseDirectory = env.CLAMAV_DATABASE_DIRECTORY?.trim();
  if (!databaseDirectory || !isAbsolute(databaseDirectory)) {
    throw new Error("CLAMAV_DATABASE_DIRECTORY must be an absolute path");
  }
  const signatureManifestPath =
    env.CLAMAV_SIGNATURE_MANIFEST_PATH?.trim() ||
    posix.join(databaseDirectory.replaceAll("\\", "/"), "manifest.json");
  if (!isAbsolute(signatureManifestPath)) {
    throw new Error("CLAMAV_SIGNATURE_MANIFEST_PATH must be an absolute path");
  }
  const scanTimeoutMs = readPositiveInt(env.CLAMAV_SCAN_TIMEOUT_MS, 15_000);
  return {
    ...(workId ? { workId } : { queueConnectionString, queueName }),
    databaseDirectory,
    signatureManifestPath,
    scanTimeoutMs
  };
}

export interface AttachmentScanQueueReceiver {
  receiveMessages(options: { numberOfMessages: number; visibilityTimeout: number }): Promise<{
    receivedMessageItems: Array<{
      messageText: string;
      messageId: string;
      popReceipt: string;
    }>;
  }>;
  deleteMessage(messageId: string, popReceipt: string): Promise<unknown>;
}

export interface AttachmentScanWorkLease {
  workId: string;
  complete(): Promise<void>;
}

export async function receiveAttachmentScanWork(
  client: AttachmentScanQueueReceiver
): Promise<AttachmentScanWorkLease | undefined> {
  const response = await client.receiveMessages({
    numberOfMessages: 1,
    visibilityTimeout: 900
  });
  const message = response.receivedMessageItems[0];
  if (!message) return undefined;

  let workId: string | undefined;
  try {
    const value = JSON.parse(message.messageText) as unknown;
    if (
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 1 &&
      "workId" in value &&
      typeof value.workId === "string" &&
      UUID_PATTERN.test(value.workId)
    ) {
      workId = value.workId;
    }
  } catch {
    // Invalid queue content is acknowledged below without being logged.
  }
  if (!workId) {
    await client.deleteMessage(message.messageId, message.popReceipt);
    return undefined;
  }

  return {
    workId,
    complete: async () => {
      await client.deleteMessage(message.messageId, message.popReceipt);
    }
  };
}

export async function runAttachmentScanJob(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ exitCode: number; status: Record<string, string> }> {
  const startedAt = new Date();
  let redis: Awaited<ReturnType<typeof createRedisRuntime>>;
  let postgres: Awaited<ReturnType<typeof createPostgresRuntime>>;
  let queueLease: AttachmentScanWorkLease | undefined;
  try {
    const jobEnvironment = readAttachmentScanJobEnvironment(env);
    let workId = jobEnvironment.workId;
    if (!workId) {
      const queueClient = QueueServiceClient.fromConnectionString(
        jobEnvironment.queueConnectionString!
      ).getQueueClient(jobEnvironment.queueName!);
      queueLease = await receiveAttachmentScanWork(queueClient);
      if (!queueLease) {
        return { exitCode: 0, status: { status: "ignored", reason: "no_message" } };
      }
      workId = queueLease.workId;
    }
    const config = loadAttachmentScanWorkerConfigFromEnv(env);

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
    const result = await runAttachmentScanWorker(workId, {
      workStore,
      lineContent: createLineSdkContentClient(),
      externalBinary: createExternalBinaryClient(),
      profiles: config.profiles,
      publisher: createResourceBinaryPublisher({ catalog, graph }),
      scanner: {
        scan: (input) => scanWithClamAvCli(input)
      },
      readSignatureManifest: () => readSignatureManifest(jobEnvironment.signatureManifestPath),
      databaseDirectory: jobEnvironment.databaseDirectory,
      maxBytes: config.attachments.maxBytes,
      lineDownloadTimeoutMs: config.attachments.lineDownloadTimeoutMs,
      externalDownloadTimeoutMs: config.externalResources.downloadTimeoutMs,
      externalMaxRedirects: config.externalResources.maxRedirects,
      scanTimeoutMs: jobEnvironment.scanTimeoutMs,
      publicationDeadline: attachmentScanPublicationDeadline(startedAt)
    });

    if (result.status === "completed") {
      await queueLease?.complete();
      return { exitCode: 0, status: { status: "completed" } };
    }
    if (result.status === "ignored") {
      const acknowledge = shouldAcknowledgeAttachmentScanResult(result);
      if (acknowledge) {
        await queueLease?.complete();
      }
      return {
        exitCode: acknowledge ? 0 : 1,
        status: { status: "ignored", reason: result.reason }
      };
    }
    if (!result.infrastructureFailure) {
      await queueLease?.complete();
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

export function attachmentScanPublicationDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + ATTACHMENT_SCAN_REPLICA_TIMEOUT_MS);
}

export function shouldAcknowledgeAttachmentScanResult(result: AttachmentScanWorkerResult): boolean {
  return (
    result.status === "completed" ||
    (result.status === "failed" && !result.infrastructureFailure) ||
    (result.status === "ignored" && (result.reason === "terminal" || result.reason === "missing"))
  );
}

function isValidQueueName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/u.test(value) && !value.includes("--");
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

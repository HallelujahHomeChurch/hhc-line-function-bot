import { pathToFileURL } from "node:url";

import { ManagedIdentityCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

import { RedisAgentJobStore } from "../agent/jobs.js";
import {
  runAttachmentAssetWorker,
  type AttachmentAssetWorkerResult
} from "../attachments/asset-worker.js";
import { ATTACHMENT_SCAN_TIMING } from "../attachments/scan-timing.js";
import { loadAttachmentScanWorkerConfigFromEnv } from "../attachments/scan-worker-config.js";
import { RedisAttachmentScanWorkStore } from "../attachments/scan-work-store.js";
import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { assetAccessTokenScope, createAssetApiClient } from "../clients/asset-api.js";
import { createExternalBinaryClient } from "../clients/external-binary.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createLineSdkContentClient } from "../clients/line.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createResourceBinaryPublisher } from "../functions/resource-binary-publisher.js";
import {
  runMediaSyncWorker,
  shouldAcknowledgeMediaSyncResult,
  type MediaSyncWorkerResult
} from "../media-sync/worker.js";
import { createRedisRuntime } from "../redis.js";
import {
  formatAttachmentScanJobStatus,
  receiveAttachmentScanWork,
  shouldAcknowledgeAttachmentScanResult,
  type AttachmentScanWorkLease
} from "./run-attachment-scan-job.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AttachmentAssetJobEnvironment {
  queueUrl: string;
  assetApiUrl: string;
  assetApiAudience: string;
  managedIdentityClientId: string;
}

export function readAttachmentAssetJobEnvironment(
  env: NodeJS.ProcessEnv
): AttachmentAssetJobEnvironment {
  const queueUrl = requiredHttpsUrl(env, "ATTACHMENT_SCAN_QUEUE_URL");
  const assetApiUrl = requiredHttpsUrl(env, "ASSET_API_URL");
  const assetApiAudience = env.ASSET_API_AUDIENCE?.trim();
  if (!assetApiAudience || !/^(?:api|https):\/\//u.test(assetApiAudience)) {
    throw new Error("ASSET_API_AUDIENCE is required and must be an application URI");
  }
  const managedIdentityClientId = env.AZURE_CLIENT_ID?.trim();
  if (!managedIdentityClientId || !UUID_PATTERN.test(managedIdentityClientId)) {
    throw new Error("AZURE_CLIENT_ID is required and must be a UUID");
  }
  return { queueUrl, assetApiUrl, assetApiAudience, managedIdentityClientId };
}

export { assetAccessTokenScope } from "../clients/asset-api.js";

export function attachmentAssetDeadlines(startedAt: Date): {
  scanDeadline: Date;
  publicationDeadline: Date;
} {
  return {
    scanDeadline: new Date(startedAt.getTime() + ATTACHMENT_SCAN_TIMING.scanDeadlineMs),
    publicationDeadline: new Date(
      startedAt.getTime() + ATTACHMENT_SCAN_TIMING.publicationDeadlineMs
    )
  };
}

export async function runAttachmentAssetJob(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ exitCode: number; status: Record<string, string> }> {
  const startedAt = new Date();
  let redis: Awaited<ReturnType<typeof createRedisRuntime>>;
  let postgres: Awaited<ReturnType<typeof createPostgresRuntime>>;
  try {
    const job = readAttachmentAssetJobEnvironment(env);
    const credential = new ManagedIdentityCredential(job.managedIdentityClientId);
    const queueLease = await receiveAttachmentScanWork(new QueueClient(job.queueUrl, credential));
    if (!queueLease) return { exitCode: 0, status: { status: "ignored", reason: "no_message" } };

    const config = loadAttachmentScanWorkerConfigFromEnv(env);
    redis = await createRedisRuntime(config.redis, { onError: () => undefined });
    postgres = await createPostgresRuntime(config.database);
    if (!redis || !postgres) throw new Error("asset_job_state_unavailable");
    const postgresRuntime = postgres;

    const agentJobStore = new RedisAgentJobStore({
      client: redis.client,
      keyPrefix: redis.keyPrefix
    });
    const workStore = new RedisAttachmentScanWorkStore({
      client: redis.client,
      keyPrefix: redis.keyPrefix,
      jobStore: agentJobStore
    });
    const catalog = await createCatalogStore({ db: postgresRuntime.pool });
    await seedCatalogSources({
      catalog,
      sources: buildCatalogSourceSeedsForProfiles(env, config.profiles)
    });
    const assets = createAssetApiClient({
      baseUrl: job.assetApiUrl,
      getAccessToken: async () => {
        const token = await credential.getToken(assetAccessTokenScope(job.assetApiAudience));
        if (!token?.token) throw new Error("asset_api_token_unavailable");
        return token.token;
      },
      onRejection: (telemetry) => process.stdout.write(`${JSON.stringify(telemetry)}\n`)
    });
    const lineContent = createLineSdkContentClient();
    const publisher = createResourceBinaryPublisher({
      catalog,
      graph: createGraphDriveClient(config.graph)
    });
    const deadlines = attachmentAssetDeadlines(startedAt);
    return await runAttachmentAssetQueueLease(queueLease, {
      runAttachment: (workId) =>
        runAttachmentAssetWorker(workId, {
          workStore,
          assets,
          lineContent,
          externalBinary: createExternalBinaryClient(),
          profiles: config.profiles,
          publisher,
          maxBytes: config.attachments.maxBytes,
          lineDownloadTimeoutMs: config.attachments.lineDownloadTimeoutMs,
          externalDownloadTimeoutMs: config.externalResources.downloadTimeoutMs,
          externalMaxRedirects: config.externalResources.maxRedirects,
          scanDeadline: deadlines.scanDeadline,
          publicationDeadline: deadlines.publicationDeadline
        }),
      runMediaSync: (workId) =>
        runMediaSyncWorker(workId, {
          store: postgresRuntime.mediaSyncStore,
          assets,
          lineContent,
          profiles: config.profiles,
          workerLeaseMs: ATTACHMENT_SCAN_TIMING.claimLeaseMs,
          retryDelayMs: 30_000,
          lineDownloadTimeoutMs: config.attachments.lineDownloadTimeoutMs,
          maxBytes: config.mediaSyncMaxBytes,
          manualMaxBytes: config.attachments.maxBytes,
          publisher,
          agentJobStore
        })
    });
  } catch {
    return { exitCode: 1, status: { status: "failed", failureCode: "worker_failed" } };
  } finally {
    await closeRuntime(redis, postgres);
  }
}

export async function runAttachmentAssetQueueLease(
  lease: AttachmentScanWorkLease,
  handlers: {
    runAttachment(workId: string): Promise<AttachmentAssetWorkerResult>;
    runMediaSync(workId: string): Promise<MediaSyncWorkerResult>;
  }
): Promise<{ exitCode: number; status: Record<string, string> }> {
  if (lease.kind === "media-sync") {
    const result = await handlers.runMediaSync(lease.workId);
    const acknowledge = shouldAcknowledgeMediaSyncResult(result);
    if (acknowledge) await lease.complete();
    return {
      exitCode: acknowledge ? 0 : 1,
      status: formatMediaSyncJobStatus(result)
    };
  }
  const result = await handlers.runAttachment(lease.workId);
  const acknowledge = shouldAcknowledgeAttachmentScanResult(result);
  if (acknowledge) await lease.complete();
  return {
    exitCode: acknowledge ? 0 : 1,
    status: formatAttachmentScanJobStatus(result)
  };
}

function formatMediaSyncJobStatus(result: MediaSyncWorkerResult): Record<string, string> {
  return result.status === "completed" ||
    result.status === "contention" ||
    result.status === "missing" ||
    result.status === "terminal"
    ? { status: result.status }
    : { status: result.status, reason: result.reason };
}

function requiredHttpsUrl(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field]?.trim();
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:") throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`${field} is required and must be an HTTPS URL`);
  }
}

async function closeRuntime(
  redis: Awaited<ReturnType<typeof createRedisRuntime>> | undefined,
  postgres: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
): Promise<void> {
  try {
    await (redis?.client as { quit(): Promise<unknown> } | undefined)?.quit();
  } catch {
    // The finite worker is already exiting.
  }
  try {
    await postgres?.pool.end();
  } catch {
    // The finite worker is already exiting.
  }
}

async function main(): Promise<void> {
  const result = await runAttachmentAssetJob();
  process.stdout.write(`${JSON.stringify(result.status)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

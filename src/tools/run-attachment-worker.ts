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
import { MeetingWindowClient, meetingAccessTokenScope } from "../media-sync/meeting-client.js";
import { logMediaSyncTiming } from "../media-sync/timing.js";
import { createRedisRuntime } from "../redis.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  kind: "attachment" | "media-sync";
  workId: string;
  complete(): Promise<void>;
}

export async function receiveAttachmentScanWork(
  client: AttachmentScanQueueReceiver
): Promise<AttachmentScanWorkLease | undefined> {
  const response = await client.receiveMessages({
    numberOfMessages: 1,
    visibilityTimeout: ATTACHMENT_SCAN_TIMING.queueVisibilityMs / 1000
  });
  const message = response.receivedMessageItems[0];
  if (!message) return undefined;

  let workId: string | undefined;
  let kind: "attachment" | "media-sync" | undefined;
  try {
    const value = JSON.parse(message.messageText) as unknown;
    if (value && typeof value === "object" && "workId" in value) {
      const keys = Object.keys(value);
      const rawKind = "kind" in value ? value.kind : "attachment";
      if (
        (keys.length === 1 ||
          (keys.length === 2 && keys.includes("kind") && keys.includes("workId"))) &&
        (rawKind === "attachment" || rawKind === "media-sync") &&
        typeof value.workId === "string" &&
        UUID_PATTERN.test(value.workId)
      ) {
        workId = value.workId;
        kind = rawKind;
      }
    }
  } catch {
    // Invalid queue content is acknowledged below without being logged.
  }
  if (!workId) {
    await client.deleteMessage(message.messageId, message.popReceipt);
    return undefined;
  }

  return {
    kind: kind!,
    workId,
    complete: async () => {
      await client.deleteMessage(message.messageId, message.popReceipt);
    }
  };
}

export function shouldAcknowledgeAttachmentWorkerResult(
  result: AttachmentAssetWorkerResult
): boolean {
  return (
    result.status === "completed" ||
    result.status === "permanent_failure" ||
    result.status === "missing"
  );
}

export function formatAttachmentWorkerStatus(
  result: AttachmentAssetWorkerResult
): Record<string, string> {
  if (result.status === "completed") {
    return { status: "completed", signatureHealth: result.signatureHealth };
  }
  if (
    result.status === "scan_pending" ||
    result.status === "contention" ||
    result.status === "missing"
  ) {
    return { status: result.status };
  }
  return { status: result.status, failureCode: result.failureCode };
}

export interface AttachmentWorkerEnvironment {
  queueUrl: string;
  assetApiUrl: string;
  assetApiAudience: string;
  managedIdentityClientId: string;
}

export function readAttachmentWorkerEnvironment(
  env: NodeJS.ProcessEnv
): AttachmentWorkerEnvironment {
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

export function attachmentWorkerDeadlines(startedAt: Date): {
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

export async function runAttachmentWorker(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ exitCode: number; status: Record<string, string> }> {
  let runtime: Awaited<ReturnType<typeof createAttachmentWorkerRuntime>> | undefined;
  try {
    runtime = await createAttachmentWorkerRuntime(env);
    const queueLease = await receiveAttachmentScanWork(runtime.queue);
    if (!queueLease) return { exitCode: 0, status: { status: "ignored", reason: "no_message" } };
    return await runtime.run(queueLease, false);
  } catch {
    return { exitCode: 1, status: { status: "failed", failureCode: "worker_failed" } };
  } finally {
    await runtime?.close();
  }
}

export async function runAttachmentWorkerLoop(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal; sleep?: (milliseconds: number) => Promise<void> } = {}
): Promise<void> {
  const runtime = await createAttachmentWorkerRuntime(env);
  const meetingUrl = requiredHttpsUrl(env, "MEETING_API_BASE_URL");
  const meetingAudience = requiredAudience(env, "MEETING_API_AUDIENCE");
  const warmQueueUrl = requiredHttpsUrl(env, "MEDIA_SYNC_WARM_QUEUE_URL");
  const warmQueue = new QueueClient(warmQueueUrl, runtime.credential);
  const meetings = new MeetingWindowClient({
    baseUrl: meetingUrl,
    getAccessToken: async () => {
      const token = await runtime.credential.getToken(meetingAccessTokenScope(meetingAudience));
      if (!token?.token) throw new Error("meeting_api_token_unavailable");
      return token.token;
    }
  });
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  try {
    while (!options.signal?.aborted) {
      await consumeWarmPulse(warmQueue);
      const lease = await receiveAttachmentScanWork(runtime.queue);
      if (!lease) {
        await sleep(1_000);
        continue;
      }
      const warm = await meetings.isWarm().catch(() => false);
      await runtime.run(lease, warm);
    }
  } finally {
    await runtime.close();
  }
}

async function createAttachmentWorkerRuntime(env: NodeJS.ProcessEnv) {
  const job = readAttachmentWorkerEnvironment(env);
  const credential = new ManagedIdentityCredential(job.managedIdentityClientId);
  const queue = new QueueClient(job.queueUrl, credential);
  let redis: Awaited<ReturnType<typeof createRedisRuntime>>;
  let postgres: Awaited<ReturnType<typeof createPostgresRuntime>>;
  try {
    const config = loadAttachmentScanWorkerConfigFromEnv(env);
    redis = await createRedisRuntime(config.redis, { onError: () => undefined });
    postgres = await createPostgresRuntime(config.database);
    if (!redis || !postgres) throw new Error("asset_job_state_unavailable");
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
    return {
      credential,
      queue,
      run: (lease: AttachmentScanWorkLease, warm: boolean) => {
        const deadlines = attachmentWorkerDeadlines(new Date());
        return runAttachmentWorkerQueueLease(lease, {
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
              store: postgres!.mediaSyncStore,
              assets,
              lineContent,
              profiles: config.profiles,
              workerLeaseMs: ATTACHMENT_SCAN_TIMING.claimLeaseMs,
              retryDelayMs: 30_000,
              warm,
              lineDownloadTimeoutMs: config.attachments.lineDownloadTimeoutMs,
              maxBytes: config.mediaSyncMaxBytes,
              manualMaxBytes: config.attachments.maxBytes,
              publisher,
              agentJobStore,
              onTiming: logMediaSyncTiming
            })
        });
      },
      close: () => closeRuntime(redis, postgres)
    };
  } catch (error) {
    await closeRuntime(redis, postgres);
    throw error;
  }
}

async function consumeWarmPulse(client: AttachmentScanQueueReceiver): Promise<void> {
  const response = await client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 30 });
  const message = response.receivedMessageItems[0];
  if (message) await client.deleteMessage(message.messageId, message.popReceipt);
}

export async function runAttachmentWorkerQueueLease(
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
  const acknowledge = shouldAcknowledgeAttachmentWorkerResult(result);
  if (acknowledge) await lease.complete();
  return {
    exitCode: acknowledge ? 0 : 1,
    status: formatAttachmentWorkerStatus(result)
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

function requiredAudience(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field]?.trim();
  if (!value || !/^(?:api|https):\/\//u.test(value)) {
    throw new Error(`${field} is required and must be an application URI`);
  }
  return value;
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
  if (process.argv.includes("--loop")) {
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    await runAttachmentWorkerLoop(process.env, { signal: controller.signal });
    return;
  }
  const result = await runAttachmentWorker();
  process.stdout.write(`${JSON.stringify(result.status)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

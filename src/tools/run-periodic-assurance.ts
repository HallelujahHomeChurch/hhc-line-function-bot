import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ManagedIdentityCredential } from "@azure/identity";
import { QueueServiceClient } from "@azure/storage-queue";
import { Client, LogLevel } from "@notionhq/client";

import { scanWithClamAvCli } from "../attachments/clamav-cli.js";
import {
  runPeriodicAssurance,
  type PeriodicAssuranceDependencies,
  type PeriodicAssuranceInput
} from "../assurance/periodic-probe.js";
import { runAssetLifecycleAssurance } from "../assurance/asset-lifecycle-probe.js";
import {
  assetAccessTokenScope,
  createAssetApiClient,
  type AssetApiClient,
  type AssetApiRejectionTelemetry
} from "../clients/asset-api.js";
import { createGraphDriveClient, type CreateGraphDriveClientOptions } from "../clients/graph.js";
import type { GraphConfig, GraphDriveClient } from "../types.js";

const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const ASSET_OPERATION_TIMEOUT_MS = 180_000;
const ASSET_CLEANUP_TIMEOUT_MS = 30_000;
const ASSET_POLL_INTERVAL_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PeriodicNotionClient {
  databases: {
    retrieve(input: { database_id: string }): Promise<{
      data_sources?: Array<{ id?: string }>;
    }>;
  };
  dataSources: {
    retrieve(input: { data_source_id: string }): Promise<unknown>;
    query(input: { data_source_id: string; page_size: 1 }): Promise<{ results: unknown[] }>;
  };
}

export interface PeriodicQueueClient {
  getProperties(): Promise<{ approximateMessagesCount?: number }>;
  peekMessages(input: { numberOfMessages: 1 }): Promise<{
    peekedMessageItems: Array<{ insertedOn: Date }>;
  }>;
}

export interface PeriodicAssuranceAdapterFactories {
  createGraph(config: GraphConfig, options: CreateGraphDriveClientOptions): GraphDriveClient;
  createNotion(options: { auth: string; logLevel: LogLevel; retry: false }): PeriodicNotionClient;
  createQueue(
    connectionString: string,
    queueName: string,
    options: { retryOptions: { maxTries: 1 } }
  ): PeriodicQueueClient;
  createCredential(clientId: string): {
    getToken(
      scope: string,
      options: { abortSignal?: AbortSignal }
    ): Promise<{ token: string } | null>;
  };
  createAsset(options: {
    baseUrl: string;
    getAccessToken: (signal?: AbortSignal) => Promise<string>;
    onRejection: (telemetry: AssetApiRejectionTelemetry) => void;
  }): AssetApiClient;
}

const defaultAdapterFactories: PeriodicAssuranceAdapterFactories = {
  createGraph: createGraphDriveClient,
  createNotion: (options) => new Client(options) as unknown as PeriodicNotionClient,
  createQueue: (connectionString, queueName, options) =>
    QueueServiceClient.fromConnectionString(connectionString, options).getQueueClient(queueName),
  createCredential: (clientId) => new ManagedIdentityCredential(clientId),
  createAsset: createAssetApiClient
};

export async function runPeriodicAssuranceCli(
  env: Record<string, string | undefined>,
  dependencies?: PeriodicAssuranceDependencies,
  writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Promise<0 | 1> {
  const input = readInput(env);
  const result = await runPeriodicAssurance(
    input,
    dependencies ?? createPeriodicAssuranceDependencies(env)
  );
  writeLine(JSON.stringify(result));
  return result.status === "passed" ? 0 : 1;
}

export async function readOneNotionResult(
  notion: PeriodicNotionClient,
  databaseOrDataSourceId: string,
  pageSize: 1
): Promise<number> {
  let dataSourceId = databaseOrDataSourceId;
  try {
    await notion.dataSources.retrieve({ data_source_id: databaseOrDataSourceId });
  } catch {
    const database = await notion.databases.retrieve({
      database_id: databaseOrDataSourceId
    });
    const resolved = database.data_sources?.find((source) => source.id)?.id;
    if (!resolved) throw new Error("periodic_assurance_notion_data_source_missing");
    dataSourceId = resolved;
  }
  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    page_size: pageSize
  });
  return response.results.slice(0, pageSize).length;
}

function readInput(env: Record<string, string | undefined>): PeriodicAssuranceInput {
  return {
    graphDriveId: required(env, "GRAPH_DRIVE_ID"),
    graphOtherFolderItemId: required(env, "GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID"),
    notionDatabaseId: required(env, "NOTION_SERVICE_DATABASE_ID"),
    clamavSignatureManifestPath: required(env, "CLAMAV_SIGNATURE_MANIFEST_PATH"),
    scanTimeoutMs: positiveInteger(env.CLAMAV_SCAN_TIMEOUT_MS, DEFAULT_SCAN_TIMEOUT_MS)
  };
}

export function createPeriodicAssuranceDependencies(
  env: Record<string, string | undefined>,
  factories: PeriodicAssuranceAdapterFactories = defaultAdapterFactories
): PeriodicAssuranceDependencies {
  const graph = factories.createGraph(graphConfig(env), { noRetry: true });
  if (!graph.getItemById || !graph.ensureFolder || !graph.uploadFile || !graph.deleteItem) {
    throw new Error("periodic_assurance_graph_adapter_invalid");
  }
  const notion = factories.createNotion({
    auth: required(env, "NOTION_TOKEN"),
    logLevel: LogLevel.ERROR,
    retry: false
  });
  const queue = factories.createQueue(
    required(env, "ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING"),
    required(env, "ATTACHMENT_SCAN_QUEUE_NAME"),
    { retryOptions: { maxTries: 1 } }
  );
  const credential = factories.createCredential(requiredUuid(env, "AZURE_CLIENT_ID"));
  const assetAudience = requiredApplicationUri(env, "ASSET_API_AUDIENCE");
  const assets = factories.createAsset({
    baseUrl: requiredHttpsUrl(env, "ASSET_API_URL"),
    getAccessToken: async (signal) => {
      const token = await credential.getToken(assetAccessTokenScope(assetAudience), {
        abortSignal: signal
      });
      if (!token?.token) throw new Error("periodic_assurance_asset_token_unavailable");
      return token.token;
    },
    onRejection: (telemetry) => process.stdout.write(`${JSON.stringify(telemetry)}\n`)
  });

  return {
    readGraphMetadata: (driveId, itemId) => graph.getItemById!(driveId, itemId),
    readNotionOne: (databaseId, pageSize) =>
      readOneNotionResult(notion as unknown as PeriodicNotionClient, databaseId, pageSize),
    inspectQueue: async () => {
      const [properties, peeked] = await Promise.all([
        queue.getProperties(),
        queue.peekMessages({ numberOfMessages: 1 })
      ]);
      return {
        depth: properties.approximateMessagesCount ?? 0,
        ...(peeked.peekedMessageItems[0]?.insertedOn
          ? { oldestInsertedAt: peeked.peekedMessageItems[0].insertedOn }
          : {})
      };
    },
    readSignatureManifest: async (path) => JSON.parse(await readFile(path, "utf8")) as unknown,
    scanSample: async ({ fileName, data, databaseDirectory, timeoutMs }) => {
      const directory = await mkdtemp(join(tmpdir(), "hhc-periodic-assurance-"));
      try {
        const filePath = join(directory, fileName);
        await writeFile(filePath, data, { flag: "wx" });
        return await scanWithClamAvCli({ filePath, databaseDirectory, timeoutMs });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    ensureDiagnosticsFolder: (driveId, parentItemId, name) =>
      graph.ensureFolder!(driveId, parentItemId, name),
    uploadDiagnostic: (driveId, parentItemId, fileName, data, contentType) =>
      graph.uploadFile!(driveId, parentItemId, fileName, data, contentType),
    deleteDiagnostic: (driveId, itemId) => graph.deleteItem!(driveId, itemId),
    runAssetLifecycle: () =>
      runAssetLifecycleAssurance(
        {
          operationTimeoutMs: ASSET_OPERATION_TIMEOUT_MS,
          cleanupTimeoutMs: ASSET_CLEANUP_TIMEOUT_MS,
          pollIntervalMs: ASSET_POLL_INTERVAL_MS
        },
        assets
      ),
    now: () => new Date()
  };
}

function graphConfig(env: Record<string, string | undefined>): GraphConfig {
  return {
    tenantId: required(env, "GRAPH_TENANT_ID"),
    clientId: required(env, "GRAPH_CLIENT_ID"),
    clientSecret: required(env, "GRAPH_CLIENT_SECRET"),
    driveId: required(env, "GRAPH_DRIVE_ID"),
    pptFolderItemId: required(env, "GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID"),
    sheetMusicAllowedExtensions: [],
    allowedExtensions: [],
    defaultIncludePdf: false,
    linkType: "view",
    linkScope: "organization"
  };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error("periodic_assurance_invalid_input");
  return value;
}

function requiredHttpsUrl(env: Record<string, string | undefined>, key: string): string {
  try {
    const url = new URL(required(env, key));
    if (url.protocol !== "https:") throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error("periodic_assurance_invalid_input");
  }
}

function requiredApplicationUri(env: Record<string, string | undefined>, key: string): string {
  const value = required(env, key);
  if (!/^(?:api|https):\/\//u.test(value)) throw new Error("periodic_assurance_invalid_input");
  return value;
}

function requiredUuid(env: Record<string, string | undefined>, key: string): string {
  const value = required(env, key);
  if (!UUID_PATTERN.test(value)) throw new Error("periodic_assurance_invalid_input");
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("periodic_assurance_invalid_input");
  }
  return parsed;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runPeriodicAssuranceCli(process.env);
  } catch {
    process.stdout.write(
      '{"status":"failed","checks":[],"queue":{"depth":0,"oldestAgeSeconds":null},"providerRequests":{"deepseek":0,"embedding":0}}\n'
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

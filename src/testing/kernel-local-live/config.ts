import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AppConfig, ProviderPolicy } from "../../types.js";

const SECRET_NAMES = ["azure-openai-embedding-key", "deepseek-api-key"] as const;
const REJECTED_ENVIRONMENT_KEYS = [
  "LINE_HELPER_CHANNEL_SECRET",
  "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
  "GRAPH_CLIENT_SECRET",
  "NOTION_TOKEN",
  "ATTACHMENT_SCAN_QUEUE_URL",
  "SEARXNG_BASE_URL"
] as const;

export interface KernelLocalLiveSecrets {
  readonly deepSeekApiKey: string;
  readonly azureEmbeddingApiKey: string;
  toJSON(): never;
}

export interface KernelLocalLiveSecretFileReader {
  lstat(filePath: string): Promise<{
    mode: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(filePath: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
}

const defaultSecretFileReader: KernelLocalLiveSecretFileReader = {
  lstat,
  readFile: (filePath) => readFile(filePath, "utf8"),
  readdir
};

export async function readKernelLocalLiveSecrets(
  directory: string,
  reader: KernelLocalLiveSecretFileReader = defaultSecretFileReader
): Promise<KernelLocalLiveSecrets> {
  const names = [...(await reader.readdir(directory))].sort();
  if (
    names.length !== SECRET_NAMES.length ||
    names.some((name, index) => name !== SECRET_NAMES[index])
  ) {
    throw new Error("kernel_local_live_secret_set_invalid");
  }
  const values = new Map<string, string>();
  for (const name of SECRET_NAMES) {
    const filePath = path.join(directory, name);
    const metadata = await reader.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("kernel_local_live_secret_not_regular");
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("kernel_local_live_secret_mode_invalid");
    }
    const value = (await reader.readFile(filePath)).trim();
    if (!value) throw new Error("kernel_local_live_secret_empty");
    values.set(name, value);
  }
  return Object.freeze({
    deepSeekApiKey: values.get("deepseek-api-key")!,
    azureEmbeddingApiKey: values.get("azure-openai-embedding-key")!,
    toJSON(): never {
      throw new Error("kernel_local_live_secrets_not_serializable");
    }
  });
}

export function createKernelLocalLiveConfig(
  environment: Record<string, string | undefined>,
  secrets: KernelLocalLiveSecrets
): AppConfig {
  if (REJECTED_ENVIRONMENT_KEYS.some((key) => environment[key]?.trim())) {
    throw new Error("kernel_local_live_production_setting_rejected");
  }
  const runId = environment.KERNEL_LOCAL_LIVE_RUN_ID?.trim();
  if (!runId || !/^[a-z0-9-]{1,64}$/u.test(runId)) {
    throw new Error("kernel_local_live_run_id_invalid");
  }
  const databaseUrl = localDatabaseUrl(environment.KERNEL_LOCAL_LIVE_POSTGRES_URL);
  const redisUrl = localRedisUrl(environment.KERNEL_LOCAL_LIVE_REDIS_URL);
  const providerPolicy: ProviderPolicy = {
    function_routing: { primary: "deepseek" },
    admin_routing: { primary: "deepseek" },
    memory_routing: { primary: "deepseek" },
    smart_talk: { primary: "deepseek" },
    general_agent: { primary: "deepseek" },
    context_compression: { primary: "deepseek" },
    web_summarization: { primary: "deepseek" }
  };

  return {
    serviceName: "kernel-local-live",
    host: "0.0.0.0",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    readyPath: "/readyz",
    maxBodyBytes: 262_144,
    attachments: {
      maxBytes: 1_048_576,
      lineDownloadTimeoutMs: 5_000
    },
    externalResources: {
      downloadTimeoutMs: 5_000,
      maxRedirects: 0
    },
    profiles: [
      {
        name: "acceptance",
        webhookPath: "/api/line/webhook/acceptance",
        channelSecret: "kernel-local-live-channel-secret",
        channelAccessToken: "kernel-local-live-channel-token",
        adminUserId: "U_KERNEL_ADMIN",
        adminDirectOnly: true,
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text", "file"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: ["query_schedule", "query_knowledge", "save_resource"],
        permissionRequiredFunctions: [],
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        registration: { enabled: true },
        allowedProviders: ["deepseek"],
        allowSubscriptionProviders: false,
        providerPolicy,
        controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
        agentRuntime: { taskFrameSeconds: 600 },
        schedulePolicy: {
          meetingWindows: [],
          domains: [
            {
              key: "synthetic_service",
              displayName: "Synthetic Service",
              aliases: ["synthetic service"],
              routingHints: ["投影", "音控"],
              schemaVersion: 1,
              inputSchema: "assignment_rows_v1",
              occurrencePolicy: "profile_meeting_windows_v1",
              binding: {
                kind: "canonical",
                sourceKeys: ["synthetic-schedule"],
                allowLiveFallback: false
              },
              origins: ["line"],
              writePolicy: { mode: "read_only", allowedOperations: [] },
              priority: 100,
              revision: "1",
              freshnessPolicy: { maxAgeSeconds: 86_400, staleBehavior: "reject" }
            }
          ]
        }
      }
    ],
    llm: {
      provider: "deepseek",
      deepseekApiKey: secrets.deepSeekApiKey,
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 8_000,
      generalMaxOutputTokens: 160,
      routeMaxOutputTokens: 256
    },
    knowledge: {
      notionToken: "kernel-local-live-disabled",
      embedding: {
        provider: "azure_openai",
        apiKey: secrets.azureEmbeddingApiKey,
        endpoint: "https://bible-text-embedding-resource.cognitiveservices.azure.com/",
        deployment: "text-embedding-3-small",
        apiVersion: "2024-10-21",
        model: "text-embedding-3-small",
        dimensions: 1536,
        batchSize: 2,
        timeoutMs: 30_000
      }
    },
    redis: {
      url: redisUrl,
      keyPrefix: `kernel-local-live:${runId}`
    },
    database: {
      url: databaseUrl,
      ssl: false
    },
    access: {
      registrationInviteCodeTtlMinutes: 5,
      confirmationTtlMinutes: 5
    },
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      maxRequests: 100
    },
    lastErrors: { maxEntries: 20 },
    observability: {
      hmacKey: "kernel-local-live-observability-key"
    }
  };
}

function localDatabaseUrl(value: string | undefined): string {
  const url = parsedUrl(value);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "postgres" ||
    url.port !== "5432" ||
    url.pathname !== "/hhc_line_acceptance" ||
    url.username !== "kernel" ||
    url.password !== "kernel" ||
    url.search ||
    url.hash
  ) {
    throw new Error("kernel_local_live_production_setting_rejected");
  }
  return url.toString();
}

function localRedisUrl(value: string | undefined): string {
  const url = parsedUrl(value);
  if (
    url.protocol !== "redis:" ||
    url.hostname !== "redis" ||
    url.port !== "6379" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("kernel_local_live_production_setting_rejected");
  }
  return url.toString();
}

function parsedUrl(value: string | undefined): URL {
  try {
    return new URL(value ?? "");
  } catch {
    throw new Error("kernel_local_live_production_setting_rejected");
  }
}

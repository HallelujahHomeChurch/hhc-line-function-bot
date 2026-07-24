import { readFileSync } from "node:fs";

import type {
  AttachmentConfig,
  DatabaseConfig,
  ExternalResourceConfig,
  GraphConfig,
  RedisConfig
} from "../types.js";

export interface AttachmentScanWorkerProfile {
  name: string;
  channelAccessToken: string;
}

export interface AttachmentScanWorkerConfig {
  profiles: AttachmentScanWorkerProfile[];
  attachments: AttachmentConfig;
  externalResources: ExternalResourceConfig;
  redis: RedisConfig;
  database: DatabaseConfig;
  graph: GraphConfig;
}

export function loadAttachmentScanWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv
): AttachmentScanWorkerConfig {
  const profileConfigPath = required(env, "PROFILE_CONFIG_PATH");
  const rawProfiles = JSON.parse(readFileSync(profileConfigPath, "utf8")) as unknown;
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
    throw new Error("PROFILE_CONFIG_PATH must contain profiles");
  }
  const profiles = rawProfiles.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("PROFILE_CONFIG_PATH contains an invalid profile");
    }
    const profile = value as Record<string, unknown>;
    const name = nonBlank(profile.name);
    const tokenEnv = nonBlank(profile.channelAccessTokenEnv);
    const directToken = nonBlank(profile.channelAccessToken);
    if (!name || (!tokenEnv && !directToken)) {
      throw new Error("PROFILE_CONFIG_PATH contains an invalid worker profile");
    }
    const channelAccessToken = directToken ?? required(env, tokenEnv!);
    return { name, channelAccessToken };
  });

  const driveId = required(env, "GRAPH_DRIVE_ID");
  return {
    profiles,
    attachments: {
      maxBytes: positiveInt(env.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024, "MAX_ATTACHMENT_BYTES"),
      lineDownloadTimeoutMs: positiveInt(
        env.LINE_CONTENT_DOWNLOAD_TIMEOUT_MS,
        30_000,
        "LINE_CONTENT_DOWNLOAD_TIMEOUT_MS"
      )
    },
    externalResources: {
      downloadTimeoutMs: positiveInt(
        env.EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS,
        15_000,
        "EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS"
      ),
      maxRedirects: nonNegativeInt(
        env.EXTERNAL_RESOURCE_MAX_REDIRECTS,
        3,
        "EXTERNAL_RESOURCE_MAX_REDIRECTS"
      )
    },
    redis: {
      url: required(env, "REDIS_URL"),
      keyPrefix: env.REDIS_KEY_PREFIX?.trim() || "hhc-line-function-bot"
    },
    database: {
      url: required(env, "DATABASE_URL"),
      ssl: env.DATABASE_SSL?.trim().toLowerCase() === "true"
    },
    graph: {
      tenantId: required(env, "GRAPH_TENANT_ID"),
      clientId: required(env, "GRAPH_CLIENT_ID"),
      clientSecret: required(env, "GRAPH_CLIENT_SECRET"),
      driveId,
      pptFolderItemId: required(env, "GRAPH_PPT_FOLDER_ITEM_ID"),
      sheetMusicAllowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
      allowedExtensions: [".pptx", ".ppt", ".key", ".odp"],
      defaultIncludePdf: false,
      linkType: "view",
      linkScope: "anonymous"
    }
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

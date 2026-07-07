import { Buffer } from "node:buffer";

import { z } from "zod";

import { readTimeZone } from "./time-zone.js";
import { FUNCTION_NAMES } from "./types.js";
import type { AppConfig, FunctionName } from "./types.js";

const profileSchema = z.object({
  name: z.string().min(1),
  webhookPath: z.string().startsWith("/"),
  channelSecret: z.string().min(1),
  channelAccessToken: z.string().min(1),
  allowDirectUser: z.boolean().default(false),
  allowRooms: z.boolean().default(false),
  allowedMessageTypes: z.array(z.string()).default(["text"]),
  groupRequireWakeWord: z.boolean().default(true),
  wakeKeywords: z.array(z.string()).default([]),
  acceptMention: z.boolean().default(true),
  enabledFunctions: z.array(z.enum(FUNCTION_NAMES)).default([]),
  adminUserId: z.string().optional(),
  adminDirectOnly: z.boolean().default(true),
  directAccessPolicy: z.enum(["managed", "public", "blocked"]).optional(),
  groupAccessPolicy: z.enum(["managed", "blocked"]).optional(),
  registration: z
    .object({
      enabled: z.boolean().default(false)
    })
    .default({ enabled: false })
});

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const profilesJson = readProfilesJson(env);
  const parsedProfiles = JSON.parse(profilesJson) as unknown;
  assertNoLegacyProfileFields(parsedProfiles);
  const profiles = z.array(profileSchema).min(1).parse(parsedProfiles);
  assertUniqueValues(
    profiles.map((profile) => profile.webhookPath),
    "Duplicate profile webhookPath"
  );
  assertCompleteGroup(env, graphRequiredKeys, "Incomplete Graph configuration");
  assertCompleteGroup(env, notionRequiredKeys, "Incomplete Notion configuration");
  const normalizedProfiles = profiles.map((profile) => normalizeProfile(profile));
  validateAccessConfig(normalizedProfiles, env);

  return {
    serviceName: env.SERVICE_NAME || "hhc-line-function-bot",
    host: env.HOST || "0.0.0.0",
    port: readInt(env.PORT, 3000),
    timeZone: readTimeZone(env.TIME_ZONE),
    healthPath: env.HEALTH_PATH || "/healthz",
    maxBodyBytes: readInt(env.MAX_BODY_BYTES, 262_144),
    profiles: normalizedProfiles.map((profile) => ({
      ...profile,
      enabledFunctions: profile.enabledFunctions as FunctionName[]
    })),
    llm: {
      ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      ollamaModel: env.OLLAMA_MODEL || "qwen3:4b-instruct",
      ollamaKeepAlive: readOllamaKeepAlive(env.OLLAMA_KEEP_ALIVE),
      timeoutMs: readInt(env.OLLAMA_TIMEOUT_MS, 8000),
      keywordFallbackEnabled: readBool(env.KEYWORD_FALLBACK_ENABLED, true)
    },
    graph:
      env.GRAPH_TENANT_ID &&
      env.GRAPH_CLIENT_ID &&
      env.GRAPH_CLIENT_SECRET &&
      env.GRAPH_DRIVE_ID &&
      env.GRAPH_PPT_FOLDER_ITEM_ID
        ? {
            tenantId: env.GRAPH_TENANT_ID,
            clientId: env.GRAPH_CLIENT_ID,
            clientSecret: env.GRAPH_CLIENT_SECRET,
            driveId: env.GRAPH_DRIVE_ID,
            pptFolderItemId: env.GRAPH_PPT_FOLDER_ITEM_ID,
            sheetMusicFolderItemId: env.GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID || undefined,
            sheetMusicFolderPath: env.GRAPH_SHEET_MUSIC_FOLDER_PATH || "文件/流行歌譜 (捷徑)",
            sheetMusicAllowedExtensions: readList(
              env.SHEET_MUSIC_ALLOWED_EXTENSIONS || "pdf,jpg,jpeg"
            ).map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)),
            sheetMusicRecursive: readBool(env.SHEET_MUSIC_DEFAULT_RECURSIVE, true),
            allowedExtensions: readList(env.PPT_ALLOWED_EXTENSIONS || "ppt,pptx,pdf").map((ext) =>
              ext.startsWith(".") ? ext : `.${ext}`
            ),
            defaultIncludePdf: readBool(env.PPT_DEFAULT_INCLUDE_PDF, false),
            linkType: readGraphLinkType(env.GRAPH_LINK_TYPE),
            linkScope: readGraphLinkScope(env.GRAPH_LINK_SCOPE)
          }
        : undefined,
    notion:
      env.NOTION_TOKEN &&
      env.NOTION_SERVICE_DATABASE_ID &&
      env.NOTION_DATE_PROPERTY &&
      env.NOTION_MEETING_PROPERTY &&
      env.NOTION_ROLE_PROPERTY &&
      env.NOTION_PERSON_PROPERTY
        ? {
            token: env.NOTION_TOKEN,
            databaseId: env.NOTION_SERVICE_DATABASE_ID,
            properties: {
              date: env.NOTION_DATE_PROPERTY,
              meeting: env.NOTION_MEETING_PROPERTY,
              role: env.NOTION_ROLE_PROPERTY,
              person: env.NOTION_PERSON_PROPERTY
            }
          }
        : undefined,
    redis: env.REDIS_URL?.trim()
      ? {
          url: env.REDIS_URL,
          keyPrefix: env.REDIS_KEY_PREFIX || "hhc-line-function-bot"
        }
      : undefined,
    database: env.DATABASE_URL?.trim()
      ? {
          url: env.DATABASE_URL,
          ssl: readBool(env.DATABASE_SSL, false)
        }
      : undefined,
    access: {
      registrationInviteCodeTtlMinutes: readInt(env.REGISTRATION_INVITE_CODE_TTL_MINUTES, 60)
    },
    rateLimit: {
      enabled: readBool(env.RATE_LIMIT_ENABLED, true),
      windowMs: readInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
      maxRequests: readInt(env.RATE_LIMIT_MAX_REQUESTS, 20)
    },
    lastErrors: {
      maxEntries: readInt(env.LAST_ERRORS_MAX_ENTRIES, 20)
    }
  };
}

type ParsedProfile = z.infer<typeof profileSchema>;

function normalizeProfile(profile: ParsedProfile): ParsedProfile {
  return {
    ...profile,
    directAccessPolicy:
      profile.directAccessPolicy ?? (profile.allowDirectUser ? "managed" : "blocked"),
    groupAccessPolicy: profile.groupAccessPolicy ?? "blocked"
  };
}

function assertNoLegacyProfileFields(parsedProfiles: unknown): void {
  if (!Array.isArray(parsedProfiles)) {
    return;
  }
  for (const profile of parsedProfiles) {
    if (
      profile &&
      typeof profile === "object" &&
      Object.prototype.hasOwnProperty.call(profile, "adminUserIds")
    ) {
      throw new Error("adminUserIds is no longer supported; use adminUserId");
    }
    if (
      profile &&
      typeof profile === "object" &&
      Object.prototype.hasOwnProperty.call(profile, "allowedUserIds")
    ) {
      throw new Error("allowedUserIds is no longer supported; use registration and access DB");
    }
    if (
      profile &&
      typeof profile === "object" &&
      Object.prototype.hasOwnProperty.call(profile, "allowedGroupIds")
    ) {
      throw new Error("allowedGroupIds is no longer supported; use access DB");
    }
    if (
      profile &&
      typeof profile === "object" &&
      "registration" in profile &&
      profile.registration &&
      typeof profile.registration === "object" &&
      Object.prototype.hasOwnProperty.call(profile.registration, "inviteCodeRequired")
    ) {
      throw new Error(
        "registration.inviteCodeRequired is no longer supported; use /registry invite codes"
      );
    }
  }
}

function validateAccessConfig(profiles: ParsedProfile[], env: NodeJS.ProcessEnv): void {
  const registrationProfiles = profiles.filter((profile) => profile.registration.enabled);
  if (registrationProfiles.length === 0) {
    return;
  }
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required when profile registration is enabled");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required when profile registration is enabled");
  }
}

const graphRequiredKeys = [
  "GRAPH_TENANT_ID",
  "GRAPH_CLIENT_ID",
  "GRAPH_CLIENT_SECRET",
  "GRAPH_DRIVE_ID",
  "GRAPH_PPT_FOLDER_ITEM_ID"
];

const notionRequiredKeys = [
  "NOTION_TOKEN",
  "NOTION_SERVICE_DATABASE_ID",
  "NOTION_DATE_PROPERTY",
  "NOTION_MEETING_PROPERTY",
  "NOTION_ROLE_PROPERTY",
  "NOTION_PERSON_PROPERTY"
];

function assertUniqueValues(values: string[], message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${message}: ${value}`);
    }
    seen.add(value);
  }
}

function assertCompleteGroup(
  env: NodeJS.ProcessEnv,
  requiredKeys: string[],
  message: string
): void {
  const present = requiredKeys.filter((key) => Boolean(env[key]?.trim()));
  if (present.length > 0 && present.length !== requiredKeys.length) {
    const missing = requiredKeys.filter((key) => !env[key]?.trim());
    throw new Error(`${message}; missing ${missing.join(", ")}`);
  }
}

function readProfilesJson(env: NodeJS.ProcessEnv): string {
  if (env.BOT_PROFILES_JSON?.trim()) {
    return env.BOT_PROFILES_JSON;
  }
  if (env.BOT_PROFILES_BASE64_JSON?.trim()) {
    return Buffer.from(env.BOT_PROFILES_BASE64_JSON, "base64").toString("utf8");
  }
  throw new Error("BOT_PROFILES_JSON or BOT_PROFILES_BASE64_JSON is required");
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readOllamaKeepAlive(value: string | undefined): string | number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^-?\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  return normalized;
}

function readList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readGraphLinkType(value: string | undefined): "view" | "edit" | "embed" {
  if (value === "edit" || value === "embed") {
    return value;
  }
  return "view";
}

function readGraphLinkScope(value: string | undefined): "anonymous" | "organization" {
  return value === "organization" ? "organization" : "anonymous";
}

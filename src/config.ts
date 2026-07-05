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
  allowedGroupIds: z.array(z.string()).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  allowDirectUser: z.boolean().default(false),
  allowRooms: z.boolean().default(false),
  allowedMessageTypes: z.array(z.string()).default(["text"]),
  groupRequireWakeWord: z.boolean().default(true),
  wakeKeywords: z.array(z.string()).default([]),
  acceptMention: z.boolean().default(true),
  enabledFunctions: z.array(z.enum(FUNCTION_NAMES)).default([]),
  adminUserIds: z.array(z.string()).default([]),
  adminDirectOnly: z.boolean().default(true)
});

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const profilesJson = readProfilesJson(env);
  const profiles = z.array(profileSchema).min(1).parse(JSON.parse(profilesJson));

  return {
    serviceName: env.SERVICE_NAME || "hhc-line-function-bot",
    host: env.HOST || "0.0.0.0",
    port: readInt(env.PORT, 3000),
    timeZone: readTimeZone(env.TIME_ZONE),
    healthPath: env.HEALTH_PATH || "/healthz",
    maxBodyBytes: readInt(env.MAX_BODY_BYTES, 262_144),
    profiles: profiles.map((profile) => ({
      ...profile,
      enabledFunctions: profile.enabledFunctions as FunctionName[]
    })),
    llm: {
      ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      ollamaModel: env.OLLAMA_MODEL || "qwen3:4b-instruct",
      ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE || -1,
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
        : undefined
  };
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

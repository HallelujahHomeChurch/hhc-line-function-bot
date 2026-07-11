import { readFileSync } from "node:fs";

import { z } from "zod";

import { assertCanonicalWebhookPath } from "./profile-path.js";
import { readTimeZone } from "./time-zone.js";
import { providerCapabilities } from "./llm/provider-metadata.js";
import { normalizeProviderPolicy } from "./llm/provider-policy.js";
import { FUNCTION_NAMES, MODEL_PROVIDER_LANE_NAMES, MODEL_PROVIDER_NAMES } from "./types.js";
import type {
  AppConfig,
  CatalogSourceConfig,
  FunctionName,
  ModelProviderName,
  ProviderPolicy,
  SmallTalkConfig,
  SmallTalkPromptingConfig
} from "./types.js";

const providerLanePolicySchema = z.object({
  primary: z.enum(MODEL_PROVIDER_NAMES).optional(),
  fallback: z.enum(MODEL_PROVIDER_NAMES).optional()
});

const catalogSourceSchema = z.object({
  profileName: z.string().min(1),
  sourceKey: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  adapterType: z.enum(["onedrive", "notion", "manual"]),
  domain: z.string().min(1),
  defaultItemKind: z.string().min(1),
  rootLocation: z.record(z.string(), z.string()),
  enabled: z.boolean().default(true),
  syncPolicy: z.object({
    mode: z.enum(["scheduled", "manual"]),
    intervalMinutes: z.number().int().min(1).max(1440).optional()
  }),
  capabilities: z.object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([])
  })
});

const smallTalkPromptingSchema = z.object({
  personaPrompt: z.string().trim().min(1).max(2000).optional(),
  conversationRulesPrompt: z.string().trim().min(1).max(2000).optional(),
  safetyRulesPrompt: z.string().trim().min(1).max(2000).optional(),
  formatRulesPrompt: z.string().trim().min(1).max(2000).optional()
});

const profileSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, {
      message: "Profile name must use lowercase letters, numbers, dash, or underscore"
    }),
  webhookPath: z.string().startsWith("/"),
  channelSecret: z.string().min(1).optional(),
  channelSecretEnv: z.string().trim().min(1).optional(),
  channelAccessToken: z.string().min(1).optional(),
  channelAccessTokenEnv: z.string().trim().min(1).optional(),
  allowDirectUser: z.boolean().default(false),
  allowRooms: z.boolean().default(false),
  allowedMessageTypes: z.array(z.string()).default(["text"]),
  groupRequireWakeWord: z.boolean().default(true),
  wakeKeywords: z.array(z.string()).default([]),
  acceptMention: z.boolean().default(true),
  enabledFunctions: z.array(z.enum(FUNCTION_NAMES)).default([]),
  adminUserId: z.string().optional(),
  adminUserIdEnv: z.string().trim().min(1).optional(),
  adminDirectOnly: z.boolean().default(true),
  directAccessPolicy: z.enum(["managed", "public", "blocked"]).optional(),
  groupAccessPolicy: z.enum(["managed", "blocked"]).optional(),
  registration: z
    .object({
      enabled: z.boolean().default(false)
    })
    .default({ enabled: false }),
  smallTalk: z
    .object({
      mode: z.enum(["template", "llm"]).default("template"),
      maxChars: z.number().int().min(20).max(120).default(80),
      personaPrompt: z.string().trim().min(1).max(2000).optional(),
      prompting: smallTalkPromptingSchema.optional()
    })
    .default({ mode: "template", maxChars: 80 }),
  allowedProviders: z.array(z.enum(MODEL_PROVIDER_NAMES)).optional(),
  allowSubscriptionProviders: z.boolean().default(false),
  providerPolicy: z
    .partialRecord(z.enum(MODEL_PROVIDER_LANE_NAMES), providerLanePolicySchema)
    .optional(),
  generalAgent: z
    .object({
      enabled: z.boolean().default(false),
      conversationWindowSeconds: z.number().int().min(10).max(900).default(60)
    })
    .default({ enabled: false, conversationWindowSeconds: 60 }),
  longRunningJobs: z
    .object({
      enabled: z.boolean().default(false),
      inlineReplyTimeoutMs: z.number().int().min(500).max(20_000).default(4000),
      resultTtlMinutes: z.number().int().min(1).max(1440).default(30)
    })
    .default({ enabled: false, inlineReplyTimeoutMs: 4000, resultTtlMinutes: 30 })
});

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const profilesJson = readProfilesJson(env);
  const parsedProfiles = JSON.parse(profilesJson) as unknown;
  if (!Array.isArray(parsedProfiles)) {
    throw new Error("PROFILE_CONFIG_PATH must contain a JSON array");
  }
  assertNoLegacyProfileFields(parsedProfiles);
  const profiles = z.array(profileSchema).min(1).parse(parsedProfiles);
  if (env.NODE_ENV === "production") {
    assertProductionSafeProfiles(profiles);
  }
  for (const profile of profiles) {
    assertCanonicalWebhookPath(profile.name, profile.webhookPath);
  }
  assertUniqueValues(
    profiles.map((profile) => profile.webhookPath),
    "Duplicate profile webhookPath"
  );
  assertCompleteGroup(env, graphRequiredKeys, "Incomplete Graph configuration");
  assertCompleteGroup(env, notionRequiredKeys, "Incomplete Notion configuration");
  const llmProvider = readModelProvider(env.LLM_PROVIDER, "ollama");
  const llmFallbackProvider = readModelProvider(env.LLM_FALLBACK_PROVIDER, "ollama");
  const normalizedProfiles = profiles.map((profile) => normalizeProfile(profile, env));
  validateProviderPolicy(normalizedProfiles, llmProvider, llmFallbackProvider);
  validateAccessConfig(normalizedProfiles, env);
  const catalogSources = readCatalogSources(
    env,
    normalizedProfiles.map((profile) => profile.name)
  );

  return {
    serviceName: env.SERVICE_NAME || "hhc-line-function-bot",
    host: env.HOST || "0.0.0.0",
    port: readInt(env.PORT, 3000),
    timeZone: readTimeZone(env.TIME_ZONE),
    healthPath: env.HEALTH_PATH || "/healthz",
    readyPath: env.READY_PATH || "/readyz",
    maxBodyBytes: readInt(env.MAX_BODY_BYTES, 262_144),
    profiles: normalizedProfiles.map((profile) => ({
      ...profile,
      enabledFunctions: profile.enabledFunctions as FunctionName[]
    })),
    llm: {
      provider: llmProvider,
      fallbackProvider: llmFallbackProvider,
      ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      ollamaModel: env.OLLAMA_MODEL || "qwen3:4b-instruct",
      ollamaKeepAlive: readOllamaKeepAlive(env.OLLAMA_KEEP_ALIVE),
      deepseekApiKey: env.DEEPSEEK_API_KEY || undefined,
      deepseekBaseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      deepseekModel: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      deepseekTimeoutMs: readInt(env.DEEPSEEK_TIMEOUT_MS, 8000),
      contextWindowTokens: readInt(env.LLM_CONTEXT_WINDOW_TOKENS, 128_000),
      runtimeContextBudgetTokens: readInt(env.LLM_RUNTIME_CONTEXT_BUDGET_TOKENS, 24_000),
      contextCompressionThresholdRatio: readFloat(
        env.LLM_CONTEXT_COMPRESSION_THRESHOLD_RATIO,
        0.75
      ),
      generalMaxOutputTokens: readInt(env.LLM_GENERAL_MAX_OUTPUT_TOKENS, 512),
      routeMaxOutputTokens: readInt(env.LLM_ROUTE_MAX_OUTPUT_TOKENS, 256),
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
            allowedExtensions: [".pptx", ".ppt", ".key", ".odp"],
            defaultIncludePdf: false,
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
    wikipedia: {
      userAgent: env.WIKIMEDIA_USER_AGENT || "HHCLineBot/1.0 (https://alive.org.tw/contact)",
      timeoutMs: readInt(env.WIKIPEDIA_TIMEOUT_MS, 8000)
    },
    virusScan: env.VIRUS_SCAN_ENDPOINT?.trim()
      ? {
          endpoint: env.VIRUS_SCAN_ENDPOINT.trim(),
          apiKey: env.VIRUS_SCAN_API_KEY?.trim() || undefined,
          timeoutMs: readInt(env.VIRUS_SCAN_TIMEOUT_MS, 8000)
        }
      : undefined,
    webSearch: env.SEARXNG_BASE_URL?.trim()
      ? {
          searxngBaseUrl: env.SEARXNG_BASE_URL.trim(),
          timeoutMs: readInt(env.SEARXNG_TIMEOUT_MS, 8000)
        }
      : undefined,
    ...(catalogSources.length ? { catalog: { sources: catalogSources } } : {}),
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
      registrationInviteCodeTtlMinutes: readInt(env.REGISTRATION_INVITE_CODE_TTL_MINUTES, 60),
      confirmationTtlMinutes: readInt(env.CONFIRMATION_TTL_MINUTES, 5)
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
type NormalizedProfile = Omit<
  ParsedProfile,
  | "channelSecret"
  | "channelSecretEnv"
  | "channelAccessToken"
  | "channelAccessTokenEnv"
  | "adminUserId"
  | "adminUserIdEnv"
  | "smallTalk"
> & {
  channelSecret: string;
  channelAccessToken: string;
  adminUserId?: string;
  smallTalk: SmallTalkConfig;
  allowedProviders: ModelProviderName[];
  allowSubscriptionProviders: boolean;
  providerPolicy: ProviderPolicy;
};

function normalizeProfile(profile: ParsedProfile, env: NodeJS.ProcessEnv): NormalizedProfile {
  const allowedProviders = uniqueProviders(profile.allowedProviders ?? ["ollama"]);
  const channelSecret = resolveRequiredProfileValue(
    profile.name,
    "channelSecret",
    profile.channelSecret,
    profile.channelSecretEnv,
    env
  );
  const channelAccessToken = resolveRequiredProfileValue(
    profile.name,
    "channelAccessToken",
    profile.channelAccessToken,
    profile.channelAccessTokenEnv,
    env
  );
  const adminUserId = resolveOptionalProfileValue(
    profile.name,
    "adminUserId",
    profile.adminUserId,
    profile.adminUserIdEnv,
    env
  );
  const profileConfig = { ...profile };
  delete profileConfig.channelSecretEnv;
  delete profileConfig.channelAccessTokenEnv;
  delete profileConfig.adminUserIdEnv;
  return {
    ...profileConfig,
    channelSecret,
    channelAccessToken,
    ...(adminUserId ? { adminUserId } : {}),
    smallTalk: normalizeSmallTalkConfig(profile.smallTalk),
    allowedProviders,
    providerPolicy: normalizeProviderPolicy({
      profileName: profile.name,
      allowedProviders,
      explicitPolicy: profile.providerPolicy
    }),
    directAccessPolicy:
      profile.directAccessPolicy ?? (profile.allowDirectUser ? "managed" : "blocked"),
    groupAccessPolicy: profile.groupAccessPolicy ?? "blocked"
  };
}

function resolveRequiredProfileValue(
  profileName: string,
  fieldName: string,
  directValue: string | undefined,
  envName: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  const value = resolveOptionalProfileValue(profileName, fieldName, directValue, envName, env);
  if (!value) {
    throw new Error(`Profile ${profileName} must configure ${fieldName} or ${fieldName}Env`);
  }
  return value;
}

function resolveOptionalProfileValue(
  profileName: string,
  fieldName: string,
  directValue: string | undefined,
  envName: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (envName) {
    const value = env[envName]?.trim();
    if (!value) {
      throw new Error(`Profile ${profileName} environment reference ${envName} is missing`);
    }
    return value;
  }
  return directValue?.trim() || undefined;
}

function normalizeSmallTalkConfig(config: ParsedProfile["smallTalk"]): SmallTalkConfig {
  const prompting = normalizeSmallTalkPrompting(config);
  return {
    mode: config.mode,
    maxChars: config.maxChars,
    ...(prompting ? { prompting } : {})
  };
}

function normalizeSmallTalkPrompting(
  config: ParsedProfile["smallTalk"]
): SmallTalkPromptingConfig | undefined {
  const prompting: SmallTalkPromptingConfig = {
    ...(config.prompting ?? {})
  };
  if (config.personaPrompt && !prompting.personaPrompt) {
    prompting.personaPrompt = config.personaPrompt;
  }
  return Object.keys(prompting).length > 0 ? prompting : undefined;
}

function uniqueProviders(providers: ModelProviderName[]): ModelProviderName[] {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (seen.has(provider)) {
      return false;
    }
    seen.add(provider);
    return true;
  });
}

function validateProviderPolicy(
  profiles: NormalizedProfile[],
  defaultProvider: ModelProviderName,
  fallbackProvider: ModelProviderName
): void {
  for (const profile of profiles) {
    for (const provider of profile.allowedProviders) {
      if (providerCapabilities[provider].subscriptionBased && !profile.allowSubscriptionProviders) {
        throw new Error(`Profile ${profile.name} cannot allow subscription provider ${provider}`);
      }
    }
    if (!profile.allowedProviders.includes(defaultProvider)) {
      throw new Error(
        `Profile ${profile.name} default provider ${defaultProvider} must be listed in allowedProviders`
      );
    }
    if (!profile.allowedProviders.includes(fallbackProvider)) {
      throw new Error(
        `Profile ${profile.name} fallback provider ${fallbackProvider} must be listed in allowedProviders`
      );
    }
  }
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

function assertProductionSafeProfiles(profiles: ParsedProfile[]): void {
  for (const profile of profiles) {
    if (profile.channelSecret) {
      throw new Error(
        `Production profile ${profile.name} must use channelSecretEnv instead of channelSecret`
      );
    }
    if (profile.channelAccessToken) {
      throw new Error(
        `Production profile ${profile.name} must use channelAccessTokenEnv instead of channelAccessToken`
      );
    }
    if (profile.adminUserId) {
      throw new Error(
        `Production profile ${profile.name} must use adminUserIdEnv instead of adminUserId`
      );
    }
    if (profile.smallTalk.mode === "llm") {
      const prompting = profile.smallTalk.prompting;
      for (const key of [
        "personaPrompt",
        "conversationRulesPrompt",
        "safetyRulesPrompt",
        "formatRulesPrompt"
      ] as const) {
        if (!prompting?.[key]?.trim()) {
          throw new Error(
            `Production LLM smallTalk prompting for ${profile.name} must include ${key}`
          );
        }
      }
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

function readCatalogSources(env: NodeJS.ProcessEnv, profileNames: string[]): CatalogSourceConfig[] {
  const path = env.CATALOG_SOURCES_PATH?.trim();
  if (!path) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const sources = z.array(catalogSourceSchema).parse(parsed);
  const knownProfiles = new Set(profileNames);
  for (const source of sources) {
    if (!knownProfiles.has(source.profileName)) {
      throw new Error(
        `Catalog source ${source.sourceKey} references unknown profile ${source.profileName}`
      );
    }
  }
  return sources.map((source) => ({
    ...source,
    rootLocation: resolveCatalogRootLocation(source.sourceKey, source.rootLocation, env)
  }));
}

function resolveCatalogRootLocation(
  sourceKey: string,
  rootLocation: Record<string, string>,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(rootLocation)) {
    if (key.endsWith("Env")) {
      const targetKey = key.slice(0, -"Env".length);
      const envValue = env[value]?.trim();
      if (!envValue) {
        throw new Error(`Catalog source ${sourceKey} requires environment variable ${value}`);
      }
      resolved[targetKey] = envValue;
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
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
  const hasLegacyProfileConfig = Boolean(
    env.BOT_PROFILES_JSON?.trim() || env.BOT_PROFILES_BASE64_JSON?.trim()
  );
  if (hasLegacyProfileConfig) {
    throw new Error("Profile config must use PROFILE_CONFIG_PATH");
  }
  const configPath = env.PROFILE_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("PROFILE_CONFIG_PATH is required");
  }
  return readFileSync(configPath, "utf8");
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

function readFloat(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readModelProvider(
  value: string | undefined,
  fallback: ModelProviderName
): ModelProviderName {
  if (value === "openai_codex_oauth" || value === "codex_app_server" || value === "codex") {
    throw new Error(`${value} is no longer supported`);
  }
  if (value === "ollama" || value === "deepseek") {
    return value;
  }
  return fallback;
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

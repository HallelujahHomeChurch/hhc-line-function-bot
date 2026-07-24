import { readFileSync } from "node:fs";

import { z } from "zod";

import { assertCanonicalWebhookPath } from "./profile-path.js";
import { readTimeZone } from "./time-zone.js";
import { providerCapabilities } from "./llm/provider-metadata.js";
import { normalizeProviderPolicy } from "./llm/provider-policy.js";
import { FUNCTION_NAMES, MODEL_PROVIDER_LANE_NAMES, MODEL_PROVIDER_NAMES } from "./types.js";
import { DEFAULT_MEETING_WINDOWS } from "./schedules/occurrence-policy.js";
import { DEFAULT_SCHEDULE_DOMAINS } from "./schedules/domain-registry.js";
import {
  AZURE_OPENAI_EMBEDDING_API_VERSION,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
  AZURE_OPENAI_EMBEDDING_DIMENSIONS,
  AZURE_OPENAI_EMBEDDING_MODEL
} from "./clients/azure-openai-embedding.js";
import type {
  AppConfig,
  FunctionName,
  KnowledgeConfig,
  ModelProviderName,
  ProviderPolicy,
  SmallTalkConfig,
  SmallTalkPromptingConfig
} from "./types.js";

const providerLanePolicySchema = z.object({
  primary: z.enum(MODEL_PROVIDER_NAMES).optional(),
  fallback: z.enum(MODEL_PROVIDER_NAMES).optional()
});

const smallTalkPromptingSchema = z.object({
  personaPrompt: z.string().trim().min(1).max(2000).optional(),
  conversationRulesPrompt: z.string().trim().min(1).max(2000).optional(),
  safetyRulesPrompt: z.string().trim().min(1).max(2000).optional(),
  formatRulesPrompt: z.string().trim().min(1).max(2000).optional()
});

const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const meetingWindowSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(100)).min(1),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    start: timeOfDaySchema,
    end: timeOfDaySchema
  })
  .refine(({ start, end }) => start < end, {
    message: "Meeting window end must be after start"
  });

const schedulePolicySchema = z
  .object({
    meetingWindows: z.array(meetingWindowSchema).min(1),
    domains: z
      .array(
        z.object({
          key: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_]*$/u)
            .max(80),
          displayName: z.string().trim().min(1).max(80),
          aliases: z.array(z.string().trim().min(1).max(80)).min(1),
          routingHints: z.array(z.string().trim().min(1).max(80)).default([]),
          schemaVersion: z.number().int().positive(),
          inputSchema: z.enum(["assignment_rows_v1", "family_rotation_v1"]),
          occurrencePolicy: z.string().trim().min(1).max(80),
          binding: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("canonical"),
              sourceKeys: z.array(z.string().trim().min(1).max(100)).min(1),
              allowLiveFallback: z.boolean().default(false)
            }),
            z.object({
              kind: z.literal("saved_schedule"),
              scheduleType: z
                .string()
                .trim()
                .regex(/^[a-z][a-z0-9_]*$/u)
                .max(80)
            })
          ]),
          origins: z.array(z.enum(["notion", "line"])).min(1),
          writePolicy: z.object({
            mode: z.enum(["read_only", "replace_add"]),
            allowedOperations: z.array(z.enum(["replace", "add_entry"]))
          }),
          priority: z.number().int().min(0).max(1000),
          revision: z.string().trim().min(1).max(80),
          freshnessPolicy: z.object({
            maxAgeSeconds: z.number().int().positive(),
            staleBehavior: z.enum(["reject", "allow_with_notice"])
          })
        })
      )
      .min(1)
      .default(DEFAULT_SCHEDULE_DOMAINS)
  })
  .superRefine(({ meetingWindows, domains }, ctx) => {
    const keys = new Set<string>();
    const aliases = new Set<string>();
    for (const [index, window] of meetingWindows.entries()) {
      if (keys.has(window.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["meetingWindows", index, "key"],
          message: "Duplicate meeting window key"
        });
      }
      keys.add(window.key);
      for (const alias of window.aliases) {
        const normalized = alias.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
        if (aliases.has(normalized)) {
          ctx.addIssue({
            code: "custom",
            path: ["meetingWindows", index, "aliases"],
            message: "Duplicate meeting window alias"
          });
        }
        aliases.add(normalized);
      }
    }
    const domainKeys = new Set<string>();
    for (const [index, domain] of domains.entries()) {
      if (domainKeys.has(domain.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["domains", index, "key"],
          message: "Duplicate schedule domain key"
        });
      }
      domainKeys.add(domain.key);
      if (domain.writePolicy.mode === "read_only" && domain.writePolicy.allowedOperations.length) {
        ctx.addIssue({
          code: "custom",
          path: ["domains", index, "writePolicy"],
          message: "Read-only domains cannot allow writes"
        });
      }
    }
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
  controlledAgent: z
    .object({
      maxCandidates: z.number().int().min(1).max(5).default(3),
      minPlannerConfidence: z.number().min(0).max(1).default(0.65)
    })
    .default({
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    }),
  agentRuntime: z
    .object({
      taskFrameSeconds: z.number().int().min(60).max(3600).default(600)
    })
    .default({ taskFrameSeconds: 600 }),
  schedulePolicy: schedulePolicySchema.default({
    meetingWindows: DEFAULT_MEETING_WINDOWS,
    domains: DEFAULT_SCHEDULE_DOMAINS
  }),
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
  assertNoRetiredLocalModelRuntimeSettings(env);
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
  const llmProvider = readModelProvider(env.LLM_PROVIDER, "deepseek");
  const normalizedProfiles = profiles.map((profile) => normalizeProfile(profile, env));
  validateProviderPolicy(normalizedProfiles, llmProvider);
  validateAccessConfig(normalizedProfiles, env);
  const attachmentScanQueueUrl = readAttachmentScanQueueUrl(env);
  const requiresDurableAttachmentScanning =
    env.NODE_ENV === "production" &&
    normalizedProfiles.some((profile) => profile.enabledFunctions.includes("save_resource"));
  if (requiresDurableAttachmentScanning && !attachmentScanQueueUrl) {
    throw new Error(
      "ATTACHMENT_SCAN_QUEUE_URL is required in production when save_resource is enabled"
    );
  }
  if (requiresDurableAttachmentScanning && !env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required in production when save_resource is enabled");
  }
  const observabilityHmacKey = env.OBSERVABILITY_HMAC_KEY?.trim();
  if (observabilityHmacKey && observabilityHmacKey.length < 32) {
    throw new Error("OBSERVABILITY_HMAC_KEY must contain at least 32 characters");
  }
  if (env.NODE_ENV === "production" && !observabilityHmacKey) {
    throw new Error("OBSERVABILITY_HMAC_KEY is required in production");
  }
  const knowledgeEmbedding = readKnowledgeEmbeddingConfig(env);
  return {
    serviceName: env.SERVICE_NAME || "hhc-line-function-bot",
    host: env.HOST || "0.0.0.0",
    port: readInt(env.PORT, 3000),
    timeZone: readTimeZone(env.TIME_ZONE),
    healthPath: env.HEALTH_PATH || "/healthz",
    readyPath: env.READY_PATH || "/readyz",
    maxBodyBytes: readInt(env.MAX_BODY_BYTES, 262_144),
    attachments: {
      maxBytes: readInt(env.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024),
      lineDownloadTimeoutMs: readInt(env.LINE_CONTENT_DOWNLOAD_TIMEOUT_MS, 30_000),
      ...(attachmentScanQueueUrl ? { scanQueueUrl: attachmentScanQueueUrl } : {})
    },
    externalResources: {
      downloadTimeoutMs: readInt(env.EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS, 15_000),
      maxRedirects: readInt(env.EXTERNAL_RESOURCE_MAX_REDIRECTS, 3)
    },
    profiles: normalizedProfiles.map((profile) => ({
      ...profile,
      enabledFunctions: profile.enabledFunctions as FunctionName[]
    })),
    llm: {
      provider: llmProvider,
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
      routeMaxOutputTokens: readInt(env.LLM_ROUTE_MAX_OUTPUT_TOKENS, 256)
    },
    knowledge: env.NOTION_TOKEN
      ? {
          notionToken: env.NOTION_TOKEN,
          embedding: knowledgeEmbedding!
        }
      : undefined,
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
            sheetMusicAllowedExtensions: readList(
              env.SHEET_MUSIC_ALLOWED_EXTENSIONS || "pdf,jpg,jpeg,png"
            ).map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)),
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
    webSearch: env.SEARXNG_BASE_URL?.trim()
      ? {
          searxngBaseUrl: env.SEARXNG_BASE_URL.trim(),
          timeoutMs: readInt(env.SEARXNG_TIMEOUT_MS, 8000)
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
    },
    observability: {
      ...(observabilityHmacKey ? { hmacKey: observabilityHmacKey } : {})
    }
  };
}

function readAttachmentScanQueueUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.ATTACHMENT_SCAN_QUEUE_URL?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error("ATTACHMENT_SCAN_QUEUE_URL must be a valid HTTPS URL");
  }
  return value;
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
  const allowedProviders = uniqueProviders(profile.allowedProviders ?? ["deepseek"]);
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
  defaultProvider: ModelProviderName
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
  }
}

function assertNoRetiredLocalModelRuntimeSettings(env: NodeJS.ProcessEnv): void {
  const retiredProvider = ["olla", "ma"].join("");
  const retiredEnvToken = retiredProvider.toUpperCase();
  if (
    env.LLM_PROVIDER === retiredProvider ||
    env.LLM_FALLBACK_PROVIDER?.trim() ||
    Object.entries(env).some(
      ([name, value]) =>
        Boolean(value?.trim()) &&
        (name.startsWith(`${retiredEnvToken}_`) ||
          name.includes(`_${retiredEnvToken}_`) ||
          name === "EMBEDDING_KEEP_ALIVE")
    )
  ) {
    throw new Error("Local model runtime settings are no longer supported");
  }
}

function readKnowledgeEmbeddingConfig(
  env: NodeJS.ProcessEnv
): KnowledgeConfig["embedding"] | undefined {
  if (
    ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_EMBEDDING_MODEL"].some(
      (name) => env[name] !== undefined
    )
  ) {
    throw new Error("Direct OpenAI embedding settings are no longer supported");
  }
  if (env.EMBEDDING_DIMENSIONS !== undefined) {
    throw new Error("EMBEDDING_DIMENSIONS is not supported");
  }
  if (!env.NOTION_TOKEN) return undefined;
  if (env.EMBEDDING_PROVIDER?.trim() !== "azure_openai") {
    throw new Error("EMBEDDING_PROVIDER must be azure_openai");
  }
  const apiKey = env.AZURE_OPENAI_EMBEDDING_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "AZURE_OPENAI_EMBEDDING_API_KEY is required when knowledge embeddings are enabled"
    );
  }
  const endpoint = readAzureEmbeddingEndpoint(env.AZURE_OPENAI_EMBEDDING_ENDPOINT);
  if (env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT?.trim() !== AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    throw new Error(
      "AZURE_OPENAI_EMBEDDING_DEPLOYMENT must be text-embedding-3-small"
    );
  }
  if (env.AZURE_OPENAI_EMBEDDING_API_VERSION?.trim() !== AZURE_OPENAI_EMBEDDING_API_VERSION) {
    throw new Error("AZURE_OPENAI_EMBEDDING_API_VERSION must be 2024-10-21");
  }
  if (env.EMBEDDING_MODEL?.trim() !== AZURE_OPENAI_EMBEDDING_MODEL) {
    throw new Error("EMBEDDING_MODEL must be text-embedding-3-small");
  }
  return {
    provider: "azure_openai",
    apiKey,
    endpoint,
    deployment: AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    apiVersion: AZURE_OPENAI_EMBEDDING_API_VERSION,
    model: AZURE_OPENAI_EMBEDDING_MODEL,
    dimensions: AZURE_OPENAI_EMBEDDING_DIMENSIONS,
    batchSize: readInt(env.EMBEDDING_BATCH_SIZE, 16),
    timeoutMs: readInt(env.EMBEDDING_TIMEOUT_MS, 30_000)
  };
}

function readAzureEmbeddingEndpoint(value: string | undefined): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value ?? "");
  } catch {
    throw new Error("AZURE_OPENAI_EMBEDDING_ENDPOINT must be an Azure HTTPS endpoint");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    endpoint.protocol !== "https:" ||
    (!hostname.endsWith(".cognitiveservices.azure.com") &&
      !hostname.endsWith(".openai.azure.com"))
  ) {
    throw new Error("AZURE_OPENAI_EMBEDDING_ENDPOINT must be an Azure HTTPS endpoint");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
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
    if (
      profile &&
      typeof profile === "object" &&
      "controlledAgent" in profile &&
      profile.controlledAgent &&
      typeof profile.controlledAgent === "object" &&
      (Object.prototype.hasOwnProperty.call(profile.controlledAgent, "enabled") ||
        Object.prototype.hasOwnProperty.call(profile.controlledAgent, "shadow"))
    ) {
      throw new Error(
        "controlledAgent.enabled and controlledAgent.shadow are no longer supported; controlled routing is always authoritative"
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
  if (value === "deepseek") {
    return "deepseek";
  }
  return fallback;
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

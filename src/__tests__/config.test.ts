import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...profilesEnv([
      {
        name: "main",
        webhookPath: "/api/line/webhook/main",
        channelSecret: "secret",
        channelAccessToken: "token",
        enabledFunctions: ["query_service_schedule"]
      }
    ])
  };
}

function profilesEnv(profiles: unknown): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "hhc-line-function-bot-profile-sync-"));
  const path = join(directory, "profiles.json");
  writeFileSync(path, JSON.stringify(profiles), "utf8");
  return { PROFILE_CONFIG_PATH: path };
}

const layeredPrompting = {
  personaPrompt: "PERSONA",
  conversationRulesPrompt: "CONVERSATION_RULES",
  safetyRulesPrompt: "SAFETY_RULES",
  formatRulesPrompt: "FORMAT_RULES"
};

async function withProfileFile<T>(
  profiles: unknown,
  callback: (path: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hhc-line-function-bot-profile-"));
  const path = join(directory, "profiles.json");
  await writeFile(path, JSON.stringify(profiles), "utf8");
  try {
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withJsonFile<T>(
  prefix: string,
  value: unknown,
  callback: (path: string) => Promise<T>
) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  try {
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("config", () => {
  it("configures an identifiable Wikimedia API client without a secret", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      WIKIMEDIA_USER_AGENT: "HHCLineBot/1.0 (https://alive.org.tw/contact)",
      WIKIPEDIA_TIMEOUT_MS: "9000"
    });

    expect(config.wikipedia).toEqual({
      userAgent: "HHCLineBot/1.0 (https://alive.org.tw/contact)",
      timeoutMs: 9000
    });
  });

  it("loads a production profile from PROFILE_CONFIG_PATH", async () => {
    await withProfileFile(
      [
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecretEnv: "LINE_HELPER_CHANNEL_SECRET",
          channelAccessTokenEnv: "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
          adminUserIdEnv: "LINE_HELPER_ADMIN_USER_ID",
          enabledFunctions: ["query_service_schedule"],
          registration: { enabled: true }
        }
      ],
      async (path) => {
        const config = loadConfigFromEnv({
          NODE_ENV: "production",
          PROFILE_CONFIG_PATH: path,
          LINE_HELPER_CHANNEL_SECRET: "secret",
          LINE_HELPER_CHANNEL_ACCESS_TOKEN: "token",
          LINE_HELPER_ADMIN_USER_ID: "admin",
          DATABASE_URL: "postgres://placeholder",
          REDIS_URL: "redis://placeholder"
        });

        expect(config.profiles.map((profile) => profile.name)).toEqual(["helper"]);
      }
    );
  });

  it("rejects legacy profile JSON environment values in every environment", () => {
    expect(() =>
      loadConfigFromEnv({ ...baseEnv(), BOT_PROFILES_JSON: "[]", NODE_ENV: "production" })
    ).toThrow("Profile config must use PROFILE_CONFIG_PATH");
    expect(() => loadConfigFromEnv({ ...baseEnv(), BOT_PROFILES_BASE64_JSON: "W10=" })).toThrow(
      "Profile config must use PROFILE_CONFIG_PATH"
    );
  });

  it("rejects inline profile credentials from a production profile file", async () => {
    await withProfileFile(
      [
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          adminUserId: "admin"
        }
      ],
      async (path) => {
        expect(() =>
          loadConfigFromEnv({
            NODE_ENV: "production",
            PROFILE_CONFIG_PATH: path
          })
        ).toThrow("Production profile helper must use channelSecretEnv instead of channelSecret");
      }
    );
  });

  it("defaults the app time zone to Asia/Taipei", () => {
    const config = loadConfigFromEnv(baseEnv());

    expect(config.timeZone).toBe("Asia/Taipei");
  });

  it("loads the app time zone from TIME_ZONE", () => {
    const config = loadConfigFromEnv({ ...baseEnv(), TIME_ZONE: "UTC" });

    expect(config.timeZone).toBe("UTC");
  });

  it("rejects invalid TIME_ZONE values", () => {
    expect(() => loadConfigFromEnv({ ...baseEnv(), TIME_ZONE: "Not/AZone" })).toThrow(
      "Invalid TIME_ZONE"
    );
  });

  it("rejects profile config that is not a JSON array", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv({
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token"
        })
      })
    ).toThrow("PROFILE_CONFIG_PATH must contain a JSON array");
  });

  it("rejects non-canonical profile names", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "Helper",
            webhookPath: "/api/line/webhook/Helper",
            channelSecret: "secret",
            channelAccessToken: "token"
          }
        ])
      })
    ).toThrow("Profile name must use lowercase letters, numbers, dash, or underscore");
  });

  it("rejects webhook paths that do not match the profile name", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/line/helper/webhook",
            channelSecret: "secret",
            channelAccessToken: "token"
          }
        ])
      })
    ).toThrow('Profile "helper" webhookPath must be "/api/line/webhook/helper"');
  });

  it("loads sheet music Graph configuration with safe defaults", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      GRAPH_TENANT_ID: "tenant",
      GRAPH_CLIENT_ID: "client",
      GRAPH_CLIENT_SECRET: "secret",
      GRAPH_DRIVE_ID: "drive",
      GRAPH_PPT_FOLDER_ITEM_ID: "ppt-folder",
      GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID: "sheet-folder"
    });

    expect(config.graph).toMatchObject({
      allowedExtensions: [".pptx", ".ppt", ".key", ".odp"],
      defaultIncludePdf: false,
      sheetMusicFolderItemId: "sheet-folder",
      sheetMusicFolderPath: "文件/流行歌譜 (捷徑)",
      sheetMusicAllowedExtensions: [".pdf", ".jpg", ".jpeg"],
      sheetMusicRecursive: true
    });
  });

  it("loads catalog sources from a deployment config file", async () => {
    await withJsonFile(
      "hhc-line-function-bot-catalog-",
      [
        {
          profileName: "main",
          sourceKey: "weekly_report_audio",
          adapterType: "onedrive",
          domain: "audio",
          defaultItemKind: "weekly_report_audio",
          rootLocation: { driveId: "drive", folderItemId: "weekly-folder" },
          enabled: true,
          syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
          capabilities: { read: ["helper"], write: [] }
        }
      ],
      async (path) => {
        const config = loadConfigFromEnv({
          ...baseEnv(),
          CATALOG_SOURCES_PATH: path
        });

        expect(config.catalog?.sources).toEqual([
          expect.objectContaining({
            profileName: "main",
            sourceKey: "weekly_report_audio",
            adapterType: "onedrive",
            defaultItemKind: "weekly_report_audio"
          })
        ]);
      }
    );
  });

  it("resolves catalog source root locations from environment references", async () => {
    await withJsonFile(
      "hhc-line-function-bot-catalog-env-",
      [
        {
          profileName: "main",
          sourceKey: "ppt_slides",
          adapterType: "onedrive",
          domain: "presentation",
          defaultItemKind: "ppt_slide",
          rootLocation: {
            driveIdEnv: "GRAPH_DRIVE_ID",
            folderItemIdEnv: "GRAPH_PPT_FOLDER_ITEM_ID"
          },
          enabled: true,
          syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
          capabilities: { read: ["helper"], write: [] }
        }
      ],
      async (path) => {
        const config = loadConfigFromEnv({
          ...baseEnv(),
          CATALOG_SOURCES_PATH: path,
          GRAPH_TENANT_ID: "tenant",
          GRAPH_CLIENT_ID: "client",
          GRAPH_CLIENT_SECRET: "secret",
          GRAPH_DRIVE_ID: "drive-from-env",
          GRAPH_PPT_FOLDER_ITEM_ID: "folder-from-env"
        });

        expect(config.catalog?.sources[0]?.rootLocation).toEqual({
          driveId: "drive-from-env",
          folderItemId: "folder-from-env"
        });
      }
    );
  });

  it("loads optional virus scanner configuration only when an endpoint is set", () => {
    expect(loadConfigFromEnv(baseEnv()).virusScan).toBeUndefined();

    const config = loadConfigFromEnv({
      ...baseEnv(),
      VIRUS_SCAN_ENDPOINT: "https://scanner.internal/scan",
      VIRUS_SCAN_API_KEY: "scan-key",
      VIRUS_SCAN_TIMEOUT_MS: "5000"
    });

    expect(config.virusScan).toEqual({
      endpoint: "https://scanner.internal/scan",
      apiKey: "scan-key",
      timeoutMs: 5000
    });
  });

  it("loads optional SearXNG web search configuration only when a base URL is set", () => {
    expect(loadConfigFromEnv(baseEnv()).webSearch).toBeUndefined();

    const config = loadConfigFromEnv({
      ...baseEnv(),
      SEARXNG_BASE_URL: "https://searxng.internal",
      SEARXNG_TIMEOUT_MS: "3000"
    });

    expect(config.webSearch).toEqual({
      searxngBaseUrl: "https://searxng.internal",
      timeoutMs: 3000
    });
  });

  it("does not allow environment variables to widen PPT file types", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      GRAPH_TENANT_ID: "tenant",
      GRAPH_CLIENT_ID: "client",
      GRAPH_CLIENT_SECRET: "secret",
      GRAPH_DRIVE_ID: "drive",
      GRAPH_PPT_FOLDER_ITEM_ID: "ppt-folder",
      PPT_ALLOWED_EXTENSIONS: "pdf,exe",
      PPT_DEFAULT_INCLUDE_PDF: "true"
    });

    expect(config.graph?.allowedExtensions).toEqual([".pptx", ".ppt", ".key", ".odp"]);
    expect(config.graph?.defaultIncludePdf).toBe(false);
  });

  it("loads profile admin settings from adminUserId only", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "main",
          webhookPath: "/api/line/webhook/main",
          channelSecret: "secret",
          channelAccessToken: "token",
          enabledFunctions: ["query_service_schedule"],
          adminUserId: "Uadmin",
          adminDirectOnly: true
        }
      ])
    });

    expect(config.profiles[0]).toMatchObject({
      adminUserId: "Uadmin",
      adminDirectOnly: true
    });
    expect(config.profiles[0]).not.toHaveProperty("adminUserIds");
  });

  it("resolves profile credentials and bootstrap admin from environment references", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecretEnv: "LINE_HELPER_CHANNEL_SECRET",
          channelAccessTokenEnv: "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
          adminUserIdEnv: "LINE_HELPER_ADMIN_USER_ID"
        }
      ]),
      LINE_HELPER_CHANNEL_SECRET: "resolved-secret",
      LINE_HELPER_CHANNEL_ACCESS_TOKEN: "resolved-token",
      LINE_HELPER_ADMIN_USER_ID: "Uadmin"
    });

    expect(config.profiles[0]).toMatchObject({
      channelSecret: "resolved-secret",
      channelAccessToken: "resolved-token",
      adminUserId: "Uadmin"
    });
    expect(config.profiles[0]).not.toHaveProperty("channelSecretEnv");
    expect(config.profiles[0]).not.toHaveProperty("channelAccessTokenEnv");
    expect(config.profiles[0]).not.toHaveProperty("adminUserIdEnv");
  });

  it("rejects missing environment references for profile credentials", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecretEnv: "LINE_HELPER_CHANNEL_SECRET",
            channelAccessTokenEnv: "LINE_HELPER_CHANNEL_ACCESS_TOKEN"
          }
        ]),
        LINE_HELPER_CHANNEL_SECRET: "resolved-secret"
      })
    ).toThrow("Profile helper environment reference LINE_HELPER_CHANNEL_ACCESS_TOKEN is missing");
  });

  it("loads a single bootstrap admin user id", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          enabledFunctions: ["query_service_schedule"],
          adminUserId: "Uadmin"
        }
      ])
    });

    expect(config.profiles[0]).toMatchObject({
      adminUserId: "Uadmin"
    });
    expect(config.profiles[0]).not.toHaveProperty("adminUserIds");
  });

  it("rejects legacy adminUserIds profile settings", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            adminUserIds: ["U1"]
          }
        ])
      })
    ).toThrow("adminUserIds is no longer supported");
  });

  it("rejects legacy static user and group allowlists", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            allowedUserIds: ["U1"]
          }
        ])
      })
    ).toThrow("allowedUserIds is no longer supported");

    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            allowedGroupIds: ["C1"]
          }
        ])
      })
    ).toThrow("allowedGroupIds is no longer supported");
  });

  it("loads profile access policy and registration settings", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          directAccessPolicy: "managed",
          groupAccessPolicy: "managed",
          registration: {
            enabled: true
          }
        }
      ]),
      DATABASE_URL: "postgres://localhost/test",
      REDIS_URL: "redis://localhost:6379",
      REGISTRATION_INVITE_CODE_TTL_MINUTES: "30"
    });

    expect(config.profiles[0]).toMatchObject({
      directAccessPolicy: "managed",
      groupAccessPolicy: "managed",
      registration: {
        enabled: true
      }
    });
    expect(config.database).toMatchObject({
      url: "postgres://localhost/test",
      ssl: false
    });
    expect(config.redis).toMatchObject({ url: "redis://localhost:6379" });
    expect(config.access).toMatchObject({ registrationInviteCodeTtlMinutes: 30 });
  });

  it("rejects registration without PostgreSQL", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            registration: { enabled: true }
          }
        ])
      })
    ).toThrow("DATABASE_URL is required when profile registration is enabled");
  });

  it("rejects registration without Redis", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            registration: { enabled: true }
          }
        ]),
        DATABASE_URL: "postgres://localhost/test"
      })
    ).toThrow("REDIS_URL is required when profile registration is enabled");
  });

  it("rejects legacy inviteCodeRequired profile settings", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            registration: { enabled: true, inviteCodeRequired: true }
          }
        ]),
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "redis://localhost:6379"
      })
    ).toThrow("registration.inviteCodeRequired is no longer supported");
  });

  it("coerces numeric Ollama keep_alive values from environment strings", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      OLLAMA_KEEP_ALIVE: "-1"
    });

    expect(config.llm.ollamaKeepAlive).toBe(-1);
  });

  it("omits Ollama keep_alive when it is not explicitly configured", () => {
    const config = loadConfigFromEnv(baseEnv());

    expect(config.llm.ollamaKeepAlive).toBeUndefined();
  });

  it("loads DeepSeek as a pluggable LLM provider", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          allowedProviders: ["ollama", "deepseek"]
        }
      ]),
      LLM_PROVIDER: "deepseek",
      LLM_FALLBACK_PROVIDER: "ollama",
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
      DEEPSEEK_TIMEOUT_MS: "7000"
    });

    expect(config.llm).toMatchObject({
      provider: "deepseek",
      fallbackProvider: "ollama",
      deepseekApiKey: "sk-test",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      deepseekTimeoutMs: 7000
    });
  });

  it("rejects removed Codex provider names", () => {
    expect(() =>
      loadConfigFromEnv({
        ...baseEnv(),
        LLM_PROVIDER: "openai_codex_oauth"
      })
    ).toThrow("openai_codex_oauth is no longer supported");

    expect(() =>
      loadConfigFromEnv({
        ...baseEnv(),
        LLM_PROVIDER: "codex_app_server"
      })
    ).toThrow("codex_app_server is no longer supported");
  });

  it("defaults profile provider policy to non-subscription providers only", () => {
    const config = loadConfigFromEnv(baseEnv());

    expect(config.profiles[0]).toMatchObject({
      allowedProviders: ["ollama"],
      allowSubscriptionProviders: false
    });
  });

  it("loads helper provider policy for remote API providers", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          allowedProviders: ["ollama", "deepseek"]
        }
      ])
    });

    expect(config.profiles[0]).toMatchObject({
      allowedProviders: ["ollama", "deepseek"],
      allowSubscriptionProviders: false
    });
    expect(config.profiles[0]).not.toHaveProperty("llmProvider");
  });

  it("loads lane provider policy for cost-aware routing", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          allowedProviders: ["ollama", "deepseek"],
          providerPolicy: {
            function_routing: { primary: "ollama" },
            admin_routing: { primary: "ollama" },
            memory_routing: { primary: "ollama" },
            smart_talk: { primary: "deepseek", fallback: "ollama" },
            general_agent: { primary: "deepseek", fallback: "ollama" },
            context_compression: { primary: "deepseek" }
          }
        }
      ])
    });

    expect(config.profiles[0].providerPolicy).toMatchObject({
      function_routing: { primary: "ollama" },
      admin_routing: { primary: "ollama" },
      memory_routing: { primary: "ollama" },
      smart_talk: { primary: "deepseek", fallback: "ollama" },
      general_agent: { primary: "deepseek", fallback: "ollama" },
      context_compression: { primary: "deepseek" }
    });
  });

  it("rejects lane provider policy outside the profile allowed provider list", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            allowedProviders: ["ollama"],
            providerPolicy: {
              smart_talk: { primary: "deepseek" }
            }
          }
        ])
      })
    ).toThrow("Profile helper providerPolicy.smart_talk primary provider deepseek is not allowed");
  });

  it("rejects unsupported provider names in profile policy", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "main",
            webhookPath: "/api/line/webhook/main",
            channelSecret: "secret",
            channelAccessToken: "token",
            allowedProviders: ["ollama", "codex_app_server"],
            allowSubscriptionProviders: false
          }
        ])
      })
    ).toThrow();
  });

  it("rejects fallback providers outside the profile provider policy", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token",
            allowedProviders: ["deepseek"]
          }
        ]),
        LLM_PROVIDER: "deepseek",
        LLM_FALLBACK_PROVIDER: "ollama"
      })
    ).toThrow("Profile helper fallback provider ollama must be listed in allowedProviders");
  });

  it("defaults profile small talk to template mode with an 80 character limit", () => {
    const config = loadConfigFromEnv(baseEnv());

    expect(config.profiles[0].smallTalk).toEqual({
      mode: "template",
      maxChars: 80
    });
  });

  it("loads profile LLM small talk settings", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          smallTalk: {
            mode: "llm",
            maxChars: 80,
            prompting: layeredPrompting
          }
        }
      ])
    });

    expect(config.profiles[0].smallTalk).toEqual({
      mode: "llm",
      maxChars: 80,
      prompting: layeredPrompting
    });
  });

  it("requires all prompting layers for a production LLM profile", async () => {
    await withProfileFile(
      [
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecretEnv: "LINE_HELPER_CHANNEL_SECRET",
          channelAccessTokenEnv: "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
          smallTalk: {
            mode: "llm",
            maxChars: 80,
            prompting: {
              personaPrompt: "persona",
              conversationRulesPrompt: "conversation",
              formatRulesPrompt: "format"
            }
          }
        }
      ],
      async (path) => {
        expect(() =>
          loadConfigFromEnv({
            NODE_ENV: "production",
            PROFILE_CONFIG_PATH: path,
            LINE_HELPER_CHANNEL_SECRET: "secret",
            LINE_HELPER_CHANNEL_ACCESS_TOKEN: "token"
          })
        ).toThrow("Production LLM smallTalk prompting for helper must include safetyRulesPrompt");
      }
    );
  });

  it("normalizes legacy profile personaPrompt into layered prompting", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          smallTalk: {
            mode: "llm",
            maxChars: 80,
            personaPrompt: "LEGACY_PERSONA"
          }
        }
      ])
    });

    expect(config.profiles[0].smallTalk).toEqual({
      mode: "llm",
      maxChars: 80,
      prompting: {
        personaPrompt: "LEGACY_PERSONA"
      }
    });
  });

  it("defaults the group conversation window to 60 seconds", () => {
    const config = loadConfigFromEnv({
      ...profilesEnv([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          generalAgent: {
            enabled: true
          }
        }
      ])
    });

    expect(config.profiles[0].generalAgent).toEqual({
      enabled: true,
      conversationWindowSeconds: 60
    });
  });

  it("loads Redis, rate limit, and last error settings", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      REDIS_URL: "redis://localhost:6379",
      REDIS_KEY_PREFIX: "test-prefix",
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_WINDOW_MS: "30000",
      RATE_LIMIT_MAX_REQUESTS: "5",
      LAST_ERRORS_MAX_ENTRIES: "7"
    });

    expect(config.redis).toEqual({
      url: "redis://localhost:6379",
      keyPrefix: "test-prefix"
    });
    expect(config.rateLimit).toEqual({
      enabled: true,
      windowMs: 30_000,
      maxRequests: 5
    });
    expect(config.lastErrors).toEqual({
      maxEntries: 7
    });
  });

  it("rejects duplicate webhook paths", () => {
    expect(() =>
      loadConfigFromEnv({
        ...profilesEnv([
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token"
          },
          {
            name: "helper",
            webhookPath: "/api/line/webhook/helper",
            channelSecret: "secret",
            channelAccessToken: "token"
          }
        ])
      })
    ).toThrow("Duplicate profile webhookPath");
  });

  it("rejects partial Graph configuration", () => {
    expect(() =>
      loadConfigFromEnv({
        ...baseEnv(),
        GRAPH_TENANT_ID: "tenant"
      })
    ).toThrow("Incomplete Graph configuration");
  });
});

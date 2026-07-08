import { describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BOT_PROFILES_JSON: JSON.stringify([
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

describe("config", () => {
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
        BOT_PROFILES_JSON: JSON.stringify({
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token"
        })
      })
    ).toThrow("BOT_PROFILES_JSON or BOT_PROFILES_BASE64_JSON must be a JSON array");
  });

  it("rejects non-canonical profile names", () => {
    expect(() =>
      loadConfigFromEnv({
        BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
      sheetMusicFolderItemId: "sheet-folder",
      sheetMusicFolderPath: "文件/流行歌譜 (捷徑)",
      sheetMusicAllowedExtensions: [".pdf", ".jpg", ".jpeg"],
      sheetMusicRecursive: true
    });
  });

  it("loads profile admin settings from adminUserId only", () => {
    const config = loadConfigFromEnv({
      BOT_PROFILES_JSON: JSON.stringify([
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

  it("loads a single bootstrap admin user id", () => {
    const config = loadConfigFromEnv({
      BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
      BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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
        BOT_PROFILES_JSON: JSON.stringify([
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

  it("loads Codex app-server as a pluggable LLM provider", () => {
    const config = loadConfigFromEnv({
      ...baseEnv(),
      LLM_PROVIDER: "codex_app_server",
      LLM_FALLBACK_PROVIDER: "ollama",
      CODEX_APP_SERVER_COMMAND: "codex",
      CODEX_APP_SERVER_ARGS: "app-server,--listen,stdio://",
      CODEX_HOME: "/mnt/codex-home"
    });

    expect(config.llm).toMatchObject({
      provider: "codex_app_server",
      fallbackProvider: "ollama",
      codexAppServerCommand: "codex",
      codexAppServerArgs: ["app-server", "--listen", "stdio://"],
      codexHome: "/mnt/codex-home"
    });
  });

  it("rejects the removed direct Codex OAuth provider", () => {
    expect(() =>
      loadConfigFromEnv({
        ...baseEnv(),
        LLM_PROVIDER: "openai_codex_oauth"
      })
    ).toThrow("openai_codex_oauth is no longer supported");
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
      BOT_PROFILES_JSON: JSON.stringify([
        {
          name: "helper",
          webhookPath: "/api/line/webhook/helper",
          channelSecret: "secret",
          channelAccessToken: "token",
          smallTalk: {
            mode: "llm",
            maxChars: 80
          }
        }
      ])
    });

    expect(config.profiles[0].smallTalk).toEqual({
      mode: "llm",
      maxChars: 80
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
        BOT_PROFILES_JSON: JSON.stringify([
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

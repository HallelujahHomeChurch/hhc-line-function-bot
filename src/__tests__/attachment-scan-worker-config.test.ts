import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAttachmentScanWorkerConfigFromEnv } from "../attachments/scan-worker-config.js";

function workerEnv(): NodeJS.ProcessEnv {
  return {
    PROFILE_CONFIG_PATH: resolve("config/profiles.json"),
    LINE_HELPER_CHANNEL_ACCESS_TOKEN: "line-access-token",
    DATABASE_URL: "postgres://worker",
    DATABASE_SSL: "true",
    REDIS_URL: "redis://worker",
    REDIS_KEY_PREFIX: "hhc",
    GRAPH_TENANT_ID: "tenant",
    GRAPH_CLIENT_ID: "client",
    GRAPH_CLIENT_SECRET: "graph-secret",
    GRAPH_DRIVE_ID: "drive",
    GRAPH_PPT_FOLDER_ITEM_ID: "ppt",
    MAX_ATTACHMENT_BYTES: "26214400",
    LINE_CONTENT_DOWNLOAD_TIMEOUT_MS: "30000",
    EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS: "15000",
    EXTERNAL_RESOURCE_MAX_REDIRECTS: "3"
  };
}

describe("attachment scan worker config", () => {
  it("loads only worker dependencies without channel secret, admin, LLM, embedding, or Notion secrets", () => {
    const config = loadAttachmentScanWorkerConfigFromEnv(workerEnv());

    expect(config.profiles).toEqual([{ name: "helper", channelAccessToken: "line-access-token" }]);
    expect(config).toMatchObject({
      redis: { url: "redis://worker", keyPrefix: "hhc" },
      database: { url: "postgres://worker", ssl: true },
      graph: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "graph-secret"
      }
    });
    expect(JSON.stringify(config)).not.toMatch(
      /channelSecret|adminUserId|deepseek|openai|notion/iu
    );
  });

  it.each([
    ["LINE_HELPER_CHANNEL_ACCESS_TOKEN"],
    ["DATABASE_URL"],
    ["REDIS_URL"],
    ["GRAPH_CLIENT_SECRET"]
  ])("fails closed when required worker setting %s is absent", (name) => {
    const env = workerEnv();
    delete env[name];

    expect(() => loadAttachmentScanWorkerConfigFromEnv(env)).toThrow(name);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    MEDIA_SYNC_MAX_BYTES: "209715200",
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
      attachments: { maxBytes: 26_214_400 },
      mediaSyncMaxBytes: 209_715_200,
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

  it.each(["0", "209715201", "1.5", "not-a-number"])(
    "rejects an invalid media-sync byte limit (%s)",
    (value) => {
      expect(() =>
        loadAttachmentScanWorkerConfigFromEnv({ ...workerEnv(), MEDIA_SYNC_MAX_BYTES: value })
      ).toThrow("MEDIA_SYNC_MAX_BYTES");
    }
  );

  it("ignores profiles that do not declare save_resource", async () => {
    await withProfileFile(
      [
        {
          name: "helper",
          channelAccessTokenEnv: "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
          enabledFunctions: ["save_resource"],
          accountLink: {
            displayName: "小哈",
            lineIdEnv: "LINE_HELPER_ACCOUNT_ID",
            providerIdEnv: "LINE_ACCOUNT_PROVIDER_ID"
          }
        },
        {
          name: "main",
          channelAccessTokenEnv: "LINE_MAIN_CHANNEL_ACCESS_TOKEN",
          enabledFunctions: ["download_weekly_paper"]
        }
      ],
      (path) => {
        const config = loadAttachmentScanWorkerConfigFromEnv({
          ...workerEnv(),
          PROFILE_CONFIG_PATH: path
        });

        expect(config.profiles).toEqual([
          { name: "helper", channelAccessToken: "line-access-token" }
        ]);
        expect(JSON.stringify(config)).not.toMatch(/account|providerId|lineId/iu);
      }
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

async function withProfileFile(profiles: unknown, callback: (path: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hhc-line-function-bot-attachment-worker-"));
  const path = join(directory, "profiles.json");
  await writeFile(path, JSON.stringify(profiles), "utf8");
  try {
    callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

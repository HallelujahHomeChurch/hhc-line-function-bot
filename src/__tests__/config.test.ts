import { describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BOT_PROFILES_JSON: JSON.stringify([
      {
        name: "main",
        webhookPath: "/line/main/webhook",
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

  it("loads profile admin allowlist settings", () => {
    const config = loadConfigFromEnv({
      BOT_PROFILES_JSON: JSON.stringify([
        {
          name: "main",
          webhookPath: "/line/main/webhook",
          channelSecret: "secret",
          channelAccessToken: "token",
          enabledFunctions: ["query_service_schedule"],
          adminUserIds: ["Uadmin"],
          adminDirectOnly: true
        }
      ])
    });

    expect(config.profiles[0]).toMatchObject({
      adminUserIds: ["Uadmin"],
      adminDirectOnly: true
    });
  });
});

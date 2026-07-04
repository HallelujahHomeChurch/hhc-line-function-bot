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
});

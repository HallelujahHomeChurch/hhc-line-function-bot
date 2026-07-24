import { readFileSync } from "node:fs";

import { loadConfigFromEnv } from "./config.js";

export interface ProductionProfileConfigSummary {
  profileNames: string[];
  webhookPaths: string[];
  providerNames: string[];
}

export function validateProductionProfileConfig(path: string): ProductionProfileConfigSummary {
  const rawProfiles = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(rawProfiles)) {
    throw new Error("Production profile config must have a JSON array root");
  }

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PROFILE_CONFIG_PATH: path,
    OBSERVABILITY_HMAC_KEY: "validation-placeholder-key-32-characters"
  };
  for (const profile of rawProfiles) {
    if (!profile || typeof profile !== "object") {
      continue;
    }
    const record = profile as Record<string, unknown>;
    for (const key of ["channelSecretEnv", "channelAccessTokenEnv", "adminUserIdEnv"]) {
      const envName = record[key];
      if (typeof envName === "string" && envName.trim()) {
        env[envName] = "placeholder";
      }
    }
    const registration = record.registration;
    if (
      registration &&
      typeof registration === "object" &&
      (registration as Record<string, unknown>).enabled === true
    ) {
      env.DATABASE_URL = "postgres://placeholder";
      env.REDIS_URL = "redis://placeholder";
    }
    if (
      Array.isArray(record.enabledFunctions) &&
      record.enabledFunctions.includes("save_resource")
    ) {
      env.ATTACHMENT_SCAN_QUEUE_URL =
        "https://storage.example.test/attachment-scan?sv=validation-placeholder";
    }
  }

  const config = loadConfigFromEnv(env);
  return {
    profileNames: config.profiles.map((profile) => profile.name),
    webhookPaths: config.profiles.map((profile) => profile.webhookPath),
    providerNames: [...new Set(config.profiles.flatMap((profile) => profile.allowedProviders))]
  };
}

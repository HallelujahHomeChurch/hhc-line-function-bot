import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateProductionProfileConfig } from "../profile-config-validation.js";

describe("production profile configuration", () => {
  it("validates the checked-in helper profile config without real credentials", () => {
    const result = validateProductionProfileConfig(resolve(process.cwd(), "config/profiles.json"));

    expect(result).toEqual({
      profileNames: ["helper"],
      webhookPaths: ["/api/line/webhook/helper"],
      providerNames: ["ollama", "deepseek"]
    });
  });
});

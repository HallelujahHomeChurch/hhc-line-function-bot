import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getFunctionDefinitions } from "../functions/definitions.js";
import { FUNCTION_NAMES } from "../types.js";

describe("media sync command boundary", () => {
  it("keeps /media-sync outside the function catalog, grants, profiles, and LLM definitions", async () => {
    const profiles = JSON.parse(
      await readFile(new URL("../../config/profiles.json", import.meta.url), "utf8")
    ) as Array<{ enabledFunctions?: string[]; permissionRequiredFunctions?: string[] }>;
    for (const name of ["media-sync", "media_sync"]) {
      expect(FUNCTION_NAMES).not.toContain(name);
      expect(
        getFunctionDefinitions([...FUNCTION_NAMES]).map((definition) => definition.name)
      ).not.toContain(name);
      expect(
        profiles.flatMap((profile) => [
          ...(profile.enabledFunctions ?? []),
          ...(profile.permissionRequiredFunctions ?? [])
        ])
      ).not.toContain(name);
    }
  });
});

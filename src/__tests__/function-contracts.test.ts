import { describe, expect, it } from "vitest";

import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";

const internalTerms = [
  "OneDrive",
  "Notion",
  "Graph",
  "Redis",
  "database",
  "Postgres",
  "資料庫",
  "儲存",
  "儲存空間",
  "雲端儲存",
  "供應商",
  "服務提供者",
  "內部實作"
];

describe("function capability contracts", () => {
  it("defines user-facing metadata for every function", () => {
    for (const definition of CAPABILITY_CATALOG) {
      expect(definition.displayName, definition.name).toBeTruthy();
      expect(definition.shortDescription, definition.name).toBeTruthy();
      expect(definition.examples.length, definition.name).toBeGreaterThan(0);
      expect(definition.requires.length, definition.name).toBeGreaterThan(0);
      expect(definition.scope, definition.name).toMatch(/^(profile|group_capable)$/);
      expect(definition.clarificationPrompt, definition.name).toBeTruthy();
      expect(definition.sideEffectLevel, definition.name).toMatch(
        /^(read|write|admin|destructive)$/
      );
      expect(definition.allowedSources.length, definition.name).toBeGreaterThan(0);
      expect(definition.resourcePolicy, definition.name).toBeTruthy();
      expect(definition.memoryPolicy, definition.name).toBeTruthy();
      expect(definition.requiredSlots, definition.name).toBeDefined();
      expect(definition.agentCapability, definition.name).toBeDefined();
    }
  });

  it("keeps user-facing metadata free of implementation service names", () => {
    for (const definition of CAPABILITY_CATALOG) {
      const userFacing = [
        definition.displayName,
        definition.shortDescription,
        definition.clarificationPrompt,
        definition.helpText,
        ...definition.examples
      ].join("\n");

      for (const term of internalTerms) {
        expect(userFacing).not.toContain(term);
      }
    }
  });
});

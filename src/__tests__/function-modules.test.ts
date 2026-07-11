import { describe, expect, it } from "vitest";

import { FUNCTION_NAMES } from "../types.js";
import { FUNCTION_MODULES, getRouterEvalCases } from "../functions/modules.js";

const requiredEvalKinds = [
  "positive",
  "missing_slot",
  "typo",
  "negative",
  "disabled",
  "cross_function"
];

describe("function modules", () => {
  it("has one module for each supported function", () => {
    expect(FUNCTION_MODULES.map((module) => module.name).sort()).toEqual(
      [...FUNCTION_NAMES].sort()
    );
  });

  it("keeps each function module self-contained", () => {
    for (const module of FUNCTION_MODULES) {
      expect(module.definition.name).toBe(module.name);
      expect(module.definition.displayName, module.name).toBeTruthy();
      expect(module.definition.shortDescription, module.name).toBeTruthy();
      expect(module.definition.argumentSchema, module.name).toBeTruthy();
      expect(module.definition.keywordFallback, module.name).toBeTruthy();
      expect(module.routerEvalCases.length, module.name).toBeGreaterThanOrEqual(
        requiredEvalKinds.length
      );
      expect(module.routerEvalCases.map((entry) => entry.kind)).toEqual(
        expect.arrayContaining(requiredEvalKinds)
      );

      for (const entry of module.routerEvalCases) {
        expect(entry.text.trim(), module.name).toBeTruthy();
        expect(entry.expected.type, `${module.name}:${entry.text}`).toMatch(/^(execute|deny)$/);
      }
    }
  });

  it("exposes all executable router eval cases from modules", () => {
    const cases = getRouterEvalCases().filter((entry) => entry.expected.type === "execute");

    expect(cases.map((entry) => entry.expected.action)).toEqual(
      expect.arrayContaining(["find_ppt_slides", "query_schedule", "find_sheet_music"])
    );
    expect(cases.every((entry) => entry.text.trim())).toBe(true);
  });
});

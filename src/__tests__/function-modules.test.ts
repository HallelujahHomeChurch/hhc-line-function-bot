import { describe, expect, it } from "vitest";

import { FUNCTION_NAMES } from "../types.js";
import { FUNCTION_DEFINITIONS } from "../functions/definitions.js";
import { FUNCTION_MODULES } from "../functions/modules.js";

describe("function modules", () => {
  it("registers exactly one module and definition for each function", () => {
    expect(FUNCTION_MODULES.map(({ name }) => name).sort()).toEqual([...FUNCTION_NAMES].sort());
    expect(FUNCTION_DEFINITIONS.map(({ name }) => name).sort()).toEqual([...FUNCTION_NAMES].sort());
    expect(new Set(FUNCTION_MODULES.map(({ name }) => name)).size).toBe(FUNCTION_MODULES.length);
  });
});

import { describe, expect, it } from "vitest";

import { FUNCTION_DEFINITIONS, getFunctionDefinition } from "../functions/definitions.js";
import { FUNCTION_NAMES } from "../types.js";

describe("function definitions", () => {
  it("defines every function name in one catalog", () => {
    expect(FUNCTION_DEFINITIONS.map((definition) => definition.name).sort()).toEqual(
      [...FUNCTION_NAMES].sort()
    );
  });

  it("exposes Wikipedia lookup as a first-class read capability", () => {
    expect(FUNCTION_NAMES).toContain("query_wikipedia");
  });

  it("uses find_sheet_music as the canonical sheet music function", () => {
    expect(FUNCTION_NAMES).toContain("find_sheet_music");
    expect(getFunctionDefinition("find_sheet_music")).toMatchObject({
      name: "find_sheet_music",
      sideEffectLevel: "read",
      resourcePolicy: {
        kind: "graph_file",
        resourceTypes: ["sheet_music"]
      },
      keywordFallback: {
        defaultArguments: { fileType: "pdf", matchMode: "fuzzy" }
      }
    });
  });

  it("uses one declarative generic-slot contract for user-facing lookups", () => {
    const lookupNames = [
      "find_ppt_slides",
      "query_schedule",
      "find_pop_sheet_music",
      "query_wikipedia",
      "retrieve_memory"
    ] as const;

    for (const name of lookupNames) {
      const slot = getFunctionDefinition(name)?.requiredSlots[0];
      expect(slot?.missingWhen).toBe("blank");
      expect(slot?.genericRequest?.phrases.length).toBeGreaterThan(0);
    }
  });

  it("carries router prompt, keyword fallback, and quick reply metadata for sheet music", () => {
    const definition = getFunctionDefinition("find_pop_sheet_music");

    expect(definition).toMatchObject({
      name: "find_pop_sheet_music",
      quickReply: {
        label: "查流行歌譜",
        command: "小哈 查流行歌譜"
      },
      keywordFallback: {
        defaultArguments: { fileType: "pdf", matchMode: "fuzzy" }
      }
    });
    expect(definition?.description).toContain("流行歌譜");
    expect(definition?.keywordFallback?.keywords).toContain("樂譜");
  });
});

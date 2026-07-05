import { describe, expect, it } from "vitest";

import { FUNCTION_DEFINITIONS, getFunctionDefinition } from "../functions/definitions.js";
import { FUNCTION_NAMES } from "../types.js";

describe("function definitions", () => {
  it("defines every function name in one catalog", () => {
    expect(FUNCTION_DEFINITIONS.map((definition) => definition.name).sort()).toEqual(
      [...FUNCTION_NAMES].sort()
    );
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

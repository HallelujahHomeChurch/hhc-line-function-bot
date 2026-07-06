import { describe, expect, it } from "vitest";

import { normalizeFunctionArguments } from "../functions/argument-normalization.js";

describe("function argument normalization", () => {
  it("extracts a sheet music title from natural user text when the model omits the query", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "", matchMode: "fuzzy" },
        { text: "小哈，幫我找 Yesterday 的流行歌曲樂譜" }
      )
    ).toMatchObject({
      query: "Yesterday",
      matchMode: "fuzzy"
    });
  });

  it("cleans a wrapped sheet music query returned by the model", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "小哈 幫我找 A TIME FOR US 的樂譜", fileType: "pdf" },
        { text: "小哈 幫我找 A TIME FOR US 的樂譜" }
      )
    ).toMatchObject({
      query: "A TIME FOR US",
      fileType: "pdf"
    });
  });

  it("keeps generic sheet music requests empty so the function can clarify", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "小哈 查流行歌曲樂譜" },
        { text: "小哈 查流行歌曲樂譜" }
      )
    ).toMatchObject({
      query: ""
    });
  });

  it("preserves service schedule structured metadata while filling the query when missing", () => {
    expect(
      normalizeFunctionArguments(
        "query_service_schedule",
        { query: "", dateIntent: "next_meeting", meeting: "主日" },
        { text: "小哈 下一場主日服事表" }
      )
    ).toMatchObject({
      query: "小哈 下一場主日服事表",
      dateIntent: "next_meeting",
      meeting: "主日"
    });
  });
});

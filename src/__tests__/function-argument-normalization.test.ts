import { describe, expect, it } from "vitest";

import { normalizeFunctionArguments } from "../functions/argument-normalization.js";

describe("function argument normalization", () => {
  it("clears a model-inferred Wikipedia topic when the user only selects Wikipedia lookup", () => {
    expect(
      normalizeFunctionArguments(
        "query_wikipedia",
        { query: "烏戈·查維茲" },
        { text: "小哈 查維基百科" }
      )
    ).toMatchObject({
      query: ""
    });
  });

  it("clears a model-inferred schedule range when the user only asks for service staff", () => {
    expect(
      normalizeFunctionArguments(
        "query_schedule",
        { query: "下一場服事", dateIntent: "next_meeting" },
        { text: "小哈 查服事人員" }
      )
    ).toMatchObject({
      query: ""
    });
  });

  it("clears a model-inferred sheet title when the user only asks for a score", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "Yesterday" },
        { text: "小哈 查譜" }
      )
    ).toMatchObject({
      query: ""
    });
  });

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

  it("clears hallucinated sheet music titles when the user only asks for sheet music", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "Yesterday", matchMode: "fuzzy" },
        { text: "小哈 查流行歌譜" }
      )
    ).toMatchObject({
      query: "",
      matchMode: "fuzzy"
    });
  });

  it("treats short generic sheet music requests as missing the song title", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "小哈幫我查譜", matchMode: "fuzzy" },
        { text: "小哈幫我查譜" }
      )
    ).toMatchObject({
      query: "",
      matchMode: "fuzzy"
    });
  });

  it("extracts a song title from short sheet music phrasing", () => {
    expect(
      normalizeFunctionArguments(
        "find_pop_sheet_music",
        { query: "", matchMode: "fuzzy" },
        { text: "小哈幫我查 Yesterday 的譜" }
      )
    ).toMatchObject({
      query: "Yesterday",
      matchMode: "fuzzy"
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

  it("clears model-inferred next meeting metadata for generic service schedule requests", () => {
    const result = normalizeFunctionArguments(
      "query_service_schedule",
      { query: "服事表", dateIntent: "next_meeting", limit: 1 },
      { text: "小哈查服事表" }
    );

    expect(result).toMatchObject({
      query: "",
      limit: 1
    });
    expect(result).not.toHaveProperty("dateIntent");
  });

  it("keeps explicit next meeting service schedule intent", () => {
    expect(
      normalizeFunctionArguments(
        "query_service_schedule",
        { query: "", dateIntent: "next_meeting", limit: 1 },
        { text: "小哈 下一場聚會服事表" }
      )
    ).toMatchObject({
      query: "小哈 下一場聚會服事表",
      dateIntent: "next_meeting",
      limit: 1
    });
  });
});

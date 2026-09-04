import { describe, expect, it } from "vitest";

import {
  hasExplicitWriteEvidence,
  normalizeFunctionArguments
} from "../functions/argument-normalization.js";

describe("function argument normalization", () => {
  it("extracts a bounded issue number only from explicit Weekly Paper intent", () => {
    expect(
      normalizeFunctionArguments(
        "download_weekly_paper" as never,
        {},
        { text: "下載第 1733 期週報" }
      )
    ).toEqual({ issueNumber: 1733 });
    expect(
      normalizeFunctionArguments(
        "download_weekly_paper" as never,
        { issueNumber: 1733 },
        { text: "1733" }
      )
    ).toEqual({});
    expect(
      normalizeFunctionArguments(
        "download_weekly_paper" as never,
        {},
        { text: "下載第 2147483648 期週報" }
      )
    ).toEqual({ issueNumber: 2_147_483_648 });
    expect(
      normalizeFunctionArguments("download_weekly_paper" as never, {}, { text: "1733期週報" })
    ).toEqual({ issueNumber: 1733 });
    expect(
      normalizeFunctionArguments("download_weekly_paper" as never, {}, { text: "週報第1733期" })
    ).toEqual({ issueNumber: 1733 });
    expect(
      normalizeFunctionArguments(
        "download_weekly_paper" as never,
        {},
        {
          text: "第10000001733期週報"
        }
      )
    ).toEqual({ issueNumber: 10_000_001_733 });
  });

  it("drops a model-only sheet music format and defaults the search to any", () => {
    expect(
      normalizeFunctionArguments(
        "find_sheet_music",
        { query: "奔跑不放棄", fileType: "pdf" },
        { text: "幫我找奔跑不放棄歌譜" }
      )
    ).toMatchObject({ query: "奔跑不放棄", fileType: "any" });
  });

  it("keeps an explicitly requested sheet music format", () => {
    expect(
      normalizeFunctionArguments(
        "find_sheet_music",
        { query: "奔跑不放棄", fileType: "pdf" },
        { text: "幫我找奔跑不放棄 PDF 歌譜" }
      )
    ).toMatchObject({ fileType: "pdf" });
  });

  it("normalizes generic knowledge ordinals without a travel-specific rule", () => {
    expect(
      normalizeFunctionArguments(
        "query_knowledge",
        { query: "第一個地點是哪裡" },
        { text: "小哈 第一個地點是哪裡" }
      )
    ).toEqual({ query: "第一個地點是哪裡", ordinal: 0 });
    expect(
      normalizeFunctionArguments(
        "query_knowledge",
        { query: "第二步是什麼" },
        { text: "第二步是什麼" }
      )
    ).toEqual({ query: "第二步是什麼", ordinal: 1 });
  });
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

  it("removes an explicit knowledge capability prefix from the retrieval query", () => {
    expect(
      normalizeFunctionArguments(
        "query_knowledge",
        { query: "改查知識 synthetic alpha procedure" },
        { text: "改查知識 synthetic alpha procedure" }
      )
    ).toMatchObject({ query: "synthetic alpha procedure" });
  });

  it("keeps a model-inferred next meeting range for a generic service staff query", () => {
    expect(
      normalizeFunctionArguments(
        "query_schedule",
        { query: "下一場服事", dateIntent: "next_meeting" },
        { text: "小哈 查服事人員" }
      )
    ).toMatchObject({
      query: "下一場服事",
      dateIntent: "next_meeting"
    });
  });

  it("clears a model-inferred sheet title when the user only asks for a score", () => {
    expect(
      normalizeFunctionArguments("find_sheet_music", { query: "Yesterday" }, { text: "小哈 查譜" })
    ).toMatchObject({
      query: ""
    });
  });

  it("extracts a sheet music title from natural user text when the model omits the query", () => {
    expect(
      normalizeFunctionArguments(
        "find_sheet_music",
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
        "find_sheet_music",
        { query: "小哈 幫我找 A TIME FOR US 的樂譜", fileType: "pdf" },
        { text: "小哈 幫我找 A TIME FOR US 的樂譜" }
      )
    ).toMatchObject({
      query: "A TIME FOR US",
      fileType: "any"
    });
  });

  it("keeps generic sheet music requests empty so the function can clarify", () => {
    expect(
      normalizeFunctionArguments(
        "find_sheet_music",
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
        "find_sheet_music",
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
        "find_sheet_music",
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
        "find_sheet_music",
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
        "query_schedule",
        { query: "", dateIntent: "next_meeting", meeting: "主日" },
        { text: "小哈 下一場主日服事表" }
      )
    ).toMatchObject({
      query: "小哈 下一場主日服事表",
      dateIntent: "next_meeting",
      meeting: "主日"
    });
  });

  it("keeps model-inferred next meeting metadata for generic service schedule requests", () => {
    const result = normalizeFunctionArguments(
      "query_schedule",
      { query: "服事表", dateIntent: "next_meeting", limit: 1 },
      { text: "小哈查服事表" }
    );

    expect(result).toMatchObject({
      query: "服事表",
      dateIntent: "next_meeting",
      limit: 1
    });
  });

  it("keeps explicit next meeting service schedule intent", () => {
    expect(
      normalizeFunctionArguments(
        "query_schedule",
        { query: "", dateIntent: "next_meeting", limit: 1 },
        { text: "小哈 下一場聚會服事表" }
      )
    ).toMatchObject({
      query: "小哈 下一場聚會服事表",
      dateIntent: "next_meeting",
      limit: 1
    });
  });

  it("infers next meeting intent from an explicit natural-language schedule request", () => {
    expect(
      normalizeFunctionArguments(
        "query_schedule",
        { query: "下次世緯家園服事是什麼時候" },
        { text: "小哈 下次世緯家園服事是什麼時候" }
      )
    ).toMatchObject({
      query: "下次世緯家園服事是什麼時候",
      dateIntent: "next_meeting"
    });
  });

  it("normalizes a generic suffix from a current-message schedule role", () => {
    expect(
      normalizeFunctionArguments(
        "query_schedule",
        {
          query: "synthetic service",
          dateIntent: "specific_date",
          specificDate: "2026-07-27",
          role: "投影服事"
        },
        {
          text: "查 synthetic service 2026-07-27 投影服事",
          inferStructuredEvidence: true,
          now: new Date("2026-07-26T00:00:00.000Z"),
          timeZone: "Asia/Taipei"
        }
      )
    ).toMatchObject({
      query: "synthetic service",
      dateIntent: "specific_date",
      specificDate: "2026-07-27",
      role: "投影"
    });
  });

  it("does not treat a generic schedule noun as a role filter", () => {
    const normalized = normalizeFunctionArguments(
      "query_schedule",
      {
        query: "synthetic service",
        dateIntent: "specific_date",
        specificDate: "2026-07-27",
        role: "服事"
      },
      {
        text: "查 synthetic service 2026-07-27 服事",
        inferStructuredEvidence: true,
        now: new Date("2026-07-26T00:00:00.000Z"),
        timeZone: "Asia/Taipei"
      }
    );

    expect(normalized).not.toHaveProperty("role");
  });

  it("clears model-inferred content when the user only asks to remember a schedule", () => {
    expect(
      normalizeFunctionArguments(
        "save_schedule",
        { content: "服事表" },
        { text: "小哈幫我記住服事表" }
      )
    ).toMatchObject({ content: "" });
  });

  it("derives explicit text-memory visibility from the current message", () => {
    expect(
      normalizeFunctionArguments(
        "save_memory",
        { content: "集合時間是下午兩點半" },
        { text: "小哈幫我記住集合時間是下午兩點半，群組共用" }
      )
    ).toMatchObject({
      content: "集合時間是下午兩點半",
      visibility: "group"
    });
  });

  it.each([
    "不要刪除 7/14 晨更",
    "不要保存 7/14 晨更",
    "先別修改 7/14 晨更",
    "不要幫我刪除 7/14 晨更",
    "不要替我再修改 7/14 晨更",
    "先別把昨天資料刪除 7/14 晨更"
  ])("does not treat a negated write as positive evidence: %s", (text) => {
    expect(hasExplicitWriteEvidence(text, { content: "7/14 晨更" })).toBe(false);
  });

  it("allows a later positive clause to authorize its grounded write target", () => {
    expect(hasExplicitWriteEvidence("不要刪除舊的，請刪除新的", { content: "新的" })).toBe(true);
    expect(hasExplicitWriteEvidence("不要刪除舊的，請刪除新的", { content: "舊的" })).toBe(false);
  });

  it("does not authorize writes from an empty or entirely non-evidence argument set", () => {
    expect(hasExplicitWriteEvidence("幫我保存", {})).toBe(false);
    expect(
      hasExplicitWriteEvidence("幫我保存", {
        operation: "replace",
        confirm: true,
        query: "幫我保存"
      })
    ).toBe(false);
  });

  it("keeps positive write evidence when the payload is present in current text", () => {
    expect(hasExplicitWriteEvidence("幫我保存 7/14 晨更", { content: "7/14 晨更" })).toBe(true);
  });
});

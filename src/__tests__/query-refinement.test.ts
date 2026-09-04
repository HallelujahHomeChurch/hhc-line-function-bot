import { describe, expect, it } from "vitest";

import { buildResidualQuery } from "../functions/query-refinement.js";
import {
  extractScheduleRoleFocus,
  refineScheduleQuery
} from "../functions/schedule-query-refinement.js";

describe("query refinement", () => {
  it("removes consumed phrases while preserving unknown search text", () => {
    expect(
      buildResidualQuery({
        query: "小哈 給我下一場青年影視團隊服事表",
        consumedTerms: ["下一場", "影視團隊"],
        genericTerms: ["小哈", "給我", "服事表"]
      })
    ).toBe("青年");
  });

  it("returns an empty residual instead of a generic capability phrase", () => {
    expect(
      buildResidualQuery({
        query: "下一場服事表的音控是誰",
        consumedTerms: ["下一場", "音控"],
        genericTerms: ["服事表", "的", "是誰"]
      })
    ).toBe("");
  });

  it.each([
    [
      { query: "給我下一場影視團隊的服事表" },
      {
        structuredArguments: {
          dateIntent: "next_meeting"
        },
        residualQuery: "影視團隊"
      }
    ],
    [
      { query: "下一場服事表的音控是誰" },
      {
        structuredArguments: { dateIntent: "next_meeting", role: "音控" },
        residualQuery: ""
      }
    ],
    [
      { query: "下一場青年服事表" },
      {
        structuredArguments: { dateIntent: "next_meeting" },
        residualQuery: "青年"
      }
    ],
    [
      { query: "最新的" },
      {
        structuredArguments: { dateIntent: "next_meeting" },
        residualQuery: ""
      }
    ]
  ])("refines schedule query %#", (args, expected) => {
    expect(
      refineScheduleQuery(args, new Date("2026-07-12T00:00:00.000Z"), "Asia/Taipei")
    ).toMatchObject(expected);
  });

  it("trusts only known, continuation-metadata, or explicit service-syntax roles", () => {
    expect(
      extractScheduleRoleFocus({ query: "主日午餐呢", hasContinuation: false })
    ).toBeUndefined();
    expect(extractScheduleRoleFocus({ query: "主日主持呢", hasContinuation: false })).toBe("主持");
    expect(extractScheduleRoleFocus({ query: "主日燈光服事是誰", hasContinuation: false })).toBe(
      "燈光"
    );
    expect(
      extractScheduleRoleFocus({
        query: "燈光呢",
        hasContinuation: true,
        availableRoles: ["燈光"]
      })
    ).toBe("燈光");
  });
});

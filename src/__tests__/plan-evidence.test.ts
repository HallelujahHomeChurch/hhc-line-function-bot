import { describe, expect, it } from "vitest";

import {
  hasCurrentTextEvidence,
  hasEllipticalActiveTaskReference
} from "../agent/plan-evidence.js";

describe("plan evidence scalar grounding", () => {
  it("matches numeric evidence as an exact token instead of a substring", () => {
    expect(hasCurrentTextEvidence("第10個", 1)).toBe(false);
    expect(hasCurrentTextEvidence("選 1 和 10", 1)).toBe(true);
  });

  it("requires every array element to have exact evidence", () => {
    expect(hasCurrentTextEvidence("選 1 和 10", [1, 10])).toBe(true);
    expect(hasCurrentTextEvidence("只選 10", [1, 10])).toBe(false);
  });

  it("uses token boundaries for short ASCII values", () => {
    expect(hasCurrentTextEvidence("open the scoreboard", "score")).toBe(false);
    expect(hasCurrentTextEvidence("find score PDF", "score")).toBe(true);
  });

  it("requires explicit year evidence for a proposed full date", () => {
    expect(hasCurrentTextEvidence("查 7/14 服事", "2026-07-14")).toBe(false);
    expect(hasCurrentTextEvidence("查 2026/7/14 服事", "2026-07-14")).toBe(true);
    expect(hasCurrentTextEvidence("查 2026年7月14日服事", "2026-07-14")).toBe(true);
    expect(hasCurrentTextEvidence("查明天服事", "tomorrow")).toBe(true);
    expect(hasCurrentTextEvidence("查今天服事", "tomorrow")).toBe(false);
  });

  it("honors affirmative and negative polarity for booleans", () => {
    expect(hasCurrentTextEvidence("不要確認", true)).toBe(false);
    expect(hasCurrentTextEvidence("不要確認", false)).toBe(true);
    expect(hasCurrentTextEvidence("確認保存", true)).toBe(true);
  });

  it("distinguishes informational ellipsis from interpersonal chat", () => {
    expect(hasEllipticalActiveTaskReference("那幾點集合？")).toBe(true);
    expect(hasEllipticalActiveTaskReference("那你是誰？")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  hasActiveEntityTextEvidence,
  hasCurrentTextEvidence,
  hasEllipticalActiveTaskReference
} from "../agent/plan-evidence.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import type { ActiveTaskContext } from "../agent/active-task.js";

describe("plan evidence scalar grounding", () => {
  it("recognizes declared response-field and full-view follow-ups without repeating the function", () => {
    const task: ActiveTaskContext = {
      version: 2,
      currentCapability: "find_resource",
      allowedCapabilities: ["find_resource"],
      anchors: { resourceId: "resource-1" },
      entities: [{ type: "resource", key: "resource-1", label: "教會資料" }],
      references: { resourceId: "resource-1" },
      supportedOperations: ["continue", "refine", "view_full"],
      responseContext: {
        availableFields: ["title", "link"],
        defaultProjection: "focused"
      },
      createdAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-17T00:10:00.000Z"
    };
    const contract = getFunctionDefinition("find_resource")?.agentCapability;
    expect(contract).toBeDefined();

    expect(hasActiveEntityTextEvidence("連結呢", contract!, task)).toBe(true);
    expect(hasActiveEntityTextEvidence("給我完整內容", contract!, task)).toBe(true);
    expect(hasActiveEntityTextEvidence("你叫什麼名字", contract!, task)).toBe(false);
  });

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
    for (const text of [
      "那你是誰？",
      "那你叫什麼名字",
      "那你是誰啊",
      "那你名字叫什麼",
      "你的名字叫什麼？",
      "名字呢，你叫什麼？"
    ]) {
      expect(hasEllipticalActiveTaskReference(text)).toBe(false);
    }
    expect(hasEllipticalActiveTaskReference("那第一天叫什麼名字？")).toBe(true);
    expect(hasEllipticalActiveTaskReference("那你知道幾點集合嗎？")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildCapabilityCandidates,
  type KnowledgeSourceMetadata
} from "../agent/capability-candidates.js";
import type { ActiveTaskContext } from "../agent/active-task.js";
import { getFunctionDefinition } from "../functions/definitions.js";

const scheduleTask: ActiveTaskContext = {
  version: 1,
  capability: "query_schedule",
  anchors: { date: "2026-07-14", meeting: "晨更" },
  entities: [
    {
      type: "role",
      key: "front-camera",
      label: "前攝影",
      aliases: ["攝影"]
    }
  ],
  supportedOperations: ["continue", "refine", "advance"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

const knowledgeTask: ActiveTaskContext = {
  version: 1,
  capability: "query_knowledge",
  anchors: { sourceKey: "retreat" },
  entities: [{ type: "section", key: "day-one", label: "第一天" }],
  supportedOperations: ["continue", "refine", "advance", "select"],
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:01:00.000Z"
};

const retreatKnowledge: KnowledgeSourceMetadata = {
  sourceKey: "retreat",
  displayName: "2026 青年出隊",
  aliases: ["出隊"],
  topics: ["第一天"]
};

describe("deterministic capability candidates", () => {
  it("uses an active task entity as bounded continuation evidence", () => {
    expect(
      buildCapabilityCandidates({
        text: "前攝影",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: scheduleTask,
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([
      expect.objectContaining({ capability: "query_schedule", reason: "active_task_entity" })
    ]);
  });

  it("uses bounded dynamic knowledge metadata without returning matched text", () => {
    const candidates = buildCapabilityCandidates({
      text: "第一天去哪裡",
      enabledFunctions: ["query_schedule", "query_knowledge"],
      knowledgeSources: [retreatKnowledge],
      maxCandidates: 3
    });

    expect(candidates).toEqual([
      expect.objectContaining({ capability: "query_knowledge", reason: "knowledge_metadata" })
    ]);
    expect(JSON.stringify(candidates)).not.toContain("第一天");
    expect(JSON.stringify(candidates)).not.toContain("retreat");
  });

  it("ranks explicit current-message evidence above another capability's active task", () => {
    expect(
      buildCapabilityCandidates({
        text: "查主日服事，第一天也要看",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: knowledgeTask,
        knowledgeSources: [retreatKnowledge],
        maxCandidates: 3
      }).map(({ capability, reason }) => ({ capability, reason }))
    ).toEqual([
      { capability: "query_schedule", reason: "explicit_intent" },
      { capability: "query_knowledge", reason: "active_task_entity" }
    ]);
  });

  it("does not turn write intent into a read candidate from continuation alone", () => {
    expect(
      buildCapabilityCandidates({
        text: "幫我記住前攝影",
        enabledFunctions: ["query_schedule", "save_schedule"],
        activeTask: scheduleTask,
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("never returns a disabled or write capability", () => {
    expect(
      buildCapabilityCandidates({
        text: "查服事並幫我保存服事表",
        enabledFunctions: ["save_schedule"],
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("recognizes positive and one-edit typo hints deterministically", () => {
    expect(
      buildCapabilityCandidates({
        text: "小哈 查投影片 主日報告",
        enabledFunctions: ["find_ppt_slides"],
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "find_ppt_slides", reason: "explicit_intent" });

    expect(
      buildCapabilityCandidates({
        text: "小哈 找投影篇 主日報告",
        enabledFunctions: ["find_ppt_slides"],
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "find_ppt_slides", reason: "capability_hint" });
  });

  it("returns no candidate for unrelated negative text", () => {
    expect(
      buildCapabilityCandidates({
        text: "今天天氣如何",
        enabledFunctions: [
          "find_ppt_slides",
          "query_schedule",
          "query_knowledge",
          "find_sheet_music"
        ],
        knowledgeSources: [retreatKnowledge],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("keeps cross-function evidence on the matching capability", () => {
    expect(
      buildCapabilityCandidates({
        text: "找歌譜 主日報告",
        enabledFunctions: ["find_ppt_slides", "find_sheet_music"],
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["find_sheet_music"]);
  });

  it("applies the definition's source policy before producing candidates", () => {
    const definition = getFunctionDefinition("query_wikipedia")!;
    const originalAllowedSources = definition.allowedSources;
    definition.allowedSources = ["user"];
    try {
      expect(
        buildCapabilityCandidates({
          text: "查維基百科 Fastify",
          enabledFunctions: ["query_wikipedia"],
          source: "group",
          knowledgeSources: [],
          maxCandidates: 3
        })
      ).toEqual([]);
    } finally {
      definition.allowedSources = originalAllowedSources;
    }
  });

  it("bounds output and uses definition order as a stable tie-break", () => {
    const input = {
      text: "查投影片也查歌譜",
      enabledFunctions: ["find_sheet_music", "find_ppt_slides"] as const,
      knowledgeSources: [],
      maxCandidates: 1
    };

    expect(buildCapabilityCandidates(input).map(({ capability }) => capability)).toEqual([
      "find_ppt_slides"
    ]);
    expect(buildCapabilityCandidates(input)).toEqual(buildCapabilityCandidates(input));
  });

  it("allows active-task evidence to boost only the task's own capability", () => {
    expect(
      buildCapabilityCandidates({
        text: "第一天",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: knowledgeTask,
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["query_knowledge"]);
  });
});

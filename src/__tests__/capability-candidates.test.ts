import { describe, expect, it } from "vitest";

import {
  buildCapabilityCandidates,
  type BuildCapabilityCandidatesInput,
  type KnowledgeSourceMetadata
} from "../agent/capability-candidates.js";
import type { ActiveTaskContext } from "../agent/active-task.js";
import { getFunctionDefinition } from "../functions/definitions.js";

const scheduleTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
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
  version: 2,
  currentCapability: "query_knowledge",
  allowedCapabilities: ["query_knowledge"],
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
  it("fails closed at runtime when source policy input is omitted", () => {
    const unsafeInput = {
      text: "查維基百科 Fastify",
      enabledFunctions: ["query_wikipedia"],
      knowledgeSources: [],
      maxCandidates: 3
    } as BuildCapabilityCandidatesInput;

    expect(buildCapabilityCandidates(unsafeInput)).toEqual([]);
  });

  it("uses an active task entity as bounded continuation evidence", () => {
    expect(
      buildCapabilityCandidates({
        text: "前攝影",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: scheduleTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([
      expect.objectContaining({ capability: "query_schedule", reason: "active_task_entity" })
    ]);
  });

  it.each([
    "那你是誰？",
    "那你叫什麼名字",
    "那你是誰啊",
    "那你名字叫什麼",
    "你的名字叫什麼？",
    "名字呢，你叫什麼？"
  ])("keeps structural interpersonal questions out of active-task continuation: %s", (text) => {
    expect(
      buildCapabilityCandidates({
        text,
        enabledFunctions: ["query_knowledge"],
        activeTask: knowledgeTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("still routes an explicit function request that addresses the bot", () => {
    expect(
      buildCapabilityCandidates({
        text: "你可以幫我查主日服事嗎？",
        enabledFunctions: ["query_schedule"],
        activeTask: knowledgeTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_schedule", reason: "explicit_intent" });
  });

  it("keeps second-person informational task questions eligible", () => {
    expect(
      buildCapabilityCandidates({
        text: "那你知道幾點集合嗎？",
        enabledFunctions: ["query_knowledge"],
        activeTask: knowledgeTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_knowledge", reason: "active_task_entity" });

    expect(
      buildCapabilityCandidates({
        text: "你可以幫我查明天的服事安排嗎？",
        enabledFunctions: ["query_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_schedule" });
  });

  it.each([
    ["那主日主持呢", "meeting", "role"],
    ["明天前攝影是誰", "dateIntent", "role"]
  ])(
    "uses declarative argument evidence for future schedule roles: %s",
    (text, firstField, secondField) => {
      const [candidate] = buildCapabilityCandidates({
        text,
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: knowledgeTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      });

      expect(candidate).toEqual(
        expect.objectContaining({ capability: "query_schedule", reason: "argument_evidence" })
      );
      expect(candidate.contract.argumentEvidence).toEqual(
        expect.objectContaining({ allOf: ["role"], anyOf: expect.arrayContaining([firstField]) })
      );
      expect(candidate.contract.argumentEvidence?.allOf).toContain(secondField);
    }
  );

  it("does not encode schedule role combinations as explicit intent phrases", () => {
    const intents = getFunctionDefinition("query_schedule")!.agentCapability!.intents;

    expect(intents).not.toEqual(expect.arrayContaining(["主日音控", "主日導播", "主日攝影"]));
  });

  it("does not treat an arbitrary short residual as a schedule role", () => {
    expect(
      buildCapabilityCandidates({
        text: "主日午餐呢",
        enabledFunctions: ["query_schedule"],
        activeTask: knowledgeTask,
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it.each(["主日主持呢", "明天前攝影是誰"])(
    "accepts a known schedule role without explicit service syntax: %s",
    (text) => {
      expect(
        buildCapabilityCandidates({
          text,
          enabledFunctions: ["query_schedule"],
          source: "group",
          knowledgeSources: [],
          maxCandidates: 3
        })[0]
      ).toMatchObject({ capability: "query_schedule", reason: "argument_evidence" });
    }
  );

  it("accepts a future role only with explicit service-role syntax", () => {
    expect(
      buildCapabilityCandidates({
        text: "主日燈光服事是誰",
        enabledFunctions: ["query_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_schedule", reason: "argument_evidence" });
  });

  it("uses bounded dynamic knowledge metadata without returning matched text", () => {
    const candidates = buildCapabilityCandidates({
      text: "第一天去哪裡",
      enabledFunctions: ["query_schedule", "query_knowledge"],
      source: "group",
      knowledgeSources: [retreatKnowledge],
      maxCandidates: 3
    });

    expect(candidates).toEqual([
      expect.objectContaining({ capability: "query_knowledge", reason: "knowledge_metadata" })
    ]);
    expect(JSON.stringify(candidates)).not.toContain("第一天");
    expect(JSON.stringify(candidates)).not.toContain("retreat");
  });

  it("uses generic retrieval evidence without returning opaque evidence details", () => {
    const candidates = buildCapabilityCandidates({
      text: "急救箱位置",
      enabledFunctions: ["query_knowledge"],
      source: "group",
      knowledgeSources: [],
      retrievalEvidence: ["query_knowledge"],
      maxCandidates: 3
    });

    expect(candidates).toEqual([
      expect.objectContaining({ capability: "query_knowledge", reason: "retrieval_evidence" })
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(/source-|document-|急救箱位置/u);
  });

  it("ranks explicit current-message evidence above another capability's active task", () => {
    expect(
      buildCapabilityCandidates({
        text: "查主日服事，第一天也要看",
        enabledFunctions: ["query_schedule", "query_knowledge"],
        activeTask: knowledgeTask,
        source: "group",
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
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("retains the write guard for non-knowledge retrieval evidence", () => {
    expect(
      buildCapabilityCandidates({
        text: "幫我儲存資料",
        enabledFunctions: ["query_schedule"],
        source: "group",
        knowledgeSources: [],
        retrievalEvidence: ["query_schedule"],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it.each(["你好", "你好嗎", "在嗎", "辛苦嗎", "你是內向的人嗎", "加油", "說個笑話哈哈"])(
    "applies one conservative guard to every non-explicit knowledge evidence path: %s",
    (text) => {
      const definition = getFunctionDefinition("query_knowledge")!;
      const originalHints = definition.agentCapability!.candidateHints;
      definition.agentCapability!.candidateHints = [text];
      const activeTask: ActiveTaskContext = {
        ...knowledgeTask,
        entities: [{ type: "section", key: text, label: text }]
      };
      try {
        expect(
          buildCapabilityCandidates({
            text,
            enabledFunctions: ["query_knowledge"],
            activeTask,
            source: "group",
            knowledgeSources: [{ ...retreatKnowledge, topics: [text] }],
            retrievalEvidence: ["query_knowledge"],
            maxCandidates: 3
          })
        ).toEqual([]);
      } finally {
        definition.agentCapability!.candidateHints = originalHints;
      }
    }
  );

  it.each([
    "幫我把第一日儲存起來",
    "幫我把第一日存下來",
    "請將第一日新增到知識",
    "請你幫我儲存第一日",
    "麻煩幫我刪除第一日",
    "可以幫我新增嗎",
    "能不能替我更新第一日安排"
  ])("does not turn rearranged write intent into a knowledge read candidate: %s", (text) => {
    expect(
      buildCapabilityCandidates({
        text,
        enabledFunctions: ["query_knowledge"],
        activeTask: {
          ...knowledgeTask,
          entities: [{ type: "section", key: "day-one", label: "第一日" }]
        },
        source: "group",
        knowledgeSources: [{ ...retreatKnowledge, topics: ["第一日"] }],
        retrievalEvidence: ["query_knowledge"],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("keeps explicit knowledge intent and ordinary knowledge questions eligible", () => {
    expect(
      buildCapabilityCandidates({
        text: "查知識 你好",
        enabledFunctions: ["query_knowledge"],
        source: "group",
        knowledgeSources: [{ ...retreatKnowledge, topics: ["你好"] }],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_knowledge", reason: "explicit_intent" });
    expect(
      buildCapabilityCandidates({
        text: "第一日要去哪裡",
        enabledFunctions: ["query_knowledge"],
        source: "group",
        knowledgeSources: [{ ...retreatKnowledge, topics: ["第一日"] }],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_knowledge", reason: "knowledge_metadata" });
    expect(
      buildCapabilityCandidates({
        text: "請問如何新增成員",
        enabledFunctions: ["query_knowledge"],
        source: "group",
        knowledgeSources: [{ ...retreatKnowledge, topics: ["新增成員"] }],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_knowledge", reason: "knowledge_metadata" });
  });

  it("returns an enabled write capability only from explicit write intent", () => {
    expect(
      buildCapabilityCandidates({
        text: "幫我保存服事表：7/14 晨更音控是資恆",
        enabledFunctions: ["save_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([
      expect.objectContaining({ capability: "save_schedule", reason: "explicit_intent" })
    ]);

    expect(
      buildCapabilityCandidates({
        text: "這份服事表是 7/14 晨更音控資恆",
        enabledFunctions: ["save_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it.each(["幫我記服事表", "記服事表", "小哈幫我記服事表"])(
    "recognizes a capability-scoped shorthand write request: %s",
    (text) => {
      expect(
        buildCapabilityCandidates({
          text,
          enabledFunctions: ["query_schedule", "save_schedule"],
          source: "group",
          knowledgeSources: [],
          maxCandidates: 3
        })
      ).toEqual([
        expect.objectContaining({ capability: "save_schedule", reason: "explicit_intent" })
      ]);
    }
  );

  it("does not treat a question about remembering as a schedule write", () => {
    expect(
      buildCapabilityCandidates({
        text: "你記得剛剛那份服事表嗎",
        enabledFunctions: ["query_schedule", "save_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      }).some(({ capability }) => capability === "save_schedule")
    ).toBe(false);
  });

  it.each(["不要記服事表", "幫我不要記服事表", "先別保存服事表"])(
    "does not nominate a negated write request: %s",
    (text) => {
      expect(
        buildCapabilityCandidates({
          text,
          enabledFunctions: ["query_schedule", "save_schedule"],
          source: "group",
          knowledgeSources: [],
          maxCandidates: 3
        }).some(({ capability }) => capability === "save_schedule")
      ).toBe(false);
    }
  );

  it("routes explicit short-lived text memory writes without inferring them from hints", () => {
    expect(
      buildCapabilityCandidates({
        text: "幫我記住集合時間是下午兩點半",
        enabledFunctions: ["save_memory"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([expect.objectContaining({ capability: "save_memory", reason: "explicit_intent" })]);

    expect(
      buildCapabilityCandidates({
        text: "集合時間是下午兩點半",
        enabledFunctions: ["save_memory"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });

  it("prefers a domain write over generic text memory for a pasted service schedule", () => {
    expect(
      buildCapabilityCandidates({
        text: "幫我記住這份晨更服事表：七/17五世緯家園",
        enabledFunctions: ["save_schedule", "save_memory", "retrieve_memory"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["save_schedule"]);
  });

  it("recognizes positive and one-edit typo hints deterministically", () => {
    expect(
      buildCapabilityCandidates({
        text: "小哈 查投影片 主日報告",
        enabledFunctions: ["find_ppt_slides"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "find_ppt_slides", reason: "explicit_intent" });

    expect(
      buildCapabilityCandidates({
        text: "小哈 找投影篇 主日報告",
        enabledFunctions: ["find_ppt_slides"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "find_ppt_slides", reason: "capability_hint" });
  });

  it("matches an exact short SOP token", () => {
    expect(
      buildCapabilityCandidates({
        text: "請查 SOP",
        enabledFunctions: ["query_knowledge"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })[0]
    ).toMatchObject({ capability: "query_knowledge", reason: "capability_hint" });
  });

  it.each(["Open the report", "This is sophisticated reporting"])(
    "does not match short hints inside unrelated English: %s",
    (text) => {
      expect(
        buildCapabilityCandidates({
          text,
          enabledFunctions: ["query_knowledge"],
          source: "group",
          knowledgeSources: [],
          maxCandidates: 3
        })
      ).toEqual([]);
    }
  );

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
        source: "group",
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
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["find_sheet_music"]);
  });

  it("recognizes a natural saved-file lookup without requiring the catalog title to match first", () => {
    expect(
      buildCapabilityCandidates({
        text: "我想查詢牧師師母五十週年檔案",
        enabledFunctions: ["find_resource", "save_resource"],
        source: "user",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([
      expect.objectContaining({ capability: "find_resource", reason: "capability_hint" })
    ]);
  });

  it("does not treat the role token inside 投影片 as schedule argument evidence", () => {
    expect(
      buildCapabilityCandidates({
        text: "查投影片 主日報告",
        enabledFunctions: ["find_ppt_slides", "query_schedule"],
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["find_ppt_slides"]);
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
      source: "group" as const,
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
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      }).map(({ capability }) => capability)
    ).toEqual(["query_knowledge"]);
  });

  it("rejects task-frame evidence for a capability outside the allowed handoff set", () => {
    expect(
      buildCapabilityCandidates({
        text: "第一天",
        enabledFunctions: ["query_knowledge"],
        activeTask: { ...knowledgeTask, allowedCapabilities: ["query_schedule"] },
        source: "group",
        knowledgeSources: [],
        maxCandidates: 3
      })
    ).toEqual([]);
  });
});

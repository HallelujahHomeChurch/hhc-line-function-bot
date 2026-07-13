import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import { guardSystemRouteWithFunctionIntent } from "../agent/function-intent-guard.js";
import { FUNCTION_DEFINITIONS, getFunctionDefinition } from "../functions/definitions.js";
import type { FunctionName } from "../types.js";

const eligibleReadDefinitions = FUNCTION_DEFINITIONS.filter(
  (definition) => definition.sideEffectLevel === "read" && !definition.deprecated
);

describe("controlled read capability contracts", () => {
  it("requires every eligible read to declare routing hints, an argument schema, and operations", () => {
    expect(eligibleReadDefinitions.length).toBeGreaterThan(0);
    for (const definition of eligibleReadDefinitions) {
      expect(definition.agentCapability, definition.name).toBeDefined();
      expect(definition.agentCapability?.candidateHints.length, definition.name).toBeGreaterThan(0);
      expect(typeof definition.argumentSchema.safeParse, definition.name).toBe("function");
      expect(Array.isArray(definition.agentCapability?.operations), definition.name).toBe(true);
      if ((definition.agentCapability?.operations.length ?? 0) > 0) {
        expect(definition.continuation, definition.name).toBeDefined();
      }
    }
  });

  it("keeps one-shot and selection-session reads out of active-task continuation", () => {
    for (const name of [
      "find_ppt_slides",
      "find_sheet_music",
      "find_resource",
      "query_wikipedia",
      "retrieve_memory"
    ] as FunctionName[]) {
      expect(getFunctionDefinition(name)?.agentCapability?.operations, name).toEqual([]);
    }
    expect(getFunctionDefinition("query_schedule")?.agentCapability?.operations).toEqual([
      "continue",
      "refine",
      "advance",
      "select"
    ]);
    expect(getFunctionDefinition("query_knowledge")?.agentCapability?.operations).toEqual([
      "continue",
      "refine",
      "select"
    ]);
  });

  it.each([
    ["find_ppt_slides", "查投影片 奇異恩典"],
    ["find_sheet_music", "查歌譜 Yesterday"],
    ["find_resource", "查教會資料 週報音檔"],
    ["query_wikipedia", "查維基百科 馬丁路德"],
    ["query_schedule", "查服事表 主日"],
    ["query_knowledge", "查知識 聚會復原流程"]
  ] as Array<[FunctionName, string]>)(
    "builds a declarative candidate for %s",
    (capability, text) => {
      const candidates = buildCapabilityCandidates({
        text,
        enabledFunctions: [capability],
        knowledgeSources: [],
        maxCandidates: 3,
        source: "user"
      });
      expect(candidates).toEqual([
        expect.objectContaining({ capability, reason: "explicit_intent" })
      ]);
    }
  );

  it("never returns a disabled read candidate", () => {
    expect(
      buildCapabilityCandidates({
        text: "查投影片 奇異恩典",
        enabledFunctions: ["query_wikipedia"],
        knowledgeSources: [],
        maxCandidates: 3,
        source: "user"
      })
    ).toEqual([]);
  });

  it("keeps broad read hints on the original small-talk route", () => {
    expect(
      guardSystemRouteWithFunctionIntent(
        {
          type: "respond",
          action: "introduce_bot",
          arguments: {},
          provider: "ollama"
        },
        "流程",
        ["query_knowledge"]
      )
    ).toEqual({
      type: "respond",
      action: "introduce_bot",
      arguments: {},
      provider: "ollama"
    });

    expect(
      guardSystemRouteWithFunctionIntent(
        {
          type: "respond",
          action: "small_talk",
          arguments: {},
          provider: "deepseek"
        },
        "文件",
        ["find_resource"]
      )
    ).toEqual({
      type: "respond",
      action: "small_talk",
      arguments: {},
      provider: "deepseek"
    });
  });

  it.each(["下一場服事表", "本週聚會服事"])(
    "preserves the declarative legacy schedule recovery for %s",
    (text) => {
      expect(
        guardSystemRouteWithFunctionIntent(
          {
            type: "respond",
            action: "small_talk",
            arguments: {},
            provider: "ollama"
          },
          text,
          ["query_schedule"]
        )
      ).toMatchObject({
        type: "execute",
        action: "query_schedule",
        arguments: { query: text }
      });
    }
  );

  it("declares every emitted result entity type in its capability contract", () => {
    const emittedTypes = new Map<FunctionName, string[]>([
      ["find_ppt_slides", ["resource"]],
      ["find_sheet_music", ["resource"]],
      ["find_resource", ["resource"]],
      ["query_wikipedia", ["topic"]],
      ["retrieve_memory", ["memory"]]
    ]);

    for (const [name, types] of emittedTypes) {
      expect(getFunctionDefinition(name)?.agentCapability?.entityTypes, name).toEqual(
        expect.arrayContaining(types)
      );
    }

    for (const name of ["find_ppt_slides", "find_sheet_music", "find_resource"] as FunctionName[]) {
      expect(getFunctionDefinition(name)?.agentCapability?.entityTypes, name).not.toContain(
        "selection"
      );
    }
  });

  it("keeps top-level continuation plumbing free of function-specific read branches", () => {
    const continuation = readFileSync(
      new URL("../agent/function-continuation.ts", import.meta.url),
      "utf8"
    );
    const intentGuard = readFileSync(
      new URL("../agent/function-intent-guard.ts", import.meta.url),
      "utf8"
    );
    const runtime = readFileSync(new URL("../agent/turn-runtime.ts", import.meta.url), "utf8");

    expect(continuation).not.toMatch(/schedule-query-refinement|query_schedule/u);
    expect(intentGuard).not.toMatch(/schedule-query-refinement|query_schedule/u);
    expect(runtime).not.toMatch(/route\.action\s*===\s*["']query_(?:schedule|knowledge)["']/u);
  });
});

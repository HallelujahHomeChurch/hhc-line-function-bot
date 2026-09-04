import { CAPABILITY_NAMES } from "../capabilities/names.js";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CATALOG,
  getFunctionDefinition,
  isFunctionGrantableForPrincipal
} from "../capabilities/catalog.js";

describe("function definitions", () => {
  it("defines every function name in one catalog", () => {
    expect(CAPABILITY_CATALOG.map((definition) => definition.name).sort()).toEqual(
      [...CAPABILITY_NAMES].sort()
    );
  });

  it("exposes Wikipedia lookup as a first-class read capability", () => {
    expect(CAPABILITY_NAMES).toContain("query_wikipedia");
  });

  it("defines Weekly Paper download as a stateless profile read", () => {
    const definition = getFunctionDefinition("download_weekly_paper" as never);

    expect(CAPABILITY_NAMES).toContain("download_weekly_paper");
    expect(definition).toMatchObject({
      name: "download_weekly_paper",
      requires: ["hhc_web_api"],
      scope: "profile",
      sideEffectLevel: "read",
      allowedSources: ["user"],
      requiredSlots: [],
      resourcePolicy: { kind: "none", remember: false, alias: false },
      memoryPolicy: { kind: "none" },
      agentCapability: {
        operations: []
      }
    });
    expect(definition?.argumentSchema.safeParse({ issueNumber: 1 }).success).toBe(true);
    expect(definition?.argumentSchema.safeParse({ issueNumber: 2_147_483_647 }).success).toBe(true);
    expect(definition?.argumentSchema.safeParse({ issueNumber: 0 }).success).toBe(false);
    expect(definition?.argumentSchema.safeParse({ issueNumber: 2_147_483_648 }).success).toBe(
      false
    );
  });

  it("uses find_sheet_music as the canonical sheet music function", () => {
    expect(CAPABILITY_NAMES).toContain("find_sheet_music");
    expect(getFunctionDefinition("find_sheet_music")).toMatchObject({
      name: "find_sheet_music",
      sideEffectLevel: "read",
      resourcePolicy: {
        kind: "graph_file",
        resourceTypes: ["sheet_music"]
      }
    });
  });

  it("uses one declarative generic-slot contract for user-facing lookups", () => {
    const lookupNames = [
      "find_ppt_slides",
      "find_sheet_music",
      "query_wikipedia",
      "retrieve_memory"
    ] as const;

    for (const name of lookupNames) {
      const slot = getFunctionDefinition(name)?.requiredSlots[0];
      expect(slot?.missingWhen).toBe("blank");
      expect(slot?.genericRequest?.phrases.length).toBeGreaterThan(0);
    }
    expect(getFunctionDefinition("query_schedule")?.requiredSlots).toEqual([]);
  });

  it("carries agent capability and quick reply metadata for sheet music", () => {
    const definition = getFunctionDefinition("find_sheet_music");

    expect(definition).toMatchObject({
      name: "find_sheet_music",
      quickReply: {
        label: "查歌譜",
        command: "小哈 查歌譜"
      }
    });
    expect(definition?.shortDescription).toContain("歌譜");
    expect(definition?.agentCapability?.semanticDescription).toContain("歌譜");
  });

  it("keeps shared write functions user-grant-only", () => {
    for (const name of ["save_schedule", "save_memory"] as const) {
      expect(isFunctionGrantableForPrincipal(name, "user")).toBe(true);
      expect(isFunctionGrantableForPrincipal(name, "group")).toBe(false);
    }
    expect(isFunctionGrantableForPrincipal("find_ppt_slides", "group")).toBe(true);
  });

  it("describes save_resource through the attachment intake users actually perform", () => {
    const definition = getFunctionDefinition("save_resource");
    const activationSlot = definition?.requiredSlots.find((slot) => slot.argument === "url");

    expect(definition).toMatchObject({
      displayName: "保存檔案",
      quickReply: {
        label: "保存檔案",
        command: "小哈我要上傳檔案"
      }
    });
    expect(definition?.examples).toEqual(
      expect.arrayContaining(["小哈我要上傳檔案", "小哈幫我存檔案"])
    );
    expect(definition?.shortDescription).toMatch(/上傳.*用途.*名稱.*確認.*掃毒.*發布/u);
    expect(definition?.helpText).toMatch(/上傳.*用途.*名稱.*預覽.*確認.*掃毒.*發布/u);
    expect(definition?.helpText).not.toMatch(/HTTPS|OneDrive/u);
    expect(activationSlot?.genericRequest).toMatchObject({
      phrases: expect.arrayContaining(["小哈我要上傳檔案", "小哈幫我存檔案"]),
      clearArguments: expect.arrayContaining(["url", "resourceType", "title"])
    });
    expect(activationSlot?.prompt).toContain("上傳");
    expect(definition?.clarificationPrompt).toMatch(/上傳/u);
  });
});

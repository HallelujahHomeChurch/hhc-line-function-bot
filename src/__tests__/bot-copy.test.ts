import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getFunctionDefinition } from "../functions/definitions.js";

describe("bot-authored copy", () => {
  it("instructs the production helper persona to use first-person self-reference", () => {
    const profiles = JSON.parse(
      readFileSync(new URL("../../config/profiles.json", import.meta.url), "utf8")
    ) as Array<{ smallTalk?: { prompting?: { conversationRulesPrompt?: string } } }>;
    const rules = profiles[0]?.smallTalk?.prompting?.conversationRulesPrompt ?? "";

    expect(rules).toContain("自稱使用「我」");
    expect(rules).toContain("不要用「小哈」第三人稱稱呼自己");
  });

  it("uses first-person wording in memory function descriptions", () => {
    const saveMemory = getFunctionDefinition("save_memory");
    const retrieveMemory = getFunctionDefinition("retrieve_memory");

    expect(saveMemory?.shortDescription).toContain("請我記住");
    expect(saveMemory?.helpText).toContain("交代我記住");
    expect(retrieveMemory?.shortDescription).toContain("請我記住");
  });
});

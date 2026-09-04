import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getFunctionDefinition } from "../functions/definitions.js";

describe("bot-authored copy", () => {
  it("instructs the production helper persona to use first-person self-reference", () => {
    const profiles = JSON.parse(
      readFileSync(new URL("../../config/profiles.json", import.meta.url), "utf8")
    ) as Array<{ name: string; agent?: { personaFile?: string } }>;
    const personaFile = profiles.find(({ name }) => name === "helper")?.agent?.personaFile;
    expect(personaFile).toBe("agents/helper/PERSONA.md");
    const rules = readFileSync(new URL(`../../config/${personaFile}`, import.meta.url), "utf8");

    expect(rules).toContain("自稱「我」");
    expect(rules).toContain("不要用第三人稱稱呼自己");
  });

  it("uses first-person wording in memory function descriptions", () => {
    const saveMemory = getFunctionDefinition("save_memory");
    const retrieveMemory = getFunctionDefinition("retrieve_memory");

    expect(saveMemory?.shortDescription).toContain("請我記住");
    expect(saveMemory?.helpText).toContain("交代我記住");
    expect(retrieveMemory?.shortDescription).toContain("請我記住");
  });
});

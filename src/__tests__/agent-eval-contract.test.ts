import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("final helper evaluator contract", () => {
  it("drives runtime review and consent boundaries through one shared fixture", async () => {
    const source = await readFile("src/tools/eval-sdk-agent.ts", "utf8");

    expect(source).toContain("createSyntheticRuntimeFixture");
    expect(source).toContain("runtime.handleActionReview");
    expect(source).toContain("runtime.acceptSheetMusicResearch");
    expect(source).toContain("createQueryScheduleHandler");
    expect(source).not.toContain("new Command");
    expect(source).not.toContain("consented: true");
    expect(source).not.toMatch(/return \{ modelCalls: \d/u);
  });
});

import { describe, expect, it } from "vitest";

import { evaluateForcedDeepSeekUnavailable } from "../tools/eval-agent-planner-live.js";

describe("live agent planner unavailable-provider probe", () => {
  it("reports a single unavailable DeepSeek attempt without invoking a second model", async () => {
    await expect(evaluateForcedDeepSeekUnavailable("helper")).resolves.toEqual({
      provider: "deepseek",
      primaryStatus: "unavailable",
      status: "no_plan",
      reasonCode: "providers_unavailable",
      attempts: 1
    });
  });
});

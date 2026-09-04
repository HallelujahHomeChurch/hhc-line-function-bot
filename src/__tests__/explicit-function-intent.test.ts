import { describe, expect, it } from "vitest";

import { isExplicitFunctionSwitch } from "../functions/explicit-function-intent.js";

describe("explicit pending-function switches", () => {
  it("recognizes a different enabled function without semantic routing", () => {
    expect(
      isExplicitFunctionSwitch("小哈 查投影片 主日報告", "save_memory", [
        "save_memory",
        "find_ppt_slides"
      ])
    ).toBe(true);
    expect(
      isExplicitFunctionSwitch("主日報告", "save_memory", ["save_memory", "find_ppt_slides"])
    ).toBe(false);
  });
});

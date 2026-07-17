import { describe, expect, it } from "vitest";

import { projectRetrievalQuery } from "../agent/retrieval-query.js";
import { getFunctionDefinition } from "../functions/definitions.js";

describe("retrieval query projection", () => {
  it("removes conversational wrappers while preserving the resource identity", () => {
    expect(
      projectRetrievalQuery({
        text: "小哈，我想查詢牧師師母 50 週年檔案",
        definition: getFunctionDefinition("find_resource")!
      })
    ).toBe("牧師師母 50 週年");
  });

  it("uses capability-declared vocabulary instead of a resource-specific branch", () => {
    expect(
      projectRetrievalQuery({
        text: "請幫我找奇異恩典的投影片",
        definition: getFunctionDefinition("find_ppt_slides")!
      })
    ).toBe("奇異恩典");
  });

  it("does not erase a title that only happens to contain a short hint", () => {
    expect(
      projectRetrievalQuery({
        text: "查小哈資料庫 奔跑不放棄",
        definition: getFunctionDefinition("find_resource")!
      })
    ).toBe("奔跑不放棄");
  });
});

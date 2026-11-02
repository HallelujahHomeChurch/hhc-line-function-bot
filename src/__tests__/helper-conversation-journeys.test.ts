import { describe, expect, it } from "vitest";
import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";

// These probe transport/context cost, not the quality of the fake model's prose.
const journeys = [
  ["explain", "用簡單例子解釋時間管理", "改用學生的例子"],
  ["compare", "比較我提供的方案：甲便宜，乙較快", "以時間優先再比較"],
  ["plan", "小哈，規劃六人的室內活動，總長一小時", "小哈，保留六人條件，改成半小時"],
  ["write", "寫一份週六下午的活動通知", "保留時間，改得親切一點"],
  ["translate", "把這句翻譯成英文：謝謝你的幫助", "再正式一點"],
  ["organize", "小哈，整理我提供的事項：備餐、佈置、接待", "小哈，將接待排第一"]
] as const;

describe("P0/P1 conversation contract journeys", () => {
  it.each(journeys)(
    "%s retains supplied context with no extra tool/classifier calls",
    async (id, first, next) => {
      const probe = createEvalProbe();
      const source =
        id === "plan" || id === "organize"
          ? { type: "group" as const, groupId: "synthetic-group", userId: "synthetic-member" }
          : { type: "user" as const, userId: "synthetic-member" };
      const app = createSyntheticRuntimeFixture({
        probe,
        model: instrumentedFakeModel([[], []], probe),
        enabledFunctions: [],
        source,
        useCheckedInPolicy: true
      });
      expect((await app.runtime.handleTextTurn(app.turn(first)))?.ok).toBe(true);
      expect((await app.runtime.handleTextTurn(app.turn(next)))?.ok).toBe(true);
      expect(probe.values()).toMatchObject({ modelCalls: 2, toolCalls: 0 });
      expect(JSON.stringify(probe.inputs[1])).toContain(first);
      expect(JSON.stringify(probe.inputs[1])).toContain(next);
      expect(
        await app.sessions.findActionReview({
          profileName: "helper",
          source,
          requesterUserId: source.userId
        })
      ).toBeUndefined();
    }
  );
});

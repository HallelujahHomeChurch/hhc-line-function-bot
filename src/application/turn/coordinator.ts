import type { TurnStage, TurnStageName, TurnStageResult } from "./contracts.js";

const STAGE_ORDER: Record<TurnStageName, number> = {
  text_continuation: 10,
  capability_resolution: 20,
  admin_action: 30,
  controlled_plan: 40,
  function_execution: 50
};

export async function runTurnStages<Context, Result>(
  stages: TurnStage<Context, Result>[],
  context: Context
): Promise<TurnStageResult<Result>> {
  const ordered = [...stages].sort(
    (left, right) => STAGE_ORDER[left.name] - STAGE_ORDER[right.name]
  );
  for (const stage of ordered) {
    const result = await stage.run(context);
    if (result.kind === "handled") {
      return result;
    }
  }
  return { kind: "continue" };
}

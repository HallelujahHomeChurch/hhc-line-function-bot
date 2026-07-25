export type TurnStageName =
  | "text_continuation"
  | "capability_resolution"
  | "admin_action"
  | "controlled_plan"
  | "function_execution";

export type TurnStageResult<Result> = { kind: "continue" } | { kind: "handled"; result: Result };

export interface TurnStage<Context, Result> {
  name: TurnStageName;
  run(context: Context): Promise<TurnStageResult<Result>>;
}

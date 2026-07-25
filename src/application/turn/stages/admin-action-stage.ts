import type { FunctionExecutionResult } from "../../../types.js";

export async function runAdminActionStage(
  execute: () => Promise<FunctionExecutionResult | undefined>
): Promise<{ kind: "continue" } | { kind: "handled"; result: FunctionExecutionResult }> {
  const result = await execute();
  return result ? { kind: "handled", result } : { kind: "continue" };
}

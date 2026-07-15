import type { FunctionName } from "../types.js";

export type ArgumentAuthority =
  "current_text" | "explicit_current_text" | "model_grounded" | "active_task_only";

export const FUNCTION_ARGUMENT_AUTHORITY: Partial<
  Record<FunctionName, Record<string, ArgumentAuthority>>
> = {
  find_ppt_slides: {
    query: "current_text",
    fileType: "explicit_current_text",
    matchMode: "model_grounded"
  },
  find_sheet_music: {
    query: "current_text",
    artist: "explicit_current_text",
    fileType: "explicit_current_text",
    matchMode: "model_grounded"
  },
  query_schedule: {
    query: "current_text",
    date: "model_grounded",
    specificDate: "model_grounded",
    dateIntent: "model_grounded",
    meeting: "model_grounded",
    role: "model_grounded",
    month: "model_grounded",
    participant: "model_grounded",
    domainKey: "active_task_only"
  },
  save_schedule: {
    content: "explicit_current_text",
    title: "explicit_current_text",
    confirm: "active_task_only"
  },
  save_resource: {
    url: "explicit_current_text",
    title: "explicit_current_text",
    confirm: "active_task_only"
  }
};

export function argumentGroundingCounts(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { groundedFieldCount: number; droppedFieldCount: number } {
  const beforeKeys = Object.keys(before).filter((key) => before[key] !== undefined);
  const afterKeys = new Set(Object.keys(after).filter((key) => after[key] !== undefined));
  return {
    groundedFieldCount: afterKeys.size,
    droppedFieldCount: beforeKeys.filter((key) => !afterKeys.has(key)).length
  };
}

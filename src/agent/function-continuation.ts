import { getFunctionDefinition } from "../functions/definitions.js";
import { refineScheduleQuery } from "../functions/schedule-query-refinement.js";
import type { QueryScheduleArguments } from "../function-arguments.js";
import type { FunctionName, JsonRecord } from "../types.js";
import type { FunctionContinuationContext } from "./context-manager.js";

export function mergeFunctionContinuationArguments(input: {
  action: FunctionName;
  currentArguments: JsonRecord;
  currentText?: string;
  now?: Date;
  timeZone?: string;
  continuation: FunctionContinuationContext | undefined;
}): JsonRecord {
  if (!input.continuation || input.continuation.functionName !== input.action) {
    return input.currentArguments;
  }
  const policy = getFunctionDefinition(input.action)?.continuation;
  if (!policy) {
    return input.currentArguments;
  }

  const prepared = prepareCurrentArguments(input);
  const blocked = new Set<string>();
  for (const group of policy.exclusiveGroups ?? []) {
    if (group.some((argument) => hasValue(prepared.arguments[argument]))) {
      for (const argument of group) blocked.add(argument);
    }
  }
  for (const argument of prepared.changedArguments) blocked.add(argument);

  const carried: JsonRecord = {};
  for (const argument of policy.carryArguments) {
    const value = input.continuation.arguments[argument];
    if (!blocked.has(argument) && !hasValue(prepared.arguments[argument]) && hasValue(value)) {
      carried[argument] = value;
    }
  }
  return { ...carried, ...prepared.arguments };
}

function prepareCurrentArguments(input: {
  action: FunctionName;
  currentArguments: JsonRecord;
  currentText?: string;
  now?: Date;
  timeZone?: string;
}): { arguments: JsonRecord; changedArguments: Set<string> } {
  if (input.action !== "query_schedule") {
    return { arguments: input.currentArguments, changedArguments: new Set() };
  }
  const query =
    typeof input.currentArguments.query === "string"
      ? input.currentArguments.query
      : (input.currentText ?? "");
  const refinement = refineScheduleQuery(
    { ...input.currentArguments, query } as QueryScheduleArguments,
    input.now ?? new Date(),
    input.timeZone ?? "Asia/Taipei"
  );
  const changedArguments = new Set<string>();
  const focus = refinement.residualQuery
    .replace(/^(?:那|那個|再)?/u, "")
    .replace(/呢$/u, "")
    .trim();
  if (!hasValue(refinement.structuredArguments.role) && focus) {
    changedArguments.add("role");
  }
  const structuredArguments = Object.fromEntries(
    Object.entries(refinement.structuredArguments).filter(([, value]) => value !== undefined)
  );
  return {
    arguments: { ...input.currentArguments, ...structuredArguments, query },
    changedArguments
  };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

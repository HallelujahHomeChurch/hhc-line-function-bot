import type { FunctionName, JsonRecord, RouteResult } from "../types.js";
import type { QueryScheduleArguments } from "../function-arguments.js";
import {
  extractScheduleRoleFocus,
  refineScheduleQuery
} from "../functions/schedule-query-refinement.js";
import type { FunctionContinuationContext } from "./context-manager.js";

export function guardSystemRouteWithFunctionIntent(
  route: RouteResult,
  text: string,
  enabledFunctions: FunctionName[],
  continuation?: FunctionContinuationContext
): RouteResult {
  const continuationIntent = detectContinuationIntent(route, text, enabledFunctions, continuation);
  if (continuationIntent) {
    return {
      type: "execute",
      action: continuationIntent.action,
      arguments: continuationIntent.arguments,
      provider: "keyword",
      fallbackProvider:
        route.provider === "ollama" || route.provider === "deepseek" ? route.provider : undefined,
      fallbackReason: "active_function_continuation"
    };
  }

  if (route.type !== "respond") {
    return route;
  }

  const scheduleIntent = detectServiceScheduleIntent(text, enabledFunctions);
  if (!scheduleIntent) {
    return route;
  }

  return {
    type: "execute",
    action: scheduleIntent.action,
    arguments: scheduleIntent.arguments,
    provider: "keyword",
    fallbackProvider:
      route.provider === "ollama" || route.provider === "deepseek" ? route.provider : undefined,
    fallbackReason: `system_route_${route.action}`
  };
}

function detectContinuationIntent(
  route: RouteResult,
  text: string,
  enabledFunctions: FunctionName[],
  continuation: FunctionContinuationContext | undefined
): { action: FunctionName; arguments: JsonRecord } | undefined {
  if (!continuation || !enabledFunctions.includes(continuation.functionName)) return undefined;
  if (route.type === "execute") return undefined;
  if (route.type === "respond" && route.action !== "small_talk") return undefined;
  if (continuation.functionName !== "query_schedule") return undefined;
  const refinement = refineScheduleQuery(
    { query: text } as QueryScheduleArguments,
    new Date(),
    "Asia/Taipei"
  );
  const role = extractScheduleRoleFocus({
    query: text,
    hasContinuation: true,
    availableRoles: continuationRoles(continuation.arguments)
  });
  const arguments_ = Object.fromEntries(
    Object.entries(refinement.structuredArguments).filter(([, value]) => value !== undefined)
  );
  if (role) arguments_.role = role;
  return Object.keys(arguments_).length > 0
    ? { action: "query_schedule", arguments: { query: text.trim(), ...arguments_ } }
    : undefined;
}

function continuationRoles(arguments_: JsonRecord): string[] | undefined {
  const roles = arguments_.availableRoles;
  return Array.isArray(roles) && roles.every((role) => typeof role === "string")
    ? roles
    : undefined;
}

function detectServiceScheduleIntent(
  text: string,
  enabledFunctions: FunctionName[]
): { action: FunctionName; arguments: JsonRecord } | undefined {
  const action = enabledFunctions.includes("query_schedule")
    ? "query_schedule"
    : enabledFunctions.includes("query_service_schedule")
      ? "query_service_schedule"
      : undefined;
  if (!action) {
    return undefined;
  }

  const normalized = text.normalize("NFKC").replace(/\s+/g, "");
  const hasScheduleWord = /服事|聚會/u.test(normalized);
  if (!hasScheduleWord) {
    return undefined;
  }

  const args: JsonRecord = { query: text.trim() };
  if (/(下一場|下場|最近一場|下一次|下次)/u.test(normalized)) {
    args.dateIntent = "next_meeting";
    return { action, arguments: args };
  }
  if (/(這週|這周|本週|本周|这周|这週)/u.test(normalized)) {
    args.dateIntent = "this_week";
    return { action, arguments: args };
  }
  if (/今天/u.test(normalized)) {
    args.dateIntent = "today";
    return { action, arguments: args };
  }
  if (/明天/u.test(normalized)) {
    args.dateIntent = "tomorrow";
    return { action, arguments: args };
  }
  if (/後天|后天/u.test(normalized)) {
    args.dateIntent = "day_after_tomorrow";
    return { action, arguments: args };
  }
  if (/主日|晨更|門訓|國度禱告|福音餐會|仙履奇緣/u.test(normalized)) {
    return { action, arguments: args };
  }
  if (/服事表|聚會服事/u.test(normalized)) {
    return { action, arguments: args };
  }
  return undefined;
}

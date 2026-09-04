import { createHash } from "node:crypto";

import {
  saveMemoryAgentArgumentsSchema,
  saveResourceAgentArgumentsSchema,
  saveScheduleAgentArgumentsSchema,
  updateOwnProfileReviewArgumentsSchema
} from "../function-arguments.js";
import type { ActionReviewSession, HelperWriteToolName } from "../state/session-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord,
  LineSource
} from "../types.js";
import { DEFAULT_SCHEDULE_DOMAINS, resolveScheduleDomain } from "../schedules/domain-registry.js";
import { getFunctionDefinition } from "../functions/definitions.js";

const actions = {
  propose_save_schedule: {
    capability: "save_schedule",
    schema: saveScheduleAgentArgumentsSchema
  },
  propose_save_memory: {
    capability: "save_memory",
    schema: saveMemoryAgentArgumentsSchema
  },
  propose_save_resource: {
    capability: "save_resource",
    schema: saveResourceAgentArgumentsSchema
  },
  update_own_profile: {
    capability: "update_own_profile",
    schema: updateOwnProfileReviewArgumentsSchema
  }
} as const satisfies Record<
  HelperWriteToolName,
  {
    capability: FunctionName;
    schema: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  }
>;

export interface ActionExecutorOptions {
  handlers: FunctionRegistry;
  authorize(name: FunctionName, context: FunctionHandlerContext): Promise<boolean>;
  currentPolicyKey(context: FunctionHandlerContext): Promise<string> | string;
}

export interface ExecuteActionInput {
  review: ActionReviewSession;
  arguments: JsonRecord;
  context: FunctionHandlerContext;
}

export type ActionExecution =
  | { status: "approved"; result: FunctionExecutionResult }
  | { status: "denied"; result?: FunctionExecutionResult }
  | { status: "unavailable" };

export function createActionExecutor(options: ActionExecutorOptions) {
  return {
    prepare(toolName: string, args: JsonRecord, context: FunctionHandlerContext): JsonRecord {
      if (toolName !== "propose_save_schedule") return args;
      const parsed = saveScheduleAgentArgumentsSchema.safeParse(args);
      if (!parsed.success) return args;
      const domains = context.profile.schedulePolicy?.domains ?? DEFAULT_SCHEDULE_DOMAINS;
      const requestedDomainKey =
        parsed.data.domainKey ??
        (parsed.data.scheduleType
          ? domains.find(
              (domain) =>
                domain.binding.kind === "saved_schedule" &&
                domain.binding.scheduleType === parsed.data.scheduleType
            )?.key
          : undefined);
      const resolution = resolveScheduleDomain({
        domains,
        requestedDomainKey,
        text: [parsed.data.query, parsed.data.title, parsed.data.content].filter(Boolean).join("\n")
      });
      const selected =
        resolution.status === "selected"
          ? domains.find(({ key }) => key === resolution.candidate.domainKey)
          : resolution.status === "not_found"
            ? domains.find(({ key }) => key === "custom_service_schedule")
            : undefined;
      return selected
        ? {
            ...parsed.data,
            domainKey: selected.key,
            domainRevision: selected.revision,
            ...(selected.binding.kind === "saved_schedule"
              ? { scheduleType: selected.binding.scheduleType }
              : {})
          }
        : (parsed.data as JsonRecord);
    },

    async preview(
      toolName: HelperWriteToolName,
      args: JsonRecord,
      context: FunctionHandlerContext
    ): Promise<FunctionExecutionResult | undefined> {
      const action = actionFor(toolName);
      if (!action || !actionAllowed(action.capability, context)) return undefined;
      const parsed = action.schema.safeParse(args);
      if (!parsed.success) return undefined;
      if (!(await options.authorize(action.capability, context))) return undefined;
      const result = await options.handlers[action.capability]?.(parsed.data as JsonRecord, {
        ...context,
        agentTool: true
      });
      return result?.writePhase === "preview" ? result : undefined;
    },

    async execute(input: ExecuteActionInput): Promise<ActionExecution> {
      const action = actionFor(input.review.toolName);
      if (
        !action ||
        !actionAllowed(action.capability, input.context) ||
        input.review.profileName !== input.context.profile.name ||
        !sameSource(input.review.source, input.context.event.source) ||
        input.review.requesterUserId !== input.context.event.source.userId ||
        input.review.argumentsHash !== hashReviewArguments(input.arguments)
      ) {
        return { status: "denied" };
      }
      const parsed = action.schema.safeParse(input.arguments);
      if (!parsed.success) return { status: "denied" };
      if (input.review.toolName === "propose_save_schedule") {
        const schedule = saveScheduleAgentArgumentsSchema.safeParse(input.arguments);
        if (
          !schedule.success ||
          !schedule.data.domainKey ||
          !schedule.data.domainRevision ||
          input.context.profile.schedulePolicy?.domains?.find(
            ({ key }) => key === schedule.data.domainKey
          )?.revision !== schedule.data.domainRevision
        ) {
          return { status: "denied" };
        }
      }
      try {
        if (!(await options.authorize(action.capability, input.context))) {
          return { status: "denied" };
        }
        if (input.review.policyKey !== (await options.currentPolicyKey(input.context))) {
          return { status: "denied" };
        }
        const handler = options.handlers[action.capability];
        if (!handler || !input.review.interruptId) return { status: "unavailable" };
        const result = await handler(
          { ...(parsed.data as JsonRecord), confirm: true },
          {
            ...input.context,
            requestId: input.review.interruptId,
            agentTool: true
          }
        );
        return result.writePhase === "commit"
          ? { status: "approved", result }
          : { status: "denied", result };
      } catch {
        return { status: "unavailable" };
      }
    }
  };
}

export type ActionExecutor = ReturnType<typeof createActionExecutor>;

export function hashReviewArguments(args: JsonRecord): string {
  return createHash("sha256").update(stableJson(args)).digest("hex");
}

function actionFor(toolName: HelperWriteToolName) {
  return actions[toolName];
}

function sameSource(left: LineSource, right: LineSource): boolean {
  return (
    left.type === right.type &&
    left.userId === right.userId &&
    left.groupId === right.groupId &&
    left.roomId === right.roomId
  );
}

function actionAllowed(name: FunctionName, context: FunctionHandlerContext): boolean {
  const definition = getFunctionDefinition(name);
  if (!definition) return false;
  const source = context.event.source.type;
  return (
    definition.sideEffectLevel !== "read" &&
    context.profile.enabledFunctions.includes(name) &&
    (source === "user" || source === "group") &&
    definition.allowedSources.includes(source)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

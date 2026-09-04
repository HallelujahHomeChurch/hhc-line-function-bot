import type { CapabilityName } from "../capabilities/names.js";
import type { AgentMemoryStore } from "./memory-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  GraphDriveClient,
  JsonRecord
} from "../types.js";

export interface ResourceMemoryObserver {
  afterFunctionResult(input: {
    context: FunctionHandlerContext;
    action: CapabilityName;
    arguments: JsonRecord;
    result: FunctionExecutionResult;
  }): Promise<void>;
}

const RESOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createResourceMemoryObserver(options: {
  memoryStore: AgentMemoryStore;
  graph?: GraphDriveClient;
  now?: () => Date;
}): ResourceMemoryObserver {
  const now = options.now ?? (() => new Date());
  return {
    async afterFunctionResult(input) {
      if (!input.result.ok || !input.result.agentResource) return;
      const reference = input.result.agentResource;
      await options.memoryStore.recordResource({
        profileName: input.context.profile.name,
        source: input.context.event.source,
        createdBy: input.context.event.source.userId,
        visibility: "private",
        resourceType: reference.resourceType,
        title: reference.title,
        query: reference.query ?? stringArgument(input.arguments, "query"),
        storage: reference.storage,
        sourceRevision: reference.sourceRevision,
        expiresAt: new Date(now().getTime() + RESOURCE_TTL_MS).toISOString()
      });
    }
  };
}

function stringArgument(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

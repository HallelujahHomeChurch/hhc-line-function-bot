import type {
  AgentResourceReference,
  AgentResourceType,
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionName,
  GraphDriveClient,
  JsonRecord
} from "../types.js";
import type { AgentMemoryStore, AgentResourceRecord } from "./memory-store.js";
import type { AccessStore } from "../access/types.js";

export interface AgentRuntimeOptions {
  memoryStore: AgentMemoryStore;
  graph?: GraphDriveClient;
  accessStore?: AccessStore;
  now?: () => Date;
}

export interface AfterFunctionResultInput {
  context: FunctionHandlerContext;
  action: FunctionName;
  arguments: JsonRecord;
  result: FunctionExecutionResult;
}

export interface BeforeFunctionExecutionInput {
  context: FunctionHandlerContext;
  action: FunctionName;
  arguments: JsonRecord;
}

export interface AgentCommandInput {
  text: string;
  context: FunctionHandlerContext;
  isAdmin: boolean;
}

export interface AgentRuntime {
  afterFunctionResult(input: AfterFunctionResultInput): Promise<void>;
  handleBeforeFunctionExecution(
    input: BeforeFunctionExecutionInput
  ): Promise<FunctionExecutionResult | undefined>;
  handleCommand(input: AgentCommandInput): Promise<FunctionExecutionResult | undefined>;
}

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const RESOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const now = options.now ?? (() => new Date());

  async function createResourceReply(
    resource: AgentResourceRecord
  ): Promise<FunctionExecutionResult> {
    if (resource.storage.provider === "external_link") {
      return {
        ok: true,
        replyText: ["這是我記住的：", resource.title, resource.storage.url].join("\n"),
        agentResource: toResourceReference(resource)
      };
    }
    if (!options.graph) {
      return {
        ok: true,
        replyText: "我記得剛剛那份，但目前沒有檔案連結服務，請稍後再試。"
      };
    }
    const link = await createGraphLink(options.graph, resource.storage, now());
    return {
      ok: true,
      replyText: ["這是剛剛那份：", resource.title, "下載連結（1 天內有效）：", link].join("\n"),
      agentResource: toResourceReference(resource)
    };
  }

  return {
    async afterFunctionResult(input) {
      if (!input.result.ok || !input.result.agentResource) {
        return;
      }
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
        expiresAt: new Date(now().getTime() + RESOURCE_TTL_MS).toISOString()
      });
    },

    async handleBeforeFunctionExecution(input) {
      const resourceTypes = resourceTypesForAction(input.action);
      const query = stringArgument(input.arguments, "query");
      if (!resourceTypes || !query) {
        return undefined;
      }
      const resource = await options.memoryStore.findResourceByAlias({
        profileName: input.context.profile.name,
        source: input.context.event.source,
        requesterUserId: input.context.event.source.userId,
        alias: query,
        resourceTypes
      });
      return resource ? createResourceReply(resource) : undefined;
    },

    async handleCommand(input) {
      const parsed = parseMemoryCommand(input.text);
      if (!parsed) {
        return undefined;
      }

      if (parsed.command === "memory-status") {
        if (!input.isAdmin) {
          return { ok: true, replyText: "這個指令需要管理員權限。" };
        }
        const summary = await options.memoryStore.summary();
        return {
          ok: true,
          replyText: [
            "Memory status",
            `resources: ${summary.resources}`,
            `externalResources: ${summary.externalResources}`,
            `textMemories: ${summary.textMemories}`,
            `aliases: ${summary.aliases}`
          ].join("\n")
        };
      }

      if (parsed.command === "memories") {
        const memories = await options.memoryStore.listTextMemories({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          requesterUserId: input.context.event.source.userId,
          limit: 10
        });
        const resources = await options.memoryStore.searchResources({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          requesterUserId: input.context.event.source.userId,
          limit: 10
        });
        const schedules = await options.memoryStore.searchScheduleEntries({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          requesterUserId: input.context.event.source.userId,
          limit: 10
        });
        const lines = [
          ...resources.map(formatResourceMemory),
          ...memories.map(formatTextMemory),
          ...schedules.map(formatScheduleMemory)
        ];
        return {
          ok: true,
          replyText: lines.length === 0 ? "目前沒有記住的資訊。" : ["Memories", ...lines].join("\n")
        };
      }

      if (parsed.command === "forget-memory") {
        const id = parsed.args[0];
        if (!id) {
          return { ok: true, replyText: "Usage: /forget-memory <id>" };
        }
        const removedText = await options.memoryStore.forgetMemory({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          id,
          deletedBy: input.context.event.source.userId,
          isAdmin: input.isAdmin
        });
        const removedResource = removedText
          ? false
          : await options.memoryStore.forgetResource({
              profileName: input.context.profile.name,
              source: input.context.event.source,
              id,
              deletedBy: input.context.event.source.userId,
              isAdmin: input.isAdmin
            });
        const removedSchedule =
          removedText || removedResource
            ? false
            : await options.memoryStore.forgetScheduleMemory({
                profileName: input.context.profile.name,
                source: input.context.event.source,
                id,
                deletedBy: input.context.event.source.userId,
                isAdmin: input.isAdmin
              });
        if (removedText || removedResource || removedSchedule) {
          await recordMemoryAudit(options.accessStore, input, "memory.delete");
        }
        return {
          ok: true,
          replyText:
            removedText || removedResource || removedSchedule
              ? "已移除這段記憶。"
              : "找不到這段記憶。"
        };
      }

      return undefined;
    }
  };
}

async function recordMemoryAudit(
  accessStore: AccessStore | undefined,
  input: AgentCommandInput,
  action: string
): Promise<void> {
  const actorUserId = input.context.event.source.userId;
  if (!accessStore || !actorUserId) {
    return;
  }
  await accessStore.recordAudit({
    profileName: input.context.profile.name,
    actorUserId,
    action,
    targetType: "agent_memory"
  });
}

async function createGraphLink(
  graph: GraphDriveClient,
  storage: AgentResourceReference["storage"],
  now: Date
): Promise<string> {
  if (storage.provider !== "graph") {
    throw new Error("graph_storage_required");
  }
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
  return graph.createSharingLink(storage.driveId, storage.itemId, expiresAt);
}

function toResourceReference(resource: AgentResourceRecord): AgentResourceReference {
  return {
    resourceType: resource.resourceType,
    title: resource.title,
    query: resource.query,
    storage: resource.storage
  };
}

function stringArgument(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resourceTypesForAction(action: FunctionName): AgentResourceType[] | undefined {
  switch (action) {
    case "find_ppt_slides":
      return ["ppt_slide"];
    case "find_sheet_music":
      return ["sheet_music"];
    case "find_resource":
      return ["general_resource"];
    default:
      return undefined;
  }
}

function formatTextMemory(memory: { id: string; title?: string; content: string }): string {
  const title = memory.title?.trim() || memory.content.slice(0, 16);
  return `- ${title} (${memory.id})\n${memory.content}`;
}

function formatResourceMemory(memory: AgentResourceRecord): string {
  const source = memory.storage.provider === "external_link" ? "連結" : "檔案";
  return `- ${memory.title} (${memory.id})\n${source}: ${memory.resourceType}`;
}

function formatScheduleMemory(memory: {
  id: string;
  memoryId: string;
  serviceDate: string;
  meetingName: string;
  assignee: string;
}): string {
  return `- ${memory.serviceDate} ${memory.meetingName}：${memory.assignee} (${memory.memoryId})`;
}

function parseMemoryCommand(text: string): { command: string; args: string[] } | undefined {
  const match = text.trim().match(/^\/(memories|forget-memory|memory-status)(?:\s+(.*))?$/i);
  if (!match) {
    return undefined;
  }
  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? "").split(/\s+/).filter(Boolean)
  };
}

export function isMemoryFunctionName(action: FunctionName): boolean {
  return action === "save_memory" || action === "retrieve_memory";
}

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

export interface AgentRuntimeOptions {
  memoryStore: AgentMemoryStore;
  graph?: GraphDriveClient;
  now?: () => Date;
}

export interface AfterFunctionResultInput {
  context: FunctionHandlerContext;
  action: FunctionName;
  arguments: JsonRecord;
  result: FunctionExecutionResult;
}

export interface AgentTextInput {
  text: string;
  context: FunctionHandlerContext;
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
  handleTextBeforeRouting(input: AgentTextInput): Promise<FunctionExecutionResult | undefined>;
  handleBeforeFunctionExecution(
    input: BeforeFunctionExecutionInput
  ): Promise<FunctionExecutionResult | undefined>;
  handleCommand(input: AgentCommandInput): Promise<FunctionExecutionResult | undefined>;
}

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const RESOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TEXT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
        resourceType: reference.resourceType,
        title: reference.title,
        query: reference.query ?? stringArgument(input.arguments, "query"),
        storage: reference.storage,
        expiresAt: new Date(now().getTime() + RESOURCE_TTL_MS).toISOString()
      });
    },

    async handleTextBeforeRouting(input) {
      const text = stripBotAddress(input.text, input.context.profile.wakeKeywords);
      const alias = extractAliasRequest(text);
      if (alias) {
        const recent = await options.memoryStore.findRecentResource({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          requesterUserId: input.context.event.source.userId,
          resourceTypes: ["ppt_slide", "sheet_music"]
        });
        if (!recent) {
          return { ok: true, replyText: "我這邊還沒有剛剛那份可以指定。" };
        }
        await options.memoryStore.rememberAlias({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          createdBy: input.context.event.source.userId,
          alias,
          resourceId: recent.id
        });
        return {
          ok: true,
          replyText: `好，以後在這裡提到「${alias}」時，我會先用這份：${recent.title}`
        };
      }

      const saveResourceRequest = extractSaveResourceRequest(text);
      if (saveResourceRequest) {
        if (!saveResourceRequest.resourceType) {
          return { ok: true, replyText: "這是投影片還是歌譜？請直接回覆類型後再保存。" };
        }
        const requiredFunction = functionNameForResourceType(saveResourceRequest.resourceType);
        if (!input.context.profile.enabledFunctions.includes(requiredFunction)) {
          return { ok: true, replyText: "這個功能目前沒有開放。" };
        }
        if (!saveResourceRequest.title) {
          return { ok: true, replyText: "要用什麼名稱保存這個資源？" };
        }
        await options.memoryStore.recordResource({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          createdBy: input.context.event.source.userId,
          resourceType: saveResourceRequest.resourceType,
          title: saveResourceRequest.title,
          query: saveResourceRequest.title,
          storage: {
            provider: "external_link",
            url: saveResourceRequest.url,
            description: saveResourceRequest.description
          },
          expiresAt: new Date(now().getTime() + RESOURCE_TTL_MS).toISOString()
        });
        return {
          ok: true,
          replyText: `已記住：${saveResourceRequest.title}`
        };
      }

      if (isRecentResourceRecall(text)) {
        const recent = await options.memoryStore.findRecentResource({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          requesterUserId: input.context.event.source.userId,
          resourceTypes: ["ppt_slide", "sheet_music"]
        });
        return recent ? createResourceReply(recent) : undefined;
      }

      const saveRequest = extractSaveMemoryRequest(text);
      if (saveRequest && input.context.profile.enabledFunctions.includes("save_memory")) {
        await options.memoryStore.saveTextMemory({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          createdBy: input.context.event.source.userId,
          title: saveRequest.title,
          content: saveRequest.content,
          query: saveRequest.title,
          expiresAt: new Date(now().getTime() + TEXT_MEMORY_TTL_MS).toISOString()
        });
        return { ok: true, replyText: "已記住，之後你可以請我查這段資訊。" };
      }

      const retrieveQuery = extractRetrieveMemoryQuery(text);
      if (
        retrieveQuery !== undefined &&
        input.context.profile.enabledFunctions.includes("retrieve_memory")
      ) {
        const memories = await options.memoryStore.searchTextMemories({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          query: retrieveQuery,
          limit: 3
        });
        if (memories.length === 0) {
          return { ok: true, replyText: "我目前找不到符合的記憶。" };
        }
        return {
          ok: true,
          replyText: ["我找到這些記住的資訊：", ...memories.map(formatTextMemory)].join("\n")
        };
      }

      return undefined;
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
          limit: 10
        });
        const resources = await options.memoryStore.searchResources({
          profileName: input.context.profile.name,
          source: input.context.event.source,
          limit: 10
        });
        const lines = [...resources.map(formatResourceMemory), ...memories.map(formatTextMemory)];
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
          deletedBy: input.context.event.source.userId
        });
        const removedResource = removedText
          ? false
          : await options.memoryStore.forgetResource({
              profileName: input.context.profile.name,
              source: input.context.event.source,
              id,
              deletedBy: input.context.event.source.userId
            });
        return {
          ok: true,
          replyText: removedText || removedResource ? "已移除這段記憶。" : "找不到這段記憶。"
        };
      }

      return undefined;
    }
  };
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

function stripBotAddress(text: string, wakeKeywords: string[]): string {
  let result = text.trim();
  for (const keyword of [...wakeKeywords, "小哈"]) {
    if (keyword && result.startsWith(keyword)) {
      result = result.slice(keyword.length).trim();
    }
  }
  return result.replace(/^[,，。:：\s]+/u, "").trim();
}

function isRecentResourceRecall(text: string): boolean {
  return /再給我一次|剛剛那份|剛才那份|剛剛那個|上一份|再傳一次|再貼一次/u.test(text);
}

function extractAliasRequest(text: string): string | undefined {
  const match = text.match(/以後\s*(.+?)\s*就用這份/u);
  return match?.[1]?.trim() || undefined;
}

function extractSaveMemoryRequest(text: string): { title?: string; content: string } | undefined {
  const match = text.match(/^(?:幫我)?(?:記住|保存|儲存)(?:一下)?[：:\s]*(.+)$/u);
  const content = match?.[1]?.trim();
  if (!content) {
    return undefined;
  }
  const [maybeTitle, ...rest] = content.split(/[：:]/u);
  const title = rest.length > 0 ? maybeTitle.trim() : inferTitle(content);
  return { title, content: rest.length > 0 ? rest.join(":").trim() : content };
}

function extractSaveResourceRequest(text: string):
  | {
      url: string;
      resourceType?: AgentResourceType;
      title?: string;
      description?: string;
    }
  | undefined {
  if (!/(?:記住|保存|儲存)/u.test(text)) {
    return undefined;
  }
  const url = firstUrl(text);
  if (!url) {
    return undefined;
  }
  return {
    url,
    resourceType: inferResourceType(text),
    title: extractResourceTitle(text, url),
    description: text.replace(url, "").trim()
  };
}

function firstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s，,。)）]+/u);
  return match?.[0];
}

function inferResourceType(text: string): AgentResourceType | undefined {
  if (/投影片|簡報|ppt|powerpoint|slide/i.test(text)) {
    return "ppt_slide";
  }
  if (/歌譜|樂譜|sheet\s*music/i.test(text)) {
    return "sheet_music";
  }
  return undefined;
}

function extractResourceTitle(text: string, url: string): string | undefined {
  const withoutUrl = text.replace(url, " ").trim();
  const explicit = withoutUrl.match(/(?:名稱|標題|名字)(?:是|叫)?[：:\s]*(.+)$/u)?.[1]?.trim();
  if (explicit) {
    return cleanupTitle(explicit);
  }
  return undefined;
}

function cleanupTitle(value: string): string | undefined {
  const cleaned = value.replace(/[。.!！?？]+$/u, "").trim();
  return cleaned || undefined;
}

function extractRetrieveMemoryQuery(text: string): string | undefined {
  const match = text.match(/(?:查|找|看)(?:一下)?(?:我)?(?:記住|保存|儲存)(?:的)?[：:\s]*(.*)$/u);
  if (match) {
    return match[1]?.trim() ?? "";
  }
  const remembered = text.match(/我記住的[：:\s]*(.*)$/u);
  if (remembered) {
    return remembered[1]?.trim() ?? "";
  }
  return undefined;
}

function resourceTypesForAction(action: FunctionName): AgentResourceType[] | undefined {
  switch (action) {
    case "find_ppt_slides":
      return ["ppt_slide"];
    case "find_pop_sheet_music":
      return ["sheet_music"];
    default:
      return undefined;
  }
}

function functionNameForResourceType(resourceType: AgentResourceType): FunctionName {
  return resourceType === "ppt_slide" ? "find_ppt_slides" : "find_pop_sheet_music";
}

function inferTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 20) || "記憶";
}

function formatTextMemory(memory: { id: string; title?: string; content: string }): string {
  const title = memory.title?.trim() || memory.content.slice(0, 16);
  return `- ${title} (${memory.id})\n${memory.content}`;
}

function formatResourceMemory(memory: AgentResourceRecord): string {
  const source = memory.storage.provider === "external_link" ? "連結" : "檔案";
  return `- ${memory.title} (${memory.id})\n${source}: ${memory.resourceType}`;
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

import type { CapabilityName } from "../../capabilities/names.js";
import type { AccessStore } from "../../access/types.js";
import type { AgentMemoryStore } from "../../agent/memory-store.js";
import type { FunctionExecutionResult, FunctionHandlerContext } from "../../types.js";

export interface MemoryCommandHandler {
  handleCommand(input: {
    text: string;
    context: FunctionHandlerContext;
    isAdmin: boolean;
  }): Promise<FunctionExecutionResult | undefined>;
}

export function createMemoryCommandHandler(options: {
  memoryStore: AgentMemoryStore;
  accessStore?: AccessStore;
}): MemoryCommandHandler {
  return {
    async handleCommand(input) {
      const parsed = parseMemoryCommand(input.text);
      if (!parsed) return undefined;
      if (parsed.command === "memory-status") {
        if (!input.isAdmin) return { ok: true, replyText: "這個指令需要管理員權限。" };
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
        const lines = memories.map(formatTextMemory);
        return {
          ok: true,
          replyText: lines.length === 0 ? "目前沒有記住的資訊。" : ["Memories", ...lines].join("\n")
        };
      }
      const id = parsed.args[0];
      if (!id) return { ok: true, replyText: "Usage: /forget-memory <id>" };
      const removed = await options.memoryStore.forgetMemory({
        profileName: input.context.profile.name,
        source: input.context.event.source,
        id,
        deletedBy: input.context.event.source.userId,
        isAdmin: input.isAdmin
      });
      if (removed) await recordMemoryAudit(options.accessStore, input);
      return { ok: true, replyText: removed ? "已移除這段記憶。" : "找不到這段記憶。" };
    }
  };
}

export function memoryCommandCapabilityName(text: string): CapabilityName | undefined {
  switch (parseMemoryCommand(text)?.command) {
    case "memories":
      return "retrieve_memory";
    case "forget-memory":
      return "save_memory";
    default:
      return undefined;
  }
}

function parseMemoryCommand(text: string): { command: string; args: string[] } | undefined {
  const match = text.trim().match(/^\/(memories|forget-memory|memory-status)(?:\s+(.*))?$/i);
  return match
    ? { command: match[1].toLowerCase(), args: (match[2] ?? "").split(/\s+/).filter(Boolean) }
    : undefined;
}

function formatTextMemory(memory: { id: string; title?: string; content: string }): string {
  const title = memory.title?.trim() || memory.content.slice(0, 16);
  return `- ${title} (${memory.id})\n${memory.content}`;
}

async function recordMemoryAudit(
  accessStore: AccessStore | undefined,
  input: Parameters<MemoryCommandHandler["handleCommand"]>[0]
): Promise<void> {
  const actorUserId = input.context.event.source.userId;
  if (!accessStore || !actorUserId) return;
  await accessStore.recordAudit({
    profileName: input.context.profile.name,
    actorUserId,
    action: "memory.delete",
    targetType: "agent_memory"
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "langchain";
import type { HelperAgentRunSnapshot } from "./state.js";

export interface ProviderCircuit {
  acquire(): Promise<string | undefined>;
  fail(lease: string, permanent: boolean): Promise<void>;
  succeed(lease: string): Promise<void>;
}
export type FallbackReason = "pinned" | "circuit_open" | "transient" | "permanent";
interface ProviderSession {
  onSwitch?(reason: FallbackReason): void;
  beforeFallback?(): Promise<void>;
  pinned: boolean;
  pin(): Promise<void>;
  circuit: ProviderCircuit;
}
const sessions = new AsyncLocalStorage<ProviderSession>();

export function withProviderFailover<T>(
  snapshot: HelperAgentRunSnapshot,
  circuit: ProviderCircuit,
  task: () => Promise<T>,
  onSwitch?: (reason: FallbackReason) => void,
  beforeFallback?: () => Promise<void>
): Promise<T> {
  if (!snapshot.pinFallback) throw new Error("fallback_state_unavailable");
  if (snapshot.fallbackPinned) onSwitch?.("pinned");
  return sessions.run(
    {
      beforeFallback,
      onSwitch,
      pinned: snapshot.fallbackPinned ?? false,
      pin: snapshot.pinFallback,
      circuit
    },
    task
  );
}

export function fallbackError(error: unknown): "transient" | "permanent" | undefined {
  if (!(error instanceof Error)) return;
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (cause.message.startsWith("agent_") || cause.name === "AbortError") return;
    cause = cause.cause;
  }
  cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    const code = (cause as Error & { code?: string }).code;
    if (
      [
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT"
      ].includes(code ?? "")
    )
      return "transient";
    cause = cause.cause;
  }
  const status = (error as Error & { status?: number }).status;
  if (status === 401 || status === 403) return "permanent";
  if (status === 429)
    return ["insufficient_quota", "organization_usage_limit_exceeded"].includes(
      String((error as Error & { code?: string }).code)
    )
      ? "permanent"
      : "transient";
  if (status === 408 || (status !== undefined && status >= 500 && status <= 599))
    return "transient";
  if (["APIConnectionError", "APIConnectionTimeoutError", "APITimeoutError"].includes(error.name))
    return "transient";
}

/** Both response and summary clients share the same scoped pin and circuit. */
export class FailoverChatOpenAI extends ChatOpenAI {
  constructor(
    fields: ConstructorParameters<typeof ChatOpenAI>[0],
    private readonly fallback: ChatDeepSeek,
    private readonly modelRole: "response" | "summary" = "response"
  ) {
    super({ ...fields, disableStreaming: true });
  }
  override withConfig(config: Parameters<ChatOpenAI["withConfig"]>[0]): this {
    const model = new FailoverChatOpenAI(this.fields, this.fallback, this.modelRole);
    model.defaultOptions = { ...this.defaultOptions, ...config };
    return model as this;
  }
  override async _generate(...args: Parameters<ChatOpenAI["_generate"]>) {
    const session = sessions.getStore();
    if (!session) throw new Error("fallback_scope_required");
    if (!session.pinned) {
      const lease = await session.circuit.acquire();
      if (lease === undefined) session.onSwitch?.("circuit_open");
      if (lease !== undefined) {
        try {
          const result = await super._generate(...args);
          for (const generation of result.generations)
            generation.message.response_metadata = {
              ...generation.message.response_metadata,
              helper_provider: "openai",
              helper_model_role: this.modelRole
            };
          await session.circuit.succeed(lease);
          return result;
        } catch (error) {
          const category = fallbackError(error);
          if (!category || args[1].signal?.aborted) throw error;
          await session.circuit.fail(lease, category === "permanent");
          session.onSwitch?.(category);
        }
      }
      // Persist before sending to the fallback, including when that request fails.
      await session.pin();
      session.pinned = true;
    }
    await session.beforeFallback?.();
    const [messages, options, manager] = args;
    const result = await this.fallback._generate(
      normalizeFallbackMessages(messages),
      {
        signal: options.signal,
        tools: options.tools,
        tool_choice: options.tool_choice,
        parallel_tool_calls: options.parallel_tool_calls,
        stop: options.stop
      },
      manager
    );
    for (const generation of result.generations)
      generation.message.response_metadata = {
        ...generation.message.response_metadata,
        helper_provider: "deepseek",
        helper_model_role: this.modelRole
      };
    return result;
  }
}

export function normalizeFallbackMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => {
              if (block.type === "text" && typeof block.text === "string") return block.text;
              if (
                AIMessage.isInstance(message) &&
                ["reasoning", "thinking", "redacted_thinking"].includes(block.type)
              )
                return "";
              throw new Error("fallback_message_format_unsupported");
            })
            .join("");
    if (AIMessage.isInstance(message)) {
      if (message.invalid_tool_calls?.length) throw new Error("fallback_incomplete_tool_call");
      return new AIMessage({ content, tool_calls: message.tool_calls });
    }
    if (ToolMessage.isInstance(message))
      return new ToolMessage({
        content,
        tool_call_id: message.tool_call_id,
        name: message.name,
        status: message.status
      });
    if (HumanMessage.isInstance(message)) return new HumanMessage(content);
    if (SystemMessage.isInstance(message)) return new SystemMessage(content);
    throw new Error("fallback_message_role_unsupported");
  });
}

interface CircuitRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
// A failed primary opens for 60 seconds (auth/permission: one hour). Only one
// real user request may probe recovery; no background paid inference is created.
export function createRedisProviderCircuit(client: CircuitRedis, prefix: string): ProviderCircuit {
  const keys = [`${prefix}:cooldown`, `${prefix}:recovering`, `${prefix}:probe`];
  return {
    async acquire() {
      const token = randomUUID();
      const result = await client.eval(
        `
        if redis.call('EXISTS',KEYS[1])==1 then return 0 end
        if redis.call('EXISTS',KEYS[2])==0 then return 1 end
        if redis.call('SET',KEYS[3],ARGV[1],'NX','PX',30000) then return 2 end
        return 0`,
        { keys, arguments: [token] }
      );
      return Number(result) === 1 ? "closed" : Number(result) === 2 ? token : undefined;
    },
    async fail(lease, permanent) {
      await client.eval(
        `
        if ARGV[1]~='closed' and redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end
        redis.call('SET',KEYS[1],'1','PX',ARGV[2])
        redis.call('SET',KEYS[2],'1','PX',86400000)
        redis.call('DEL',KEYS[3])
        return 1`,
        { keys, arguments: [lease, String(permanent ? 3_600_000 : 60_000)] }
      );
    },
    async succeed(lease) {
      if (lease === "closed") return;
      await client.eval(
        `
        if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end
        redis.call('DEL',KEYS[1],KEYS[2],KEYS[3])
        return 1`,
        { keys, arguments: [lease] }
      );
    }
  };
}

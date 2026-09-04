import { MemorySaver } from "@langchain/langgraph";
import {
  createMiddleware,
  createAgent,
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
  ToolMessage,
  toolCallLimitMiddleware,
  type CreateAgentParams,
  type HumanInTheLoopMiddlewareConfig
} from "langchain";

type SdkAgentOptions = Pick<
  CreateAgentParams,
  "checkpointer" | "model" | "systemPrompt" | "tools"
> & {
  interruptOn?: HumanInTheLoopMiddlewareConfig["interruptOn"];
  modelCallLimit?: number;
  toolCallLimit?: number;
};

export function createSdkAgent({
  checkpointer = new MemorySaver(),
  interruptOn,
  model,
  modelCallLimit = 6,
  systemPrompt,
  toolCallLimit = 6,
  tools = []
}: SdkAgentOptions) {
  const executedToolCalls = new Set<string>();
  return createAgent({
    checkpointer,
    middleware: [
      createMiddleware({
        name: "ExactToolCallDeduplication",
        wrapToolCall: async (request, handler) => {
          if (!request.tool) throw new Error(`${request.toolCall.name} is not a valid tool`);
          const key = JSON.stringify([request.toolCall.name, request.toolCall.args]);
          if (executedToolCalls.has(key)) {
            return new ToolMessage({
              content: JSON.stringify({
                status: "denied",
                reason: "duplicate_tool_call",
                instruction: "Use the previous result and do not repeat this tool call."
              }),
              tool_call_id: request.toolCall.id ?? key,
              name: request.toolCall.name,
              status: "error"
            });
          }
          const result = await handler(request);
          if (ToolMessage.isInstance(result)) executedToolCalls.add(key);
          return result;
        }
      }),
      modelCallLimitMiddleware({
        runLimit: modelCallLimit,
        exitBehavior: "error"
      }),
      toolCallLimitMiddleware({
        runLimit: toolCallLimit,
        exitBehavior: "error"
      }),
      ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : [])
    ],
    model,
    systemPrompt,
    tools
  });
}

import { MemorySaver } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
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
  return createAgent({
    checkpointer,
    middleware: [
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

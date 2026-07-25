import type { BotProfileConfig, FunctionExecutionResult, LineEvent } from "../../types.js";

export interface LineCommandTransportContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
}

export type LineCommandHandler = (
  context: LineCommandTransportContext
) => Promise<FunctionExecutionResult>;

import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
import type { BotProfileConfig, FunctionName, LineEvent } from "../types.js";

export interface ProfileTurnInput {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  configuredFunctions?: FunctionName[];
  authorizeFunctions?: (names: FunctionName[]) => Promise<FunctionName[]>;
  accountAdministrator?: () => boolean;
}

export interface ProfileRuntime {
  handleTextTurn(input: ProfileTurnInput): Promise<FunctionExecutionResult | undefined>;
}

export function createProfileRuntimeDispatcher(
  runtimes: Partial<Record<string, ProfileRuntime>>
): ProfileRuntime {
  return {
    handleTextTurn(input) {
      return runtimes[input.profile.name]?.handleTextTurn(input) ?? Promise.resolve(undefined);
    }
  };
}

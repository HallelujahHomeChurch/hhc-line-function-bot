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

export interface ProfileActionReviewInput extends ProfileTurnInput {
  reviewId: string;
  resultJobId: string;
  text: string;
}

export interface ProfileActionReviewResult {
  result: FunctionExecutionResult;
  freshExecution: boolean;
}

export interface ProfileRuntime {
  readonly observesCompletion?: boolean;
  handleTextTurn(input: ProfileTurnInput): Promise<FunctionExecutionResult | undefined>;
  handleActionReview?(
    input: ProfileActionReviewInput
  ): Promise<ProfileActionReviewResult | undefined>;
}

export function createProfileRuntimeDispatcher(
  runtimes: Partial<Record<string, ProfileRuntime>>
): ProfileRuntime {
  return {
    handleTextTurn(input) {
      return runtimes[input.profile.name]?.handleTextTurn(input) ?? Promise.resolve(undefined);
    },
    handleActionReview(input) {
      return (
        runtimes[input.profile.name]?.handleActionReview?.(input) ?? Promise.resolve(undefined)
      );
    }
  };
}

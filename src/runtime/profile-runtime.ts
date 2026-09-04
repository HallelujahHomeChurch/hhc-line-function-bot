import type { CapabilityName } from "../capabilities/names.js";
import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

export interface ProfileTurnInput {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  configuredFunctions?: CapabilityName[];
  authorizeFunctions?: (names: CapabilityName[]) => Promise<CapabilityName[]>;
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

export type ProfileSheetMusicResearchOutcome =
  { kind: "accepted" } | { kind: "handled"; result: FunctionExecutionResult };

export interface ProfileRuntime {
  readonly observesCompletion?: boolean;
  acceptSheetMusicResearch?(
    input: ProfileTurnInput
  ): Promise<ProfileSheetMusicResearchOutcome | undefined>;
  handleTextTurn(input: ProfileTurnInput): Promise<FunctionExecutionResult | undefined>;
  handleActionReview?(
    input: ProfileActionReviewInput
  ): Promise<ProfileActionReviewResult | undefined>;
}

export function createProfileRuntimeDispatcher(
  runtimes: Partial<Record<string, ProfileRuntime>>
): ProfileRuntime {
  return {
    acceptSheetMusicResearch(input) {
      return (
        runtimes[input.profile.name]?.acceptSheetMusicResearch?.(input) ??
        Promise.resolve(undefined)
      );
    },
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

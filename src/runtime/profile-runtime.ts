import type { QuoteContext, QuoteScope } from "../quotes/types.js";
import type { CapabilityName } from "../capabilities/names.js";
import type { FunctionExecutionResult } from "../application/contracts/function-execution.js";
import type { HelperWriteToolName } from "../state/session-store.js";
import type { BotProfileConfig, LineEvent, JsonRecord } from "../types.js";

export interface ProfileTurnInput {
  operationId?: string;
  channelId?: string;
  quoteContext?: QuoteContext;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  configuredFunctions?: CapabilityName[];
  authorizeFunctions?: (names: CapabilityName[]) => Promise<CapabilityName[]>;
  accountAdministrator?: () => boolean;
  nicknameWriteEnabled?: () => boolean;
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
  prepareActionReview?(
    input: ProfileTurnInput & { toolName: HelperWriteToolName; arguments: JsonRecord }
  ): Promise<FunctionExecutionResult | undefined>;
  recordDeliveredReply?(input: {
    scope: QuoteScope;
    quoteContext: QuoteContext;
    messages: Array<{ id: string; text: string }>;
  }): Promise<void>;
  readonly observesCompletion?: boolean;
  clearContext?(scope: QuoteScope): Promise<void>;
  recordExternalResult?(input: ProfileTurnInput, result: FunctionExecutionResult): Promise<void>;
  handleTextTurn(input: ProfileTurnInput): Promise<FunctionExecutionResult | undefined>;
  handleActionReview?(
    input: ProfileActionReviewInput
  ): Promise<ProfileActionReviewResult | undefined>;
}

export function createProfileRuntimeDispatcher(
  runtimes: Partial<Record<string, ProfileRuntime>>
): ProfileRuntime {
  return {
    prepareActionReview(input) {
      return (
        runtimes[input.profile.name]?.prepareActionReview?.(input) ?? Promise.resolve(undefined)
      );
    },
    recordDeliveredReply(input) {
      return runtimes[input.scope.profileName]?.recordDeliveredReply?.(input) ?? Promise.resolve();
    },
    clearContext(scope) {
      return runtimes[scope.profileName]?.clearContext?.(scope) ?? Promise.resolve();
    },
    recordExternalResult(input, result) {
      return (
        runtimes[input.profile.name]?.recordExternalResult?.(input, result) ?? Promise.resolve()
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

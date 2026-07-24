import { pathToFileURL } from "node:url";

import { createAgentPlanner } from "../agent/planner.js";
import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import { createDeepSeekProvider } from "../clients/deepseek.js";
import { loadConfigFromEnv } from "../config.js";
import { createProfileAwareProvider, resolveProviderNameForLane } from "../llm/provider-runtime.js";
import type { ProviderRegistry } from "../llm/provider-runtime.js";
import { AGENT_PLANNER_EVAL_CASES, evaluateAgentPlannerCases } from "./eval-agent-planner.js";

export interface ForcedUnavailableResult {
  provider: "deepseek";
  primaryStatus: "unavailable";
  status: "no_plan";
  reasonCode: "providers_unavailable";
  attempts: 1;
}

export async function evaluateForcedDeepSeekUnavailable(
  profileName: string
): Promise<ForcedUnavailableResult> {
  const entry = AGENT_PLANNER_EVAL_CASES.find(
    ({ name }) => name === "acceptance-1-focused-schedule-role"
  );
  if (!entry) throw new Error("eval_agent_fallback_case_missing");
  const candidates = buildCapabilityCandidates({
    text: entry.text,
    enabledFunctions: entry.enabledFunctions,
    activeTask: entry.activeTask,
    knowledgeSources: entry.knowledgeSources ?? [],
    retrievalEvidence: entry.retrievalEvidence,
    maxCandidates: 3,
    source: "group"
  });
  const planner = createAgentPlanner({
    primary: {
      providerName: "deepseek",
      completeJson: async () => {
        throw new Error("forced_primary_failure");
      }
    }
  });
  const proposal = await planner.propose({
    profileName,
    text: entry.text,
    candidates,
    activeTask: entry.activeTask
  });
  if (
    proposal.status !== "no_plan" ||
    proposal.reasonCode !== "providers_unavailable" ||
    proposal.attempts.length !== 1 ||
    proposal.attempts[0]?.provider !== "deepseek" ||
    proposal.attempts[0]?.status !== "unavailable"
  ) {
    throw new Error("eval_agent_forced_deepseek_unavailable_failed");
  }
  return {
    provider: "deepseek",
    primaryStatus: "unavailable",
    status: "no_plan",
    reasonCode: "providers_unavailable",
    attempts: 1
  };
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv({
    ...process.env,
    PROFILE_CONFIG_PATH: process.env.PROFILE_CONFIG_PATH || "config/profiles.json"
  });
  const profileName = process.env.AGENT_EVAL_PROFILE || "helper";
  const primaryName = resolveProviderNameForLane(
    config,
    profileName,
    "function_routing",
    "primary"
  );
  if (primaryName !== "deepseek") {
    throw new Error(`eval_agent_primary_must_be_deepseek:${primaryName}`);
  }
  const providers: ProviderRegistry = {
    deepseek: createDeepSeekProvider({
      apiKey: config.llm.deepseekApiKey,
      baseUrl: config.llm.deepseekBaseUrl,
      model: config.llm.deepseekModel,
      timeoutMs: config.llm.deepseekTimeoutMs,
      routeMaxOutputTokens: config.llm.routeMaxOutputTokens ?? 256,
      generalMaxOutputTokens: config.llm.generalMaxOutputTokens ?? 512
    })
  };
  const planner = createAgentPlanner({
    primary: createProfileAwareProvider({
      config,
      providers,
      role: "primary",
      lane: "function_routing"
    })
  });
  const liveCases = AGENT_PLANNER_EVAL_CASES.filter(({ offlineOnly }) => !offlineOnly);
  const report = await evaluateAgentPlannerCases(
    async (entry, candidates) =>
      planner.propose({
        profileName,
        text: entry.text,
        candidates,
        activeTask: entry.activeTask
      }),
    liveCases
  );
  const forcedUnavailable = await evaluateForcedDeepSeekUnavailable(profileName);

  console.log(`Agent planner live provider: primary=${primaryName}`);
  console.log(`Candidate accuracy: ${report.candidatePassed}/${report.candidateAttempted}`);
  console.log(`Proposal accuracy: ${report.proposalPassed}/${report.proposalAttempted}`);
  console.log(`Final validated accuracy: ${report.validatedPassed}/${report.validatedAttempted}`);
  console.log(
    `Forced unavailable: provider=${forcedUnavailable.provider} primary=${forcedUnavailable.primaryStatus} status=${forcedUnavailable.status}`
  );
  for (const failure of report.candidateFailures) console.error(`candidate: ${failure}`);
  for (const failure of report.proposalFailures) console.error(`proposal: ${failure}`);
  for (const failure of report.validatedFailures) console.error(`validated: ${failure}`);
  if (report.candidateFailures.length > 0 || report.validatedFailures.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { pathToFileURL } from "node:url";

import { createAgentPlanner } from "../agent/planner.js";
import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import { validateAgentPlan } from "../agent/plan-validator.js";
import { createDeepSeekProvider } from "../clients/deepseek.js";
import { createOllamaProvider } from "../clients/ollama.js";
import { loadConfigFromEnv } from "../config.js";
import { createProfileAwareProvider, resolveProviderNameForLane } from "../llm/provider-runtime.js";
import type { ProviderRegistry } from "../llm/provider-runtime.js";
import type { ChatProvider } from "../types.js";
import { AGENT_PLANNER_EVAL_CASES, evaluateAgentPlannerCases } from "./eval-agent-planner.js";

export interface ForcedFallbackResult {
  provider: "ollama";
  primaryStatus: "unavailable";
  finalDisposition: "execute";
  finalCapability: "query_schedule";
}

export async function evaluateForcedOllamaFallback(
  ollamaFallback: ChatProvider,
  profileName: string
): Promise<ForcedFallbackResult> {
  const fallbackName =
    ollamaFallback.providerNameForProfile?.(profileName) ?? ollamaFallback.providerName;
  if (fallbackName !== "ollama") throw new Error("eval_agent_forced_fallback_must_be_ollama");
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
    },
    fallback: ollamaFallback
  });
  const proposal = await planner.propose({
    profileName,
    text: entry.text,
    candidates,
    activeTask: entry.activeTask
  });
  if (
    proposal.status === "no_plan" ||
    proposal.provider !== "ollama" ||
    proposal.attempts[0]?.status !== "unavailable" ||
    proposal.attempts[1]?.provider !== "ollama" ||
    proposal.attempts[1]?.status !== "accepted"
  ) {
    throw new Error("eval_agent_forced_ollama_fallback_failed");
  }
  const finalPlan = validateAgentPlan({
    text: entry.text,
    enabledFunctions: entry.enabledFunctions,
    candidates,
    proposal,
    activeTask: entry.activeTask,
    minConfidence: 0.65,
    sourceType: "group",
    now: new Date("2026-07-14T00:00:00.000Z")
  });
  if (finalPlan.disposition !== "execute" || finalPlan.capability !== "query_schedule") {
    throw new Error("eval_agent_forced_fallback_validation_failed");
  }
  return {
    provider: "ollama",
    primaryStatus: "unavailable",
    finalDisposition: "execute",
    finalCapability: "query_schedule"
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
  const fallbackName = resolveProviderNameForLane(
    config,
    profileName,
    "function_routing",
    "fallback"
  );
  if (primaryName !== "deepseek") {
    throw new Error(`eval_agent_primary_must_be_deepseek:${primaryName}`);
  }
  if (fallbackName !== "ollama") {
    throw new Error(`eval_agent_fallback_must_be_ollama:${fallbackName}`);
  }

  const providers: ProviderRegistry = {
    ollama: createOllamaProvider({
      baseUrl: config.llm.ollamaBaseUrl,
      model: config.llm.ollamaModel,
      timeoutMs: config.llm.timeoutMs,
      keepAlive: config.llm.ollamaKeepAlive
    }),
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
    }),
    fallback: createProfileAwareProvider({
      config,
      providers,
      role: "fallback",
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
  const forcedFallback = await evaluateForcedOllamaFallback(providers.ollama, profileName);

  console.log(`Agent planner live providers: primary=${primaryName} fallback=${fallbackName}`);
  console.log(`Proposal accuracy: ${report.proposalPassed}/${report.total}`);
  console.log(`Final validated accuracy: ${report.validatedPassed}/${report.total}`);
  console.log(
    `Forced fallback: provider=${forcedFallback.provider} primary=${forcedFallback.primaryStatus} final=${forcedFallback.finalDisposition}`
  );
  for (const failure of report.proposalFailures) console.error(`proposal: ${failure}`);
  for (const failure of report.validatedFailures) console.error(`validated: ${failure}`);
  if (report.validatedFailures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

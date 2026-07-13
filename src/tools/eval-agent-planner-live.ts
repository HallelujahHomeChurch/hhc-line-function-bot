import { pathToFileURL } from "node:url";

import { createAgentPlanner } from "../agent/planner.js";
import { createDeepSeekProvider } from "../clients/deepseek.js";
import { createOllamaProvider } from "../clients/ollama.js";
import { loadConfigFromEnv } from "../config.js";
import { createProfileAwareProvider, resolveProviderNameForLane } from "../llm/provider-runtime.js";
import type { ProviderRegistry } from "../llm/provider-runtime.js";
import { evaluateAgentPlannerCases } from "./eval-agent-planner.js";

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
  const report = await evaluateAgentPlannerCases(async (entry, candidates) =>
    planner.propose({
      profileName,
      text: entry.text,
      candidates,
      activeTask: entry.activeTask
    })
  );

  console.log(`Agent planner live providers: primary=${primaryName} fallback=${fallbackName}`);
  console.log(`Proposal accuracy: ${report.proposalPassed}/${report.total}`);
  console.log(`Final validated accuracy: ${report.validatedPassed}/${report.total}`);
  for (const failure of report.proposalFailures) console.error(`proposal: ${failure}`);
  for (const failure of report.validatedFailures) console.error(`validated: ${failure}`);
  if (report.validatedFailures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

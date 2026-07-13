import type { FunctionAllowedSource } from "../functions/definitions.js";
import type { AgentPlannerResult, FunctionName } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import {
  buildCapabilityCandidates,
  type KnowledgeSourceMetadata
} from "./capability-candidates.js";
import type { AgentPlanner } from "./planner.js";
import { validateAgentPlan, type ValidatedAgentPlan } from "./plan-validator.js";

export interface DynamicKnowledgeMetadataProvider {
  list(profileName: string, limit: number): Promise<readonly KnowledgeSourceMetadata[]>;
}

export interface ControlledAgentRouterInput {
  profileName: string;
  text: string;
  enabledFunctions: readonly FunctionName[];
  sourceType: string;
  activeTask?: ActiveTaskContext;
  maxCandidates: number;
  minPlannerConfidence: number;
}

export interface ControlledAgentRouter {
  resolve(input: ControlledAgentRouterInput): Promise<ValidatedAgentPlan>;
}

export function createControlledAgentRouter(options: {
  planner: AgentPlanner;
  knowledgeMetadata?: DynamicKnowledgeMetadataProvider;
  now?: () => Date;
}): ControlledAgentRouter {
  const now = options.now ?? (() => new Date());

  return {
    async resolve(input): Promise<ValidatedAgentPlan> {
      const source = allowedSource(input.sourceType);
      if (!source) {
        return { disposition: "deny", reasonCode: "source_not_allowed" };
      }

      const knowledgeSources = await readKnowledgeMetadata(
        options.knowledgeMetadata,
        input.profileName
      );
      const candidates = buildCapabilityCandidates({
        text: input.text,
        enabledFunctions: input.enabledFunctions,
        activeTask: input.activeTask,
        knowledgeSources,
        maxCandidates: input.maxCandidates,
        source
      });
      const proposal = await proposeOrNoPlan(options.planner, {
        profileName: input.profileName,
        text: input.text,
        candidates,
        activeTask: input.activeTask
      });

      return validateAgentPlan({
        text: input.text,
        enabledFunctions: input.enabledFunctions,
        candidates,
        proposal,
        activeTask: input.activeTask,
        minConfidence: input.minPlannerConfidence,
        sourceType: source,
        now: now()
      });
    }
  };
}

const KNOWLEDGE_METADATA_LIMIT = 20;

async function readKnowledgeMetadata(
  provider: DynamicKnowledgeMetadataProvider | undefined,
  profileName: string
): Promise<readonly KnowledgeSourceMetadata[]> {
  if (!provider) return [];
  try {
    return await provider.list(profileName, KNOWLEDGE_METADATA_LIMIT);
  } catch {
    return [];
  }
}

async function proposeOrNoPlan(
  planner: AgentPlanner,
  input: Parameters<AgentPlanner["propose"]>[0]
): Promise<AgentPlannerResult> {
  try {
    return await planner.propose(input);
  } catch {
    return { status: "no_plan", reasonCode: "providers_unavailable", attempts: [] };
  }
}

function allowedSource(sourceType: string): FunctionAllowedSource | undefined {
  return sourceType === "user" || sourceType === "group" ? sourceType : undefined;
}

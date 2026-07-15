import type { FunctionName, JsonRecord } from "../types.js";

export interface ResolutionCandidate {
  id: string;
  capability: FunctionName;
  domainKey: string;
  displayName: string;
  evidenceKinds: string[];
  requiredSlots: string[];
  reference: JsonRecord;
}

export type ResolutionDecision =
  | { status: "selected"; candidate: ResolutionCandidate }
  | { status: "ambiguous"; candidates: ResolutionCandidate[] }
  | { status: "missing_slots"; slots: string[] }
  | { status: "not_found" };

export function decideResolution(candidates: ResolutionCandidate[]): ResolutionDecision {
  if (candidates.length === 0) return { status: "not_found" };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  const candidate = candidates[0];
  if (candidate.requiredSlots.length > 0) {
    return { status: "missing_slots", slots: [...candidate.requiredSlots] };
  }
  return { status: "selected", candidate };
}

import type { FunctionAllowedSource } from "../../functions/definitions.js";

export interface AgentEvidenceProbeInput {
  profileName: string;
  text: string;
  source: FunctionAllowedSource;
  sourceId?: string;
  requesterUserId?: string;
  maxResults: number;
}

export interface AgentEvidenceProbeResult {
  matched: boolean;
  count: number;
  opaqueIds: readonly string[];
}

export interface AgentEvidenceProvider {
  probe(input: AgentEvidenceProbeInput): Promise<AgentEvidenceProbeResult>;
}

import type { FunctionExecutionResult, FunctionName, JsonRecord } from "../types.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import { prepareActiveTaskForStorage } from "./active-task-codec.js";
import type { AgentEntity } from "./result-envelope.js";

export interface ActiveTaskContext {
  version: 2;
  currentCapability: FunctionName;
  allowedCapabilities: FunctionName[];
  anchors: JsonRecord;
  entities: AgentEntity[];
  references?: JsonRecord;
  supportedOperations: string[];
  responseContext?: {
    availableFields: string[];
    defaultProjection: "focused" | "full";
  };
  createdAt: string;
  expiresAt: string;
}

export function activeTaskFromResult(
  capability: FunctionName,
  result: FunctionExecutionResult,
  now: Date,
  ttlMs: number
): ActiveTaskContext | undefined {
  if (!result.ok || result.agentResult?.status !== "success") return undefined;
  const projection = getFunctionDefinition(capability)?.agentCapability?.responseProjection;
  return prepareActiveTaskForStorage(
    {
      version: 2,
      currentCapability: capability,
      allowedCapabilities: [capability],
      anchors: result.agentResult.anchors ?? {},
      entities: result.agentResult.entities ?? [],
      references: result.agentResult.evidence?.[0]?.reference,
      supportedOperations: result.agentResult.supportedOperations ?? [],
      ...(projection
        ? {
            responseContext: {
              availableFields: Object.keys(projection.fields),
              defaultProjection: projection.defaultMode
            }
          }
        : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    },
    now
  );
}

import type { CapabilityName } from "../../capabilities/names.js";
import type { EffectiveAccessContext } from "../access/effective-access.js";
import type { QuickReplyItem } from "../contracts/function-execution.js";
import {
  CAPABILITY_CATALOG,
  getFunctionDefinitions,
  type FunctionDefinition
} from "../../capabilities/catalog.js";

export interface CapabilityPresentation {
  functionName: CapabilityName;
  displayName: string;
  shortDescription: string;
  example: string;
  quickReply: QuickReplyItem;
}

export interface EffectiveCapabilityProjection {
  reads: CapabilityPresentation[];
  writes: CapabilityPresentation[];
  onboarding: CapabilityPresentation[];
  accountLoginAvailable: boolean;
}

const preferredOnboardingReads: CapabilityName[] = [
  "query_schedule",
  "find_sheet_music",
  "find_ppt_slides"
];

export function projectEffectiveCapabilities(input: {
  context: EffectiveAccessContext;
  definitions?: readonly FunctionDefinition[];
}): EffectiveCapabilityProjection {
  const accountLoginAvailable =
    input.context.sourceType === "user" && Boolean(input.context.profile.accountLink);
  if (!input.context.authorized) {
    return emptyProjection(accountLoginAvailable);
  }

  const effectiveNames = new Set(
    getFunctionDefinitions(input.context.profile.enabledFunctions).map(
      (definition) => definition.name
    )
  );
  const definitions = input.definitions ?? CAPABILITY_CATALOG;
  const effectiveDefinitions = definitions.filter(
    (definition) =>
      effectiveNames.has(definition.name) &&
      isAllowedInSource(definition, input.context.sourceType) &&
      (definition.sideEffectLevel === "read" || definition.sideEffectLevel === "write")
  );
  const reads = effectiveDefinitions
    .filter((definition) => definition.sideEffectLevel === "read")
    .map(toPresentation);
  const writes = effectiveDefinitions
    .filter((definition) => definition.sideEffectLevel === "write")
    .map(toPresentation);

  return {
    reads,
    writes,
    onboarding: preferredOnboarding(reads),
    accountLoginAvailable
  };
}

function isAllowedInSource(
  definition: FunctionDefinition,
  sourceType: EffectiveAccessContext["sourceType"]
): boolean {
  return sourceType !== "room" && definition.allowedSources.includes(sourceType);
}

function toPresentation(definition: FunctionDefinition): CapabilityPresentation {
  const example = definition.examples[0] ?? definition.quickReply.command;
  const label = definition.displayName.slice(0, 20);

  return {
    functionName: definition.name,
    displayName: definition.displayName,
    shortDescription: definition.shortDescription,
    example,
    quickReply: {
      label,
      action: {
        type: "message",
        label,
        text: example.slice(0, 300)
      }
    }
  };
}

function preferredOnboarding(reads: CapabilityPresentation[]): CapabilityPresentation[] {
  const byName = new Map(reads.map((presentation) => [presentation.functionName, presentation]));
  const preferred = preferredOnboardingReads.flatMap((name) => {
    const presentation = byName.get(name);
    return presentation ? [presentation] : [];
  });
  const fallback = reads.filter(
    (presentation) => !preferredOnboardingReads.includes(presentation.functionName)
  );

  return [...preferred, ...fallback].slice(0, 3);
}

function emptyProjection(accountLoginAvailable: boolean): EffectiveCapabilityProjection {
  return { reads: [], writes: [], onboarding: [], accountLoginAvailable };
}

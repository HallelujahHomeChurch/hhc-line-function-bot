import { getFunctionDefinition } from "../functions/definitions.js";
import type { SessionStore } from "../state/session-store.js";
import type { FunctionExecutionResult, FunctionName, LineSource } from "../types.js";

const CAPABILITY_RESOLUTION_TTL_MS = 10 * 60 * 1000;
const MAX_ORIGINAL_TEXT = 2_000;
const MAX_CANDIDATES = 5;

export async function createCapabilityResolution(input: {
  sessionStore?: SessionStore;
  id: string;
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  originalText: string;
  candidates: readonly FunctionName[];
  now: Date;
}): Promise<FunctionExecutionResult | undefined> {
  if (!input.sessionStore || !input.requesterUserId) return undefined;
  const candidates = [...new Set(input.candidates)]
    .slice(0, MAX_CANDIDATES)
    .flatMap((capability) => {
      const definition = getFunctionDefinition(capability);
      return definition ? [{ capability, label: definition.displayName }] : [];
    });
  if (candidates.length < 2) return undefined;
  await input.sessionStore.set({
    id: input.id,
    type: "pending_capability_resolution",
    version: 1,
    profileName: input.profileName,
    requesterUserId: input.requesterUserId,
    source: input.source,
    originalText: input.originalText.slice(0, MAX_ORIGINAL_TEXT),
    candidates,
    expiresAt: new Date(input.now.getTime() + CAPABILITY_RESOLUTION_TTL_MS).toISOString()
  });
  return capabilityChoiceReply(candidates);
}

export type CapabilityResolutionResume =
  | { kind: "none" }
  | { kind: "reply"; result: FunctionExecutionResult }
  | { kind: "selected"; capability: FunctionName; originalText: string };

export async function resumeCapabilityResolution(input: {
  sessionStore?: SessionStore;
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  text: string;
  enabledFunctions: readonly FunctionName[];
}): Promise<CapabilityResolutionResume> {
  if (!input.sessionStore || !input.requesterUserId) return { kind: "none" };
  const pending = await input.sessionStore.findPendingCapabilityResolution({
    profileName: input.profileName,
    source: input.source,
    requesterUserId: input.requesterUserId
  });
  if (!pending) return { kind: "none" };
  const answer = input.text.normalize("NFKC").trim();
  if (/^(?:取消|不要|先不要|不用)$/u.test(answer)) {
    await input.sessionStore.delete(pending.id);
    return { kind: "reply", result: { ok: true, replyText: "已取消這次查詢。" } };
  }
  const numeric = /^\d+$/u.test(answer) ? Number.parseInt(answer, 10) - 1 : -1;
  const selected =
    pending.candidates[numeric] ??
    pending.candidates.find(
      ({ capability, label }) => answer === label || answer === capability || answer.includes(label)
    );
  if (!selected) {
    return { kind: "reply", result: capabilityChoiceReply(pending.candidates) };
  }
  await input.sessionStore.delete(pending.id);
  if (!input.enabledFunctions.includes(selected.capability)) {
    return {
      kind: "reply",
      result: { ok: true, replyText: "這項功能目前沒有開放，請重新提出查詢。" }
    };
  }
  return {
    kind: "selected",
    capability: selected.capability,
    originalText: pending.originalText
  };
}

function capabilityChoiceReply(
  candidates: ReadonlyArray<{ capability: FunctionName; label: string }>
): FunctionExecutionResult {
  return {
    ok: true,
    replyText: `你要使用哪一項？${candidates.map(({ label }) => label).join("、")}。`,
    quickReplies: candidates.map(({ label }) => ({
      label,
      action: { type: "message" as const, label, text: label }
    }))
  };
}

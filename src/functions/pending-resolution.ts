import type { ResolutionCandidate } from "../agent/resolution.js";
import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import { messages } from "../messages.js";
import type { SessionStore } from "../state/session-store.js";
import type {
  FunctionHandlerContext,
  FunctionName,
  FunctionRegistry,
  JsonRecord,
  TextMessageHandler
} from "../types.js";

const PENDING_RESOLUTION_TTL_MS = 10 * 60 * 1000;

export async function storePendingResolution(input: {
  sessionStore?: SessionStore;
  requestId: string;
  capability: FunctionName;
  groundedArguments: JsonRecord;
  candidates: ResolutionCandidate[];
  context: FunctionHandlerContext;
  now: Date;
}): Promise<boolean> {
  const requesterUserId = input.context.event.source.userId;
  if (!input.sessionStore || !requesterUserId) return false;
  await input.sessionStore.set({
    id: input.requestId,
    type: "pending_resolution",
    profileName: input.context.profile.name,
    requesterUserId,
    source: input.context.event.source,
    capability: input.capability,
    groundedArguments: input.groundedArguments,
    candidates: input.candidates.map(({ id, domainKey, displayName }) => ({
      id,
      domainKey,
      displayName
    })),
    expiresAt: new Date(input.now.getTime() + PENDING_RESOLUTION_TTL_MS).toISOString()
  });
  return true;
}

export function createPendingResolutionTextMessageHandler(input: {
  sessionStore: SessionStore;
  functions: FunctionRegistry;
}): TextMessageHandler {
  return {
    turnStage: "resolution",
    matches: async (request, context) => {
      const pending = await input.sessionStore.findPendingResolution({
        profileName: context.profile.name,
        source: context.event.source,
        requesterUserId: context.event.source.userId
      });
      if (!pending) return false;
      const switched = buildCapabilityCandidates({
        text: request.text,
        enabledFunctions: context.profile.enabledFunctions,
        source: context.event.source.type === "user" ? "user" : "group",
        knowledgeSources: [],
        maxCandidates: 5
      }).some(
        ({ capability, reason }) =>
          capability !== pending.capability && reason === "explicit_intent"
      );
      if (switched) {
        await input.sessionStore.delete(pending.id);
        return false;
      }
      return true;
    },
    handle: async (request, context) => {
      const pending = await input.sessionStore.findPendingResolution({
        profileName: context.profile.name,
        source: context.event.source,
        requesterUserId: context.event.source.userId
      });
      if (!pending) return undefined;
      const answer = request.text.normalize("NFKC").trim();
      if (/^(?:取消|不要|先不要|不用)$/u.test(answer)) {
        await input.sessionStore.delete(pending.id);
        return { ok: true, replyText: "已取消這次查詢。" };
      }
      const selected = pending.candidates.find(
        (candidate) =>
          answer === candidate.displayName ||
          answer.includes(candidate.displayName.replace(/服事$/u, ""))
      );
      if (!selected) {
        return {
          ok: true,
          replyText: `請選擇：${pending.candidates.map((item) => item.displayName).join("、")}。`,
          quickReplies: pending.candidates.map((item) => ({
            label: item.displayName,
            action: { type: "message" as const, label: item.displayName, text: item.displayName }
          }))
        };
      }
      await input.sessionStore.delete(pending.id);
      if (!context.profile.enabledFunctions.includes(pending.capability)) {
        return { ok: true, replyText: messages.functionNotConfigured };
      }
      const handler = input.functions[pending.capability];
      if (!handler) return { ok: true, replyText: messages.functionNotConfigured };
      const result = await handler(
        { ...pending.groundedArguments, domainKey: selected.domainKey },
        {
          profile: context.profile,
          event: context.event,
          requestId: context.requestId,
          requesterDisplayName: context.requesterDisplayName,
          requesterIsAdmin: context.requesterIsAdmin
        }
      );
      return { ...result, executedAction: pending.capability };
    }
  };
}

import { selectKernelLocalLiveCases } from "./cases.js";
import type { KernelLocalLiveCaseId } from "./contracts.js";
import type { KernelLocalLiveTurn } from "./webhook.js";

export type KernelLocalLiveExpectedOutcome =
  | "execute"
  | "active_task_continuation"
  | "clarify"
  | "explicit_switch"
  | "grounded_follow_up"
  | "requester_isolated"
  | "providers_unavailable"
  | "confirmed_local_write";

export interface KernelLocalLiveJourneyDefinition {
  caseId: KernelLocalLiveCaseId;
  expectedOutcome: KernelLocalLiveExpectedOutcome;
  turns: readonly Readonly<KernelLocalLiveTurn>[];
}

const USER_A = { type: "user" as const, userId: "U_KERNEL_USER_A" };
const GROUP_USER_B = {
  type: "group" as const,
  groupId: "G_KERNEL_GROUP",
  userId: "U_KERNEL_USER_B"
};

export const KERNEL_LOCAL_LIVE_JOURNEYS: readonly Readonly<KernelLocalLiveJourneyDefinition>[] =
  Object.freeze([
    journey("schedule-explicit", "execute", [
      textTurn("schedule-explicit", 0, USER_A, "查 synthetic service 2026-07-27 投影服事")
    ]),
    journey("schedule-refinement", "active_task_continuation", [
      textTurn("schedule-refinement", 0, USER_A, "查 synthetic service 2026-07-27 服事"),
      textTurn("schedule-refinement", 1, USER_A, "只看投影")
    ]),
    journey("schedule-ambiguity", "clarify", [textTurn("schedule-ambiguity", 0, USER_A, "查服事")]),
    journey("capability-switch", "explicit_switch", [
      textTurn("capability-switch", 0, USER_A, "查 synthetic service 2026-07-27 投影服事"),
      textTurn("capability-switch", 1, USER_A, "改查知識 synthetic alpha procedure")
    ]),
    journey("knowledge-follow-up", "grounded_follow_up", [
      textTurn("knowledge-follow-up", 0, USER_A, "查知識 synthetic alpha procedure"),
      textTurn("knowledge-follow-up", 1, USER_A, "那最後由哪個角色驗證？")
    ]),
    journey("group-requester-isolation", "requester_isolated", [
      textTurn("group-requester-isolation", 0, GROUP_USER_B, "只看投影")
    ]),
    journey("provider-unavailable", "providers_unavailable", [
      textTurn("provider-unavailable", 0, USER_A, "查 synthetic service 2026-07-27 Projection 服事")
    ]),
    journey("write-preview-confirm", "confirmed_local_write", [
      fileTurn("write-preview-confirm", 0, USER_A),
      textTurn("write-preview-confirm", 1, USER_A, "是"),
      textTurn("write-preview-confirm", 2, USER_A, "一般資料"),
      textTurn("write-preview-confirm", 3, USER_A, "Synthetic Document"),
      textTurn("write-preview-confirm", 4, USER_A, "保存")
    ])
  ] satisfies KernelLocalLiveJourneyDefinition[]);

export function selectKernelLocalLiveJourneys(
  caseId?: string
): readonly Readonly<KernelLocalLiveJourneyDefinition>[] {
  const selected = new Set(selectKernelLocalLiveCases(caseId).map(({ id }) => id));
  return Object.freeze(
    KERNEL_LOCAL_LIVE_JOURNEYS.filter(({ caseId: candidate }) => selected.has(candidate))
  );
}

function journey(
  caseId: KernelLocalLiveCaseId,
  expectedOutcome: KernelLocalLiveExpectedOutcome,
  turns: KernelLocalLiveTurn[]
): Readonly<KernelLocalLiveJourneyDefinition> {
  return Object.freeze({
    caseId,
    expectedOutcome,
    turns: Object.freeze(turns.map((turn) => Object.freeze(turn)))
  });
}

function textTurn(
  caseId: KernelLocalLiveCaseId,
  turnIndex: number,
  source: KernelLocalLiveTurn["source"],
  text: string
): KernelLocalLiveTurn {
  return {
    caseId,
    turnIndex,
    requesterUserId: source.userId,
    source,
    message: { type: "text", text }
  };
}

function fileTurn(
  caseId: KernelLocalLiveCaseId,
  turnIndex: number,
  source: KernelLocalLiveTurn["source"]
): KernelLocalLiveTurn {
  return {
    caseId,
    turnIndex,
    requesterUserId: source.userId,
    source,
    message: {
      type: "file",
      id: "synthetic-file-1",
      fileName: "synthetic.txt",
      fileSize: 64
    }
  };
}

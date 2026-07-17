import { pathToFileURL } from "node:url";

import type { ActiveTaskContext } from "../agent/active-task.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import {
  buildCapabilityCandidates,
  type KnowledgeSourceMetadata
} from "../agent/capability-candidates.js";
import {
  validateAgentPlan,
  type AgentPlanProposalInput,
  type ValidatedAgentPlan
} from "../agent/plan-validator.js";
import type { AgentPlanDisposition, FunctionName } from "../types.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");

const scheduleTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_schedule",
  allowedCapabilities: ["query_schedule"],
  anchors: { meeting: "晨更", date: "2026-07-14" },
  entities: [
    { type: "meeting", key: "morning-prayer", label: "晨更" },
    { type: "role", key: "front-camera", label: "前攝影", aliases: ["攝影"] },
    { type: "role", key: "rear-camera", label: "後攝影", aliases: ["攝影"] },
    { type: "role", key: "director", label: "導播" },
    { type: "role", key: "sound", label: "音控" }
  ],
  supportedOperations: ["continue", "refine", "advance", "select"],
  createdAt: "2026-07-13T23:59:00.000Z",
  expiresAt: "2026-07-14T00:05:00.000Z"
};

const knowledgeTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_knowledge",
  allowedCapabilities: ["query_knowledge"],
  anchors: {
    sourceId: "source-opaque-1",
    documentId: "document-opaque-1",
    sectionKey: "section-opaque-1"
  },
  references: { documentId: "document-opaque-1", sectionKey: "section-opaque-1" },
  entities: [
    { type: "source", key: "source-opaque-1", label: "知識來源" },
    { type: "document", key: "document-opaque-1", label: "知識文件" },
    { type: "section", key: "section-opaque-1", label: "知識段落" },
    { type: "ordinal", key: "0", label: "第 1 項", aliases: ["第一天"] }
  ],
  supportedOperations: ["continue", "refine", "select"],
  createdAt: "2026-07-13T23:59:00.000Z",
  expiresAt: "2026-07-14T00:05:00.000Z"
};

const expiredKnowledgeTask: ActiveTaskContext = {
  ...knowledgeTask,
  createdAt: "2026-07-13T23:00:00.000Z",
  expiresAt: "2026-07-13T23:05:00.000Z"
};

const retreatMetadata: KnowledgeSourceMetadata = {
  sourceKey: "source-opaque-1",
  displayName: "2026 青年出隊",
  aliases: ["青年出隊"],
  topics: ["第一天", "集合時間"],
  sampleQueries: ["第一天去哪裡"]
};

interface ExpectedProposal {
  status?: "proposed" | "no_plan";
  disposition?: AgentPlanDisposition;
  capability?: FunctionName;
  absentArgumentKeys?: string[];
  arguments?: Record<string, unknown>;
}

interface ExpectedFinal {
  disposition: ValidatedAgentPlan["disposition"];
  capability?: FunctionName;
  reasonCode?: ValidatedAgentPlan["reasonCode"];
  absentArgumentKeys?: string[];
  arguments?: Record<string, unknown>;
}

export interface AgentPlannerEvalCase {
  name: string;
  text: string;
  enabledFunctions: FunctionName[];
  expectedCandidates: FunctionName[];
  expectedProposal: ExpectedProposal;
  expectedFinal: ExpectedFinal;
  activeTask?: ActiveTaskContext;
  knowledgeSources?: KnowledgeSourceMetadata[];
  retrievalEvidence?: FunctionName[];
  requesterIsolation?: {
    task: ActiveTaskContext;
    profileName: string;
    sourceKey: string;
    ownerRequesterUserId: string;
    evaluationRequesterUserId: string;
  };
  offlineOnly?: boolean;
}

function proposed(
  disposition: AgentPlanDisposition,
  capability: FunctionName | undefined,
  argumentsValue: Record<string, unknown>,
  confidence = 0.96
): AgentPlanProposalInput {
  return {
    status: "proposed",
    disposition,
    ...(capability ? { capability } : {}),
    arguments: argumentsValue,
    confidence
  };
}

function noPlan(): AgentPlanProposalInput {
  return { status: "no_plan", reasonCode: "no_candidates" };
}

export const AGENT_PLANNER_EVAL_CASES: AgentPlannerEvalCase[] = [
  {
    name: "acceptance-1-focused-schedule-role",
    text: "幫我查下一場聚會服事的導播",
    enabledFunctions: ["query_schedule"],
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: {
        query: "幫我查下一場聚會服事的導播",
        dateIntent: "next_meeting",
        role: "導播"
      },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: { dateIntent: "next_meeting", role: "導播" }
    }
  },
  {
    name: "acceptance-2-bare-role-follow-up",
    text: "前攝影",
    enabledFunctions: ["query_schedule"],
    activeTask: scheduleTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "continue",
      capability: "query_schedule",
      arguments: { query: "前攝影", role: "前攝影" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "active_task_refinement",
      arguments: { role: "前攝影" }
    }
  },
  {
    name: "acceptance-3-ambiguous-role-follow-up",
    text: "攝影是誰",
    enabledFunctions: ["query_schedule"],
    activeTask: scheduleTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "refine",
      capability: "query_schedule",
      arguments: { query: "攝影是誰", role: "攝影" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "clarify",
      capability: "query_schedule",
      reasonCode: "ambiguous_entity"
    }
  },
  {
    name: "acceptance-4-explicit-now-query-does-not-advance",
    text: "下一場服事表的前攝影是誰",
    enabledFunctions: ["query_schedule"],
    activeTask: scheduleTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: {
        query: "下一場服事表的前攝影是誰",
        dateIntent: "next_meeting",
        role: "前攝影"
      },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "explicit_intent",
      arguments: { dateIntent: "next_meeting", role: "前攝影" }
    }
  },
  {
    name: "acceptance-5-dynamic-knowledge-title",
    text: "第一天去哪裡",
    enabledFunctions: ["query_knowledge"],
    knowledgeSources: [retreatMetadata],
    expectedCandidates: ["query_knowledge"],
    expectedProposal: {
      disposition: "execute",
      capability: "query_knowledge",
      arguments: { query: "第一天去哪裡", ordinal: 0 },
      absentArgumentKeys: ["sourceId", "documentId", "sectionKey"]
    },
    expectedFinal: { disposition: "execute", capability: "query_knowledge" }
  },
  {
    name: "acceptance-6-elliptical-knowledge-follow-up",
    text: "那幾點集合",
    enabledFunctions: ["query_knowledge"],
    activeTask: knowledgeTask,
    expectedCandidates: ["query_knowledge"],
    expectedProposal: {
      disposition: "continue",
      capability: "query_knowledge",
      arguments: { query: "那幾點集合" },
      absentArgumentKeys: ["sourceId", "documentId", "sectionKey"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_knowledge",
      reasonCode: "active_task_refinement"
    }
  },
  {
    name: "acceptance-7-explicit-cross-function-switch",
    text: "那主日音控呢",
    enabledFunctions: ["query_knowledge", "query_schedule"],
    activeTask: knowledgeTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "switch",
      capability: "query_schedule",
      arguments: { query: "那主日音控呢", meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      reasonCode: "explicit_capability_switch",
      arguments: { meeting: "主日", role: "音控" }
    }
  },
  {
    name: "acceptance-8-small-talk-with-active-task",
    text: "最近好累",
    enabledFunctions: ["query_knowledge", "query_schedule"],
    activeTask: knowledgeTask,
    expectedCandidates: [],
    expectedProposal: { status: "no_plan" },
    expectedFinal: { disposition: "chat", reasonCode: "no_capability_evidence" }
  },
  {
    name: "acceptance-9-requester-isolation-no-inherited-task",
    text: "前攝影",
    enabledFunctions: ["query_schedule"],
    requesterIsolation: {
      task: scheduleTask,
      profileName: "helper",
      sourceKey: "group:C1",
      ownerRequesterUserId: "requester-a",
      evaluationRequesterUserId: "requester-b"
    },
    expectedCandidates: [],
    expectedProposal: { status: "no_plan" },
    expectedFinal: { disposition: "chat", reasonCode: "no_capability_evidence" }
  },
  {
    name: "acceptance-10-expired-task-unavailable",
    text: "第一天去哪裡",
    enabledFunctions: ["query_knowledge"],
    activeTask: expiredKnowledgeTask,
    expectedCandidates: ["query_knowledge"],
    expectedProposal: {
      disposition: "continue",
      capability: "query_knowledge",
      arguments: { query: "第一天去哪裡", ordinal: 0 },
      absentArgumentKeys: ["sourceId", "documentId", "sectionKey"]
    },
    expectedFinal: {
      disposition: "clarify",
      capability: "query_knowledge",
      reasonCode: "active_task_unavailable"
    }
  },
  {
    name: "acceptance-11-model-cannot-inject-date",
    text: "查主日服事的音控",
    enabledFunctions: ["query_schedule"],
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: { query: "查主日服事的音控", meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      absentArgumentKeys: ["specificDate"],
      arguments: { meeting: "主日", role: "音控" }
    }
  },
  {
    name: "acceptance-12-write-request-collects-after-planner-clarify",
    text: "幫我記服事表",
    enabledFunctions: ["save_schedule"],
    expectedCandidates: ["save_schedule"],
    expectedProposal: {
      disposition: "clarify",
      capability: "save_schedule",
      arguments: {}
    },
    expectedFinal: {
      disposition: "collect",
      capability: "save_schedule",
      reasonCode: "missing_required_slot",
      arguments: { content: "" }
    }
  },
  {
    name: "acceptance-13-write-request-collects-after-planner-chat",
    text: "記服事表",
    enabledFunctions: ["save_schedule"],
    expectedCandidates: ["save_schedule"],
    expectedProposal: { disposition: "chat", arguments: {} },
    expectedFinal: {
      disposition: "collect",
      capability: "save_schedule",
      reasonCode: "missing_required_slot",
      arguments: { content: "" }
    }
  },
  {
    name: "acceptance-14-write-request-switches-away-from-active-read-task",
    text: "小哈幫我記住服事表",
    enabledFunctions: ["query_schedule", "save_schedule"],
    activeTask: scheduleTask,
    expectedCandidates: ["save_schedule"],
    expectedProposal: {
      disposition: "switch",
      capability: "save_schedule",
      arguments: {}
    },
    expectedFinal: {
      disposition: "collect",
      capability: "save_schedule",
      reasonCode: "missing_required_slot",
      arguments: { content: "" }
    }
  },
  {
    name: "negative-no-capability",
    text: "你好",
    enabledFunctions: ["query_schedule", "query_knowledge"],
    expectedCandidates: [],
    expectedProposal: { status: "no_plan" },
    expectedFinal: { disposition: "chat" }
  },
  {
    name: "disabled-capability",
    text: "查主日服事",
    enabledFunctions: [],
    expectedCandidates: [],
    expectedProposal: { status: "no_plan" },
    expectedFinal: { disposition: "deny", reasonCode: "function_disabled" }
  },
  {
    name: "ambiguous-active-entity",
    text: "攝影是誰",
    enabledFunctions: ["query_schedule"],
    activeTask: scheduleTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "refine",
      capability: "query_schedule",
      arguments: { query: "攝影是誰", role: "攝影" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: { disposition: "clarify", reasonCode: "ambiguous_entity" }
  },
  {
    name: "cross-function-switch",
    text: "那主日音控呢",
    enabledFunctions: ["query_knowledge", "query_schedule"],
    activeTask: knowledgeTask,
    expectedCandidates: ["query_schedule"],
    expectedProposal: {
      disposition: "switch",
      capability: "query_schedule",
      arguments: { query: "那主日音控呢", meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    },
    expectedFinal: {
      disposition: "execute",
      capability: "query_schedule",
      arguments: { meeting: "主日", role: "音控" }
    }
  },
  {
    name: "negative-overreaching-proposal",
    text: "你好",
    enabledFunctions: ["query_schedule"],
    expectedCandidates: [],
    expectedProposal: { status: "no_plan" },
    expectedFinal: { disposition: "deny", reasonCode: "candidate_not_allowed" },
    offlineOnly: true
  }
];

const OFFLINE_PLANNER_FIXTURES: Readonly<Record<string, AgentPlanProposalInput>> = {
  "acceptance-1-focused-schedule-role": proposed("execute", "query_schedule", {
    query: "幫我查下一場聚會服事的導播",
    role: "導播",
    specificDate: "2026-07-21"
  }),
  "acceptance-2-bare-role-follow-up": proposed("continue", "query_schedule", {
    query: "前攝影",
    role: "前攝影"
  }),
  "acceptance-3-ambiguous-role-follow-up": proposed("refine", "query_schedule", {
    query: "攝影是誰",
    role: "攝影"
  }),
  "acceptance-4-explicit-now-query-does-not-advance": proposed("execute", "query_schedule", {
    query: "下一場服事表的前攝影是誰",
    dateIntent: "next_meeting",
    role: "前攝影"
  }),
  "acceptance-5-dynamic-knowledge-title": proposed("execute", "query_knowledge", {
    query: "第一天去哪裡"
  }),
  "acceptance-6-elliptical-knowledge-follow-up": proposed("continue", "query_knowledge", {
    query: "那幾點集合"
  }),
  "acceptance-7-explicit-cross-function-switch": proposed("switch", "query_schedule", {
    query: "那主日音控呢",
    meeting: "晨更",
    role: "導播"
  }),
  "acceptance-8-small-talk-with-active-task": noPlan(),
  "acceptance-9-requester-isolation-no-inherited-task": noPlan(),
  "acceptance-10-expired-task-unavailable": proposed("continue", "query_knowledge", {
    query: "第一天去哪裡"
  }),
  "acceptance-11-model-cannot-inject-date": proposed("execute", "query_schedule", {
    query: "查主日服事的音控",
    meeting: "主日",
    role: "音控",
    specificDate: "2026-07-21"
  }),
  "acceptance-12-write-request-collects-after-planner-clarify": proposed(
    "clarify",
    "save_schedule",
    {}
  ),
  "acceptance-13-write-request-collects-after-planner-chat": proposed("chat", undefined, {}),
  "acceptance-14-write-request-switches-away-from-active-read-task": proposed(
    "switch",
    "save_schedule",
    {}
  ),
  "negative-no-capability": noPlan(),
  "disabled-capability": noPlan(),
  "ambiguous-active-entity": proposed("refine", "query_schedule", {
    query: "攝影是誰",
    role: "攝影"
  }),
  "cross-function-switch": proposed("switch", "query_schedule", {
    query: "那主日音控呢",
    meeting: "主日",
    role: "音控"
  }),
  "negative-overreaching-proposal": proposed("execute", "query_schedule", {
    query: "你好",
    role: "音控"
  })
};

export interface AgentPlannerEvalReport {
  total: number;
  candidateAttempted: number;
  candidatePassed: number;
  proposalAttempted: number;
  proposalPassed: number;
  validatedAttempted: number;
  validatedPassed: number;
  candidateFailures: string[];
  proposalFailures: string[];
  validatedFailures: string[];
}

export async function runOfflineAgentPlannerEval(): Promise<AgentPlannerEvalReport> {
  return evaluateAgentPlannerCases(async (entry) => {
    const proposal = OFFLINE_PLANNER_FIXTURES[entry.name];
    if (!proposal) throw new Error(`missing_offline_fixture:${entry.name}`);
    return proposal;
  });
}

export async function evaluateAgentPlannerCases(
  propose: (
    entry: AgentPlannerEvalCase,
    candidates: ReturnType<typeof buildCapabilityCandidates>
  ) => Promise<AgentPlanProposalInput>,
  cases: readonly AgentPlannerEvalCase[] = AGENT_PLANNER_EVAL_CASES
): Promise<AgentPlannerEvalReport> {
  const candidateFailures: string[] = [];
  const proposalFailures: string[] = [];
  const validatedFailures: string[] = [];
  let candidateAttempted = 0;
  let proposalAttempted = 0;
  let validatedAttempted = 0;
  for (const entry of cases) {
    const resolvedTask = await resolveEvalActiveTask(entry);
    if (!resolvedTask.isolationValid) {
      validatedAttempted += 1;
      validatedFailures.push(`${entry.name}:requester_isolation`);
      continue;
    }
    candidateAttempted += 1;
    const candidates = buildCapabilityCandidates({
      text: entry.text,
      enabledFunctions: entry.enabledFunctions,
      activeTask: resolvedTask.activeTask,
      knowledgeSources: entry.knowledgeSources ?? [],
      retrievalEvidence: entry.retrievalEvidence,
      maxCandidates: 3,
      source: "group"
    });
    if (
      !sameValues(
        candidates.map(({ capability }) => capability),
        entry.expectedCandidates
      )
    ) {
      candidateFailures.push(
        `${entry.name}:candidate_set:${candidates.map(({ capability }) => capability).join(",")}`
      );
      continue;
    }
    const proposal = await propose(entry, candidates);
    proposalAttempted += 1;
    if (!matchesProposal(proposal, entry.expectedProposal)) {
      proposalFailures.push(`${entry.name}:proposal`);
    }
    validatedAttempted += 1;
    const finalPlan = validateAgentPlan({
      text: entry.text,
      enabledFunctions: entry.enabledFunctions,
      candidates,
      proposal,
      activeTask: resolvedTask.activeTask,
      minConfidence: 0.65,
      sourceType: "group",
      now: NOW
    });
    if (!matchesFinal(finalPlan, entry.expectedFinal)) {
      validatedFailures.push(`${entry.name}:validated_plan`);
    }
  }
  return {
    total: cases.length,
    candidateAttempted,
    candidatePassed: candidateAttempted - candidateFailures.length,
    proposalAttempted,
    proposalPassed: proposalAttempted - proposalFailures.length,
    validatedAttempted,
    validatedPassed: validatedAttempted - validatedFailures.length,
    candidateFailures,
    proposalFailures,
    validatedFailures
  };
}

async function resolveEvalActiveTask(entry: AgentPlannerEvalCase): Promise<{
  activeTask?: ActiveTaskContext;
  isolationValid: boolean;
}> {
  if (!entry.requesterIsolation) {
    return { activeTask: entry.activeTask, isolationValid: true };
  }
  const fixture = entry.requesterIsolation;
  const store = new InMemoryConversationWindowStore({ now: () => NOW });
  const ownerScope = {
    profileName: fixture.profileName,
    sourceKey: fixture.sourceKey,
    requesterUserId: fixture.ownerRequesterUserId
  };
  await store.recordActiveTask({ scope: ownerScope, task: fixture.task, ttlMs: 60_000 });
  const ownerTask = await store.activeTask(ownerScope);
  const activeTask = await store.activeTask({
    ...ownerScope,
    requesterUserId: fixture.evaluationRequesterUserId
  });
  return { activeTask, isolationValid: Boolean(ownerTask) && activeTask === undefined };
}

function matchesProposal(proposal: AgentPlanProposalInput, expected: ExpectedProposal): boolean {
  if (expected.status === "no_plan") return proposal.status === "no_plan";
  if (proposal.status === "no_plan") return false;
  if (expected.disposition && proposal.disposition !== expected.disposition) return false;
  if (expected.capability && proposal.capability !== expected.capability) return false;
  const argumentsValue = proposal.arguments ?? {};
  if (
    expected.absentArgumentKeys &&
    !expected.absentArgumentKeys.every((key) => !(key in argumentsValue))
  ) {
    return false;
  }
  return (
    !expected.arguments ||
    Object.entries(expected.arguments).every(([key, value]) => argumentsValue[key] === value)
  );
}

function matchesFinal(plan: ValidatedAgentPlan, expected: ExpectedFinal): boolean {
  if (plan.disposition !== expected.disposition) return false;
  if (expected.capability && !("capability" in plan && plan.capability === expected.capability)) {
    return false;
  }
  if (expected.reasonCode && plan.reasonCode !== expected.reasonCode) return false;
  if (expected.absentArgumentKeys && plan.disposition === "execute") {
    if (!expected.absentArgumentKeys.every((key) => !(key in plan.arguments))) return false;
  }
  if (expected.arguments && plan.disposition === "execute") {
    return Object.entries(expected.arguments).every(
      ([key, value]) => plan.arguments[key] === value
    );
  }
  return true;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function main(): Promise<void> {
  const report = await runOfflineAgentPlannerEval();
  if (report.candidateFailures.length > 0 || report.validatedFailures.length > 0) {
    console.error(
      `Agent planner eval failed: candidates ${report.candidatePassed}/${report.candidateAttempted}, proposal ${report.proposalPassed}/${report.proposalAttempted}, validated ${report.validatedPassed}/${report.validatedAttempted}`
    );
    for (const failure of [
      ...report.candidateFailures,
      ...report.proposalFailures,
      ...report.validatedFailures
    ]) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Agent planner eval passed: candidates ${report.candidatePassed}/${report.candidateAttempted}, proposal ${report.proposalPassed}/${report.proposalAttempted}, validated ${report.validatedPassed}/${report.validatedAttempted}`
  );
  for (const failure of report.proposalFailures) console.warn(`- ${failure}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

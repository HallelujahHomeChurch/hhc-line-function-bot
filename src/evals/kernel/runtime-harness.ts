import type { AgentPlanner } from "../../agent/planner.js";
import type { AgentResultStatus } from "../../agent/result-envelope.js";
import { createControlledAgentRouter } from "../../agent/controlled-agent-router.js";
import {
  InMemoryConversationWindowStore,
  type ConversationWindowStore
} from "../../agent/context-manager.js";
import { InMemoryAgentTraceStore, type AgentTurnTraceRecord } from "../../agent/trace-store.js";
import { createAgentTurnRuntime } from "../../agent/turn-runtime.js";
import { MemoryInFlightStore } from "../../in-flight/in-flight-store.js";
import { InMemoryLastErrorStore } from "../../observability/last-error-store.js";
import { InMemoryLastRouteStore } from "../../observability/last-route-store.js";
import { InMemorySessionStore, type SessionStore } from "../../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionRegistry,
  LineEvent,
  TextMessageHandlerRegistry
} from "../../types.js";

export interface KernelTurnInput {
  text: string;
  requesterUserId: string;
  requestId: string;
}

export interface KernelTurnResult {
  replyText?: string;
  quickReplyLabels: string[];
  resultStatus?: AgentResultStatus;
  trace: AgentTurnTraceRecord[];
  elapsedMs: number;
}

export interface KernelRuntimeHarness {
  runTurns(turns: readonly KernelTurnInput[]): Promise<KernelTurnResult[]>;
}

export interface KernelRuntimeHarnessOptions {
  now: () => Date;
  profile: BotProfileConfig;
  functionRegistry: FunctionRegistry;
  textMessageHandlers?: TextMessageHandlerRegistry;
  planner: AgentPlanner;
  sessionStore?: SessionStore;
  conversationWindowStore?: ConversationWindowStore;
  elapsedMs?: (turnIndex: number) => number;
}

export function createKernelRuntimeHarness(
  options: KernelRuntimeHarnessOptions
): KernelRuntimeHarness {
  const traceStore = new InMemoryAgentTraceStore(100);
  const sessionStore = options.sessionStore ?? new InMemorySessionStore();
  const conversationWindowStore =
    options.conversationWindowStore ?? new InMemoryConversationWindowStore({ now: options.now });
  const runtime = createAgentTurnRuntime({
    functionRegistry: options.functionRegistry,
    textMessageHandlers: options.textMessageHandlers ?? {},
    inFlightStore: new MemoryInFlightStore(),
    sessionStore,
    conversationWindowStore,
    controlledAgentRouter: createControlledAgentRouter({
      planner: options.planner,
      now: options.now
    }),
    traceStore,
    lastErrorStore: new InMemoryLastErrorStore(20),
    lastRouteStore: new InMemoryLastRouteStore(20),
    now: options.now,
    timeZone: "Asia/Taipei"
  });

  return {
    async runTurns(turns): Promise<KernelTurnResult[]> {
      const results: KernelTurnResult[] = [];
      for (const [index, turn] of turns.entries()) {
        const startedAt = performance.now();
        const result = await runtime.handleTextTurn({
          profile: options.profile,
          event: groupTextEvent(turn.text, turn.requesterUserId),
          requestId: turn.requestId
        });
        const measuredElapsedMs = Math.max(0, performance.now() - startedAt);
        results.push({
          replyText: result?.replyText,
          quickReplyLabels: result?.quickReplies?.map(({ label }) => label) ?? [],
          resultStatus: result?.agentResult?.status,
          trace: await traceStore.list(1),
          elapsedMs: options.elapsedMs?.(index) ?? measuredElapsedMs
        });
      }
      return results;
    }
  };
}

function groupTextEvent(text: string, userId: string): LineEvent {
  return {
    type: "message",
    replyToken: "synthetic-reply-token",
    source: { type: "group", groupId: "G_SYNTHETIC", userId },
    message: { type: "text", text }
  };
}

import { createAgentPlanner } from "../../agent/planner.js";
import { createControlledAgentRouter } from "../../agent/controlled-agent-router.js";
import { createQueryScheduleModule } from "../../capabilities/query-schedule/module.js";
import type { EmbeddingClient } from "../../clients/embedding.js";
import {
  KERNEL_LOCAL_LIVE_CASE_IDS,
  type KernelLocalLiveCaseId
} from "../../evals/kernel/local-live/contracts.js";
import { createFunctionRegistries, type RegistryClients } from "../../functions/registry.js";
import { FUNCTION_MODULES } from "../../functions/modules.js";
import { listKnowledgeRoutingMetadata } from "../../knowledge/routing-metadata.js";
import { createProfileAwareProvider } from "../../llm/provider-runtime.js";
import type { AppConfig, ChatProvider, TextGenerationProvider } from "../../types.js";
import { createTestApp, type TestAppDependencies } from "../create-test-app.js";
import type { KernelLocalLiveCaseContext } from "./provider-clients.js";

const ACCEPTANCE_FUNCTIONS = new Set(["query_schedule", "query_knowledge", "save_resource"]);

export interface KernelLocalLiveAppOptions {
  config: AppConfig;
  deepSeek: ChatProvider & TextGenerationProvider;
  embedding: EmbeddingClient;
  caseContext: KernelLocalLiveCaseContext;
  registryClients: RegistryClients;
  appDependencies: TestAppDependencies;
}

export function createKernelLocalLiveApp(options: KernelLocalLiveAppOptions) {
  const primary = createProfileAwareProvider({
    config: options.config,
    providers: { deepseek: options.deepSeek },
    role: "primary",
    lane: "function_routing"
  });
  const planner = createAgentPlanner({ primary });
  const controlledAgentRouter = createControlledAgentRouter({
    planner,
    knowledgeMetadata: {
      list(profileName, limit) {
        return listKnowledgeRoutingMetadata(
          options.registryClients.knowledgeStore,
          profileName,
          limit
        );
      }
    }
  });
  const localGroundedTextGenerator: TextGenerationProvider = {
    providerName: "deepseek",
    async completeText() {
      return "合成知識結果";
    }
  };
  const modules = FUNCTION_MODULES.filter(({ name }) => ACCEPTANCE_FUNCTIONS.has(name)).map(
    (module) =>
      module.name === "query_schedule"
        ? createQueryScheduleModule({
            memoryStore: options.registryClients.memoryStore,
            scheduleStore: options.registryClients.scheduleStore,
            notion: undefined,
            timeZone: options.config.timeZone,
            sessionStore: options.registryClients.sessionStore,
            now: options.registryClients.now,
            requestIdFactory: options.registryClients.requestIdFactory
          })
        : module
  );
  const registries = createFunctionRegistries(
    options.config,
    {
      ...options.registryClients,
      embedding: options.embedding,
      knowledgeTextGenerator: localGroundedTextGenerator
    },
    modules
  );

  const app = createTestApp(options.config, {
    ...options.appDependencies,
    functionRegistry: registries.functions,
    textMessageHandlers: registries.textMessages,
    postbackHandlers: registries.postbacks,
    adminHandlers: registries.adminHandlers,
    controlledAgentRouter,
    textGenerator: localGroundedTextGenerator,
    textFallbackGenerator: localGroundedTextGenerator
  });
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.url !== "/api/line/webhook/acceptance") {
      done();
      return;
    }
    const eventContext = kernelLocalLiveEventContextFromBody(request.body);
    if (!eventContext) {
      done(new Error("kernel_local_live_event_case_invalid"));
      return;
    }
    options.caseContext.run(eventContext.caseId, done, eventContext.turnIndex);
  });
  return app;
}

export function kernelLocalLiveCaseIdFromBody(body: unknown): KernelLocalLiveCaseId | undefined {
  return kernelLocalLiveEventContextFromBody(body)?.caseId;
}

export function kernelLocalLiveEventContextFromBody(
  body: unknown
): { caseId: KernelLocalLiveCaseId; turnIndex: number } | undefined {
  let parsed = body;
  if (Buffer.isBuffer(body) || typeof body === "string") {
    try {
      parsed = JSON.parse(body.toString());
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length !== 1) return undefined;
  const eventId = (events[0] as { webhookEventId?: unknown } | undefined)?.webhookEventId;
  if (typeof eventId !== "string") return undefined;
  const caseId = KERNEL_LOCAL_LIVE_CASE_IDS.find((candidate) =>
    eventId.startsWith(`${candidate}:`)
  );
  if (!caseId) return undefined;
  const match = new RegExp(`^${caseId}:turn-(\\d+)$`, "u").exec(eventId);
  const ordinal = Number(match?.[1]);
  return Number.isInteger(ordinal) && ordinal > 0 ? { caseId, turnIndex: ordinal - 1 } : undefined;
}

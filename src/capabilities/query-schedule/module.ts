import type { FunctionModule, FunctionModuleRegistrations } from "../../functions/modules.js";
import { queryScheduleDefinition } from "./definition.js";
import { queryScheduleRouterEvalCases } from "./eval-cases.js";
import { createQueryScheduleHandler } from "./handler.js";
import type { QueryScheduleDependencies } from "./ports.js";

export function createQueryScheduleModule(dependencies: QueryScheduleDependencies): FunctionModule {
  return {
    name: "query_schedule",
    definition: queryScheduleDefinition,
    routerEvalCases: queryScheduleRouterEvalCases,
    register: () => registrations(dependencies)
  };
}

export const queryScheduleModule: FunctionModule = {
  name: "query_schedule",
  definition: queryScheduleDefinition,
  routerEvalCases: queryScheduleRouterEvalCases,
  register: ({ config, clients }) => {
    if (!clients.memoryStore) return {};
    return registrations({
      memoryStore: clients.memoryStore,
      scheduleStore: clients.scheduleStore,
      notion: clients.notion,
      databaseId: config.notion?.databaseId,
      properties: config.notion?.properties,
      timeZone: config.timeZone,
      sessionStore: clients.sessionStore,
      now: clients.now,
      requestIdFactory: clients.requestIdFactory
    });
  }
};

function registrations(dependencies: QueryScheduleDependencies): FunctionModuleRegistrations {
  return {
    functions: {
      query_schedule: createQueryScheduleHandler(dependencies)
    }
  };
}

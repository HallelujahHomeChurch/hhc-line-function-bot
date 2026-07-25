import type {
  FunctionModule,
  FunctionModuleRegistrations
} from "../../application/contracts/function-module.js";
import { queryScheduleDefinition } from "./definition.js";
import { queryScheduleRouterEvalCases } from "./eval-cases.js";
import { createQueryScheduleHandler } from "./handler.js";
import type { QueryScheduleDependencies } from "./ports.js";

export function createQueryScheduleModule(dependencies: QueryScheduleDependencies): FunctionModule {
  if (!dependencies.memoryStore) {
    throw new Error("query_schedule requires memoryStore");
  }
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
    const typedClients = clients as unknown as QueryScheduleDependencies;
    if (!typedClients.memoryStore) return {};
    return registrations({
      memoryStore: typedClients.memoryStore,
      scheduleStore: typedClients.scheduleStore,
      notion: typedClients.notion,
      databaseId: config.notion?.databaseId,
      properties: config.notion?.properties,
      timeZone: config.timeZone,
      sessionStore: typedClients.sessionStore,
      now: typedClients.now,
      requestIdFactory: typedClients.requestIdFactory
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

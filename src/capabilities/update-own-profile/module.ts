import type { FunctionModule } from "../../application/contracts/function-module.js";
import { updateOwnProfileDefinition } from "./definition.js";
import { updateOwnProfileRouterEvalCases } from "./eval-cases.js";
import { createUpdateOwnProfileHandler } from "./handler.js";

export const updateOwnProfileModule: FunctionModule = {
  name: "update_own_profile",
  definition: updateOwnProfileDefinition,
  routerEvalCases: updateOwnProfileRouterEvalCases,
  register: ({ clients }) =>
    clients.accountAdminClient
      ? {
          functions: {
            update_own_profile: createUpdateOwnProfileHandler({
              accountClient: clients.accountAdminClient,
              sessionStore: clients.sessionStore,
              now: clients.now,
              requestIdFactory: clients.requestIdFactory
            })
          }
        }
      : {}
};

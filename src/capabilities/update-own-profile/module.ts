import { randomUUID } from "node:crypto";

import type { FunctionModule } from "../../application/contracts/function-module.js";
import { createSlotClarificationResult } from "../../agent/slot-clarification.js";
import type { SessionStore } from "../../state/session-store.js";
import type { TextMessageHandler } from "../../types.js";
import { updateOwnProfileDefinition } from "./definition.js";
import { createUpdateOwnProfileHandler } from "./handler.js";

export const updateOwnProfileModule: FunctionModule = {
  name: "update_own_profile",
  definition: updateOwnProfileDefinition,
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
          },
          textMessages: {
            main_update_own_profile: createUpdateOwnProfileTextMessageHandler({
              sessionStore: clients.sessionStore,
              now: clients.now,
              requestIdFactory: clients.requestIdFactory
            })
          }
        }
      : {}
};

export function createUpdateOwnProfileTextMessageHandler(options: {
  sessionStore: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}): TextMessageHandler {
  return {
    turnStage: "pre_route_recall",
    capability: "update_own_profile",
    matches: ({ text }, { profile, event }) =>
      profile.name === "main" &&
      event.source.type === "user" &&
      profile.enabledFunctions.includes("update_own_profile") &&
      /^(?:\/profile|修改個人資料|修改姓名|更新姓名)$/u.test(text.normalize("NFKC").trim()),
    handle: (_request, context) =>
      createSlotClarificationResult({
        sessionStore: options.sessionStore,
        action: "update_own_profile",
        arguments: {},
        context,
        requestId: context.requestId ?? options.requestIdFactory?.() ?? randomUUID(),
        now: options.now?.() ?? new Date()
      })
  };
}

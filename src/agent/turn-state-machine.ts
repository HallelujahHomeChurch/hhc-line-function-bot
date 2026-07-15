import type {
  ControlledTurnStage,
  FunctionExecutionResult,
  TextMessageHandler,
  TextMessageHandlerRegistry
} from "../types.js";

export type TurnDecision =
  | { type: "reply"; result: FunctionExecutionResult }
  | { type: "pending_function" }
  | { type: "resolve" }
  | { type: "attachment" }
  | { type: "plan" }
  | { type: "deny"; reason: string };

export interface OrderedTurnHandler {
  name: string;
  handler: TextMessageHandler;
}

const STAGE_ORDER: Record<ControlledTurnStage, number> = {
  pending_function: 10,
  resolution: 20,
  attachment: 30,
  pre_route_recall: 40
};

export function orderTurnHandlers(registry: TextMessageHandlerRegistry): OrderedTurnHandler[] {
  return Object.entries(registry)
    .map(([name, handler], registrationOrder) => ({ name, handler, registrationOrder }))
    .sort(
      (left, right) =>
        STAGE_ORDER[left.handler.turnStage] - STAGE_ORDER[right.handler.turnStage] ||
        left.registrationOrder - right.registrationOrder
    )
    .map(({ name, handler }) => ({ name, handler }));
}

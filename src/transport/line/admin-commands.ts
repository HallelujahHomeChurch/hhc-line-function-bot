import type { LastErrorStore } from "../../observability/last-error-store.js";
import { messages } from "../../messages.js";
import type { FunctionExecutionResult, RouteObserver, RouteObserverEvent } from "../../types.js";
import type { LineCommandHandler, LineCommandTransportContext } from "./contracts.js";

export async function runAdminCommand(input: {
  context: LineCommandTransportContext;
  command: string | undefined;
  handler: LineCommandHandler;
  lastErrorStore: LastErrorStore;
  routeObserver?: RouteObserver;
  isAuthorized(): Promise<boolean>;
  elapsedMs(): number;
}): Promise<FunctionExecutionResult> {
  let result: FunctionExecutionResult;
  try {
    result = await input.handler(input.context);
  } catch (error) {
    await input.lastErrorStore.record({
      requestId: input.context.requestId,
      occurredAt: new Date().toISOString(),
      profileName: input.context.profile.name,
      sourceType: input.context.event.source.type,
      phase: "admin",
      command: input.command,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error)
    });
    result = { ok: false, replyText: messages.requestFailed };
  }
  await emitRouteEvent(input.routeObserver, {
    kind: "admin_command",
    profileName: input.context.profile.name,
    sourceType: input.context.event.source.type,
    requestId: input.context.requestId,
    command: input.command ?? "unknown",
    authorized: await input.isAuthorized(),
    ok: result.ok,
    durationMs: input.elapsedMs()
  });
  return result;
}

async function emitRouteEvent(
  observer: RouteObserver | undefined,
  event: RouteObserverEvent
): Promise<void> {
  if (!observer) return;
  await observer(event);
}

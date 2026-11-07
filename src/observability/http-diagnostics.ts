import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

type Correlation = { requestId: string; traceId: string; spanId: string; flags: string };
const current = new AsyncLocalStorage<Correlation>();
const responses = new WeakMap<Response, { context: Correlation; started: number }>();
const id = (bytes: number) => randomBytes(bytes).toString("hex");
const validID = (value: string, length: number) =>
  value.length === length && /^[a-f0-9]+$/u.test(value) && !/^0+$/u.test(value);

export function transportCorrelation(
  headers: Record<string, string | string[] | undefined>
): Correlation {
  const request = headers["x-hhc-request-id"];
  const parent = headers.traceparent;
  const validParent =
    typeof parent === "string" &&
    /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/u.test(parent) &&
    validID(parent.slice(3, 35), 32) &&
    validID(parent.slice(36, 52), 16);
  return {
    requestId: typeof request === "string" && validID(request, 32) ? request : id(16),
    traceId: validParent ? parent.slice(3, 35) : id(16),
    spanId: id(8),
    flags: validParent ? parent.slice(53) : "00"
  };
}

function outcome(
  context: Correlation,
  phase: "server" | "client_headers" | "client_body",
  status: number,
  started: number,
  failed = false
): void {
  const duration = Math.max(0, Math.round(performance.now() - started));
  if (!failed && status < 400 && duration < 2_000) return;
  console.error(
    JSON.stringify({
      event: "http_diagnostic",
      phase,
      status,
      duration_ms: duration,
      outcome: failed || status >= 400 ? "failed" : "slow",
      request_id: context.requestId,
      trace_id: context.traceId,
      span_id: context.spanId
    })
  );
}

export function registerHTTPDiagnostics(app: FastifyInstance): void {
  const requests = new WeakMap<object, { context: Correlation; started: number }>();
  app.addHook("onRequest", (request, reply, done) => {
    const context = transportCorrelation(request.headers);
    requests.set(request, { context, started: performance.now() });
    reply.header("X-HHC-Request-ID", context.requestId);
    current.run(context, done);
  });
  app.addHook("onResponse", (request, reply, done) => {
    const state = requests.get(request);
    if (state) outcome(state.context, "server", reply.statusCode, state.started);
    done();
  });
  app.addHook("onRequestAbort", (request, done) => {
    const state = requests.get(request);
    if (state) outcome(state.context, "server", 0, state.started, true);
    done();
  });
}

// Call only for fixed internal API origins, never signed uploads or providers.
export function internalDiagnosticFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const parent = current.getStore() ?? transportCorrelation({});
    const context = { ...parent, spanId: id(8) };
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("traceparent", `00-${context.traceId}-${context.spanId}-${context.flags}`);
    if (!headers.has("x-hhc-request-id")) headers.set("x-hhc-request-id", context.requestId);
    headers.delete("baggage");
    headers.delete("tracestate");
    const started = performance.now();
    try {
      const response = await fetcher(input, { ...init, headers: Object.fromEntries(headers) });
      outcome(context, "client_headers", response.status, started);
      responses.set(response, { context, started: performance.now() });
      return response;
    } catch (error) {
      outcome(context, "client_headers", 0, started, true);
      throw error;
    }
  };
}

export async function readDiagnosticJSON(response: Response): Promise<unknown> {
  const state = responses.get(response);
  try {
    const value: unknown = await response.json();
    if (state) outcome(state.context, "client_body", 0, state.started);
    return value;
  } catch (error) {
    if (state) outcome(state.context, "client_body", 0, state.started, true);
    throw error;
  }
}

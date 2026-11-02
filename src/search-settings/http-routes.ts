import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { searchSettingsInput, type SearchSettingsStore } from "./contracts.js";

export function registerSearchSettingsRoutes(
  app: FastifyInstance,
  deps: {
    store: SearchSettingsStore;
    gatewayCallerAppId: string;
    appApiToken: string;
    authorize(userId: string, requestId: string): Promise<boolean>;
  }
) {
  const path = "/api/line/search-settings";
  app.route({
    method: ["GET", "PATCH"],
    url: path,
    bodyLimit: 2048,
    async handler(request, reply) {
      reply.header("cache-control", "private, no-store");
      reply.header("x-hhc-request-id", request.id);
      const deny = (status: number, error: string) => reply.code(status).send({ error });
      const token = request.headers["dapr-api-token"];
      if (
        request.headers["dapr-caller-app-id"] !== deps.gatewayCallerAppId ||
        typeof token !== "string" ||
        !deps.appApiToken ||
        Buffer.byteLength(token) !== Buffer.byteLength(deps.appApiToken) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(deps.appApiToken))
      )
        return deny(403, "forbidden");
      const actor = request.headers["x-hhc-user-id"];
      if (
        typeof actor !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(actor)
      )
        return deny(401, "unauthorized");
      try {
        if (!(await deps.authorize(actor, request.id))) return deny(403, "forbidden");
      } catch {
        return deny(503, "permission_service_unavailable");
      }
      if (Object.keys(request.query as object).length) return deny(400, "invalid_request");
      if (request.method === "GET") {
        try {
          return { settings: await deps.store.get(), history: await deps.store.history() };
        } catch {
          return deny(503, "search_settings_unavailable");
        }
      }
      let body: unknown;
      try {
        body = Buffer.isBuffer(request.body)
          ? JSON.parse(request.body.toString("utf8"))
          : request.body;
      } catch {
        return deny(400, "invalid_request");
      }
      const parsed = searchSettingsInput.safeParse(body);
      if (!parsed.success) return deny(400, "invalid_request");
      try {
        const settings = await deps.store.update(parsed.data, actor);
        return settings ? { settings } : deny(409, "settings_changed");
      } catch {
        return deny(503, "search_settings_unavailable");
      }
    }
  });
}

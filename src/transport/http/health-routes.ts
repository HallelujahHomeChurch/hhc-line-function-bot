import type { FastifyInstance } from "fastify";

import type { AppConfig, AppDiagnostics } from "../../types.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  config: Pick<AppConfig, "healthPath" | "readyPath" | "serviceName">,
  diagnostics: AppDiagnostics
): void {
  app.get(config.healthPath, async () => ({
    ok: true,
    service: config.serviceName,
    timestamp: new Date().toISOString()
  }));

  app.get(config.readyPath ?? "/readyz", async (_request, reply) => {
    const readiness = await diagnostics.checkPublicReadiness();
    return reply.code(readiness.status === "ok" ? 200 : 503).send(readiness);
  });
}

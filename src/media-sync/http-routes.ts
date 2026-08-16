import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccountAdminClient } from "../account/account-admin-client.js";
import { MediaSyncManagementError, type MediaSyncManagementService } from "./service.js";

type MediaSyncRouteDependencies = {
  gatewayCallerAppId: string;
  appApiToken: string;
  requestIdFactory: () => string;
  accountAdminClient: AccountAdminClient;
  service: MediaSyncManagementService;
};

type MediaSyncAuth = { userId: string; requestId: string };
type AuthenticatedRequest = FastifyRequest & { mediaSyncAuth?: MediaSyncAuth };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function registerMediaSyncRoutes(
  app: FastifyInstance,
  deps: MediaSyncRouteDependencies
): void {
  const authorize = async (request: AuthenticatedRequest, reply: FastifyReply) => {
    let requestId = deps.requestIdFactory();
    reply.header("x-hhc-request-id", requestId);
    const caller = header(request, "dapr-caller-app-id")?.trim();
    const token = header(request, "dapr-api-token");
    if (caller !== deps.gatewayCallerAppId || !sameToken(token, deps.appApiToken)) {
      return sendError(reply, 403, "forbidden");
    }

    const userId = header(request, "x-hhc-user-id");
    const incomingRequestId = header(request, "x-hhc-request-id");
    if (!userId || userId.trim() !== userId || !uuidPattern.test(userId)) {
      return sendError(reply, 401, "unauthorized");
    }
    if (validRequestId(incomingRequestId)) requestId = incomingRequestId;
    reply.header("x-hhc-request-id", requestId);

    let allowed: boolean;
    try {
      allowed = await deps.accountAdminClient.verifyPermission({ userId, requestId });
    } catch {
      return sendError(reply, 503, "permission_service_unavailable");
    }
    if (!allowed) return sendError(reply, 403, "forbidden");
    request.mediaSyncAuth = { userId, requestId };
  };

  app.get("/api/line/media-sync/collections", { preHandler: authorize }, async (request, reply) => {
    const auth = requireAuth(request);
    const query = parseListQuery(request.query);
    if (!query || !hasNoBody(request.body)) return sendError(reply, 400, "invalid_request");
    return run(reply, () => deps.service.listCollections(query, auth.requestId));
  });

  app.post(
    "/api/line/media-sync/collections",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["name"]);
      const name = body && validName(body.name) ? body.name.trim() : undefined;
      if (!key || !name) return sendError(reply, 400, "invalid_request");
      return run(reply, () => deps.service.createCollection(name, key, auth.requestId), 201);
    }
  );

  app.patch<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["name"]);
      const name = body && validName(body.name) ? body.name.trim() : undefined;
      if (!validOpaqueId(request.params.collectionId) || !key || !name) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.renameCollection(request.params.collectionId, name, key, auth.requestId)
      );
    }
  );

  app.delete<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      if (!validOpaqueId(request.params.collectionId) || !key || !hasNoBody(request.body)) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.deleteCollection(request.params.collectionId, key, auth.requestId)
      );
    }
  );

  app.post<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/acl",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["subjectType", "subjectId"]);
      if (
        !validOpaqueId(request.params.collectionId) ||
        !key ||
        !body ||
        (body.subjectType !== "user" && body.subjectType !== "role") ||
        !validSubjectId(body.subjectType, body.subjectId)
      ) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(
        reply,
        () =>
          deps.service.addCollectionAcl(
            request.params.collectionId,
            {
              subjectType: body.subjectType as "user" | "role",
              subjectId: body.subjectId as string
            },
            key,
            auth.requestId
          ),
        201
      );
    }
  );

  app.delete<{ Params: { collectionId: string; aclId: string } }>(
    "/api/line/media-sync/collections/:collectionId/acl/:aclId",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      if (
        !validOpaqueId(request.params.collectionId) ||
        !validOpaqueId(request.params.aclId) ||
        !key ||
        !hasNoBody(request.body)
      ) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.revokeCollectionAcl(
          request.params.collectionId,
          request.params.aclId,
          key,
          auth.requestId
        )
      );
    }
  );

  app.post<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/binding-code",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, []);
      if (!validOpaqueId(request.params.collectionId) || !key || !body) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(
        reply,
        () =>
          deps.service.createBindingCode(request.params.collectionId, auth.userId, auth.requestId),
        201
      );
    }
  );

  app.delete<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/binding",
    { preHandler: authorize },
    async (request, reply) => {
      const key = idempotencyKey(request);
      if (!validOpaqueId(request.params.collectionId) || !key || !hasNoBody(request.body)) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () => deps.service.unbind(request.params.collectionId));
    }
  );
}

function sameToken(got: string | undefined, want: string): boolean {
  if (!got || !want) return false;
  return timingSafeEqual(hash(got), hash(want));
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function requireAuth(request: FastifyRequest): MediaSyncAuth {
  const auth = (request as AuthenticatedRequest).mediaSyncAuth;
  if (!auth) throw new Error("media_sync_auth_missing");
  return auth;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = header(request, "idempotency-key");
  if (!raw || Buffer.byteLength(raw, "utf8") > 128) return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function strictObject(body: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!Buffer.isBuffer(body)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const actual = Object.keys(parsed);
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function hasNoBody(body: unknown): boolean {
  return body === undefined || (Buffer.isBuffer(body) && body.length === 0);
}

function parseListQuery(value: unknown): { cursor?: string; limit?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => key !== "cursor" && key !== "limit")) return undefined;
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== "string" || !query.cursor || Buffer.byteLength(query.cursor) > 2048)
  ) {
    return undefined;
  }
  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^[1-9]\d*$/u.test(query.limit)) return undefined;
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit > 100) return undefined;
  }
  return {
    ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
    ...(limit === undefined ? {} : { limit })
  };
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value.trim(), "utf8") <= 120 &&
    !hasControl(value)
  );
}

function validOpaqueId(value: string): boolean {
  return (
    value.trim() !== "" &&
    value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    !hasControl(value)
  );
}

function validSubjectId(subjectType: "user" | "role", value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    validOpaqueId(value) &&
    (subjectType === "role" || uuidPattern.test(value))
  );
}

function validRequestId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value !== "" &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    !hasControl(value)
  );
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

async function run(reply: FastifyReply, operation: () => Promise<unknown>, successStatus = 200) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    if (
      error instanceof MediaSyncManagementError ||
      errorMessage(error) === "media_sync_binding_code_active"
    ) {
      return sendError(reply, 409, "conflict");
    }
    const status = assetStatus(error);
    if (status)
      return sendError(reply, status, status === 404 ? "not_found" : "asset_request_failed");
    return sendError(reply, 503, "service_unavailable");
  }
}

function assetStatus(error: unknown): number | undefined {
  const match = /^asset_api_(\d{3})$/u.exec(errorMessage(error));
  if (!match) return undefined;
  const status = Number(match[1]);
  if ([400, 403, 404, 409].includes(status)) return status;
  return status === 408 || status === 429 || status >= 500 ? 503 : 502;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ ok: false, error });
}

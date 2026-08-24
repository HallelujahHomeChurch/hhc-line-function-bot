import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccountAdminClient } from "../account/account-admin-client.js";
import { AccountApiError } from "../account/account-admin-client.js";
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

  app.get(
    "/api/line/media-sync/acl-subjects",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const query = parseAclSubjectQuery(request.query);
      if (!query || !hasNoBody(request.body)) return sendError(reply, 400, "invalid_request");
      const search = deps.accountAdminClient.searchMediaSyncAclSubjects;
      if (!search) return sendError(reply, 503, "subject_service_unavailable");
      try {
        return reply.send(
          await search.call(deps.accountAdminClient, {
            requestingUserId: auth.userId,
            ...query,
            requestId: auth.requestId
          })
        );
      } catch (error) {
        if (error instanceof AccountApiError && error.message === "account_api_http_403") {
          return sendError(reply, 403, "forbidden");
        }
        return sendError(reply, 503, "subject_service_unavailable");
      }
    }
  );

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

  app.get<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/items",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const query = parseManagedItemListQuery(request.query);
      if (!validOpaqueId(request.params.collectionId) || !query || !hasNoBody(request.body)) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.listCollectionItems(request.params.collectionId, query, auth.requestId)
      );
    }
  );

  app.patch<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/retention",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["retentionDays"]);
      const retentionDays = body?.retentionDays;
      if (
        !validOpaqueId(request.params.collectionId) ||
        !key ||
        !validRetentionDays(retentionDays)
      ) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.updateCollectionRetention(
          request.params.collectionId,
          retentionDays,
          key,
          auth.requestId
        )
      );
    }
  );

  app.patch<{ Params: { collectionId: string; itemId: string } }>(
    "/api/line/media-sync/collections/:collectionId/items/:itemId",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["displayName"]);
      const displayName =
        typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
      if (
        !validOpaqueId(request.params.collectionId) ||
        !validOpaqueId(request.params.itemId) ||
        !key ||
        !validItemDisplayName(displayName)
      ) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.renameCollectionItem(
          request.params.collectionId,
          request.params.itemId,
          displayName,
          key,
          auth.requestId
        )
      );
    }
  );

  app.post<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/items/retention",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["itemIds", "retentionExempt"]);
      const itemIds = body?.itemIds;
      const retentionExempt = body?.retentionExempt;
      if (
        !validOpaqueId(request.params.collectionId) ||
        !key ||
        !validItemIds(itemIds) ||
        typeof retentionExempt !== "boolean"
      ) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.setCollectionItemsRetention(
          request.params.collectionId,
          { itemIds, retentionExempt },
          key,
          auth.requestId
        )
      );
    }
  );

  app.post<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/items/delete",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const key = idempotencyKey(request);
      const body = strictObject(request.body, ["itemIds"]);
      const itemIds = body?.itemIds;
      if (!validOpaqueId(request.params.collectionId) || !key || !validItemIds(itemIds)) {
        return sendError(reply, 400, "invalid_request");
      }
      return run(reply, () =>
        deps.service.deleteCollectionItems(
          request.params.collectionId,
          itemIds,
          key,
          auth.requestId
        )
      );
    }
  );

  app.post<{ Params: { collectionId: string } }>(
    "/api/line/media-sync/collections/:collectionId/items/content-tickets",
    { preHandler: authorize },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = strictObject(request.body, ["itemIds"]);
      const itemIds = body?.itemIds;
      if (!validOpaqueId(request.params.collectionId) || !validItemIds(itemIds)) {
        return sendError(reply, 400, "invalid_request");
      }
      reply.header("cache-control", "private, no-store");
      reply.header("referrer-policy", "no-referrer");
      return run(
        reply,
        () =>
          deps.service.issueCollectionItemTickets(
            request.params.collectionId,
            itemIds,
            auth.requestId
          ),
        201
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
      const search = deps.accountAdminClient.searchMediaSyncAclSubjects;
      if (!search) return sendError(reply, 503, "subject_service_unavailable");
      try {
        const result = await search.call(deps.accountAdminClient, {
          requestingUserId: auth.userId,
          subjectType: body.subjectType,
          query: body.subjectId,
          page: 1,
          perPage: 20,
          requestId: auth.requestId
        });
        if (
          !result.subjects.some(
            (subject) => subject.type === body.subjectType && subject.id === body.subjectId
          )
        ) {
          return sendError(reply, 400, "invalid_request");
        }
      } catch {
        return sendError(reply, 503, "subject_service_unavailable");
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
            auth.requestId,
            auth.userId
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
          auth.requestId,
          auth.userId
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
          deps.service.createBindingCode(
            request.params.collectionId,
            auth.userId,
            key,
            auth.requestId
          ),
        201
      );
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

function parseManagedItemListQuery(
  value: unknown
): { query?: string; cursor?: string; limit?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => key !== "q" && key !== "cursor" && key !== "limit")) {
    return undefined;
  }
  if (
    query.q !== undefined &&
    (typeof query.q !== "string" || Buffer.byteLength(query.q, "utf8") > 255 || hasControl(query.q))
  ) {
    return undefined;
  }
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
    ...(typeof query.q === "string" ? { query: query.q } : {}),
    ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
    ...(limit === undefined ? {} : { limit })
  };
}

function parseAclSubjectQuery(
  value: unknown
): { subjectType: "user" | "role"; query: string; page: number; perPage: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  const keys = Object.keys(query);
  if (
    keys.length !== 4 ||
    !["subjectType", "q", "page", "perPage"].every((key) => keys.includes(key)) ||
    (query.subjectType !== "user" && query.subjectType !== "role") ||
    typeof query.q !== "string" ||
    /\p{Cc}|[\uD800-\uDFFF]/u.test(query.q) ||
    typeof query.page !== "string" ||
    !/^[1-9]\d*$/u.test(query.page) ||
    typeof query.perPage !== "string" ||
    !/^[1-9]\d*$/u.test(query.perPage)
  ) {
    return undefined;
  }
  const normalizedQuery = query.q.trim();
  const page = Number(query.page);
  const perPage = Number(query.perPage);
  if (
    Buffer.byteLength(normalizedQuery, "utf8") > 120 ||
    !Number.isSafeInteger(page) ||
    page > 1000 ||
    !Number.isSafeInteger(perPage) ||
    perPage > 50
  ) {
    return undefined;
  }
  return { subjectType: query.subjectType, query: normalizedQuery, page, perPage };
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value.trim(), "utf8") <= 120 &&
    !hasControl(value)
  );
}

function validItemDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value.trim(), "utf8") <= 255 &&
    !/[\\/]/u.test(value) &&
    !hasControl(value)
  );
}

function validRetentionDays(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 365;
}

function validItemIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 100 &&
    value.every((itemId) => typeof itemId === "string" && validOpaqueId(itemId))
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

function validSubjectId(_subjectType: "user" | "role", value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    validOpaqueId(value) &&
    uuidPattern.test(value)
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
  return /\p{Cc}|[\uD800-\uDFFF]/u.test(value);
}

async function run(reply: FastifyReply, operation: () => Promise<unknown>, successStatus = 200) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    if (error instanceof MediaSyncManagementError && error.code === "binding_code_already_issued") {
      return sendError(reply, 409, "binding_code_already_issued");
    }
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
  if ([400, 401, 403, 404, 409, 429].includes(status)) return status;
  return status === 408 || status >= 500 ? 503 : 502;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ ok: false, error });
}

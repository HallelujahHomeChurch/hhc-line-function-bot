import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AccountApiError, type AccountAdminClient } from "../account/account-admin-client.js";
import type { AssetApiClient, ManagedCollection } from "../clients/asset-api.js";
import { registerMediaSyncRoutes } from "../media-sync/http-routes.js";
import { MediaSyncManagementService } from "../media-sync/service.js";
import type { PostgresMediaSyncStore } from "../media-sync/store.js";

const userId = "018f0c1f-18d0-7e81-9f6f-69c456db7003";
const collection: ManagedCollection = {
  collection: {
    id: "collection-1",
    namespace: "line.group.media-sync",
    name: "Media",
    revision: 1,
    retentionDays: 14,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  },
  acls: []
};

function account(allowed = true): AccountAdminClient {
  return {
    verifyPermission: vi.fn().mockResolvedValue(allowed),
    searchMediaSyncAclSubjects: vi.fn().mockResolvedValue({
      subjects: [{ id: userId, type: "user", displayName: "Ada Lovelace" }],
      page: 1,
      perPage: 20,
      hasMore: false
    })
  } as unknown as AccountAdminClient;
}

function asset(): AssetApiClient {
  return {
    listManagedCollections: vi.fn().mockResolvedValue({
      collections: [collection],
      hasMore: false
    }),
    getManagedCollection: vi.fn().mockResolvedValue(collection),
    createCollection: vi.fn().mockResolvedValue(collection.collection),
    renameCollection: vi.fn().mockResolvedValue({ ...collection.collection, name: "Renamed" }),
    deleteCollection: vi.fn().mockResolvedValue({
      ...collection.collection,
      deletedAt: "2026-08-16T01:00:00.000Z"
    }),
    addCollectionAcl: vi.fn().mockResolvedValue({
      collection: collection.collection,
      acl: {
        id: "acl-1",
        collectionId: "collection-1",
        subjectType: "user",
        subjectId: userId,
        permission: "read",
        createdAt: "2026-08-16T00:00:00.000Z"
      }
    }),
    revokeCollectionAcl: vi.fn().mockResolvedValue({
      collection: collection.collection,
      acl: {
        id: "acl-1",
        collectionId: "collection-1",
        subjectType: "user",
        subjectId: userId,
        permission: "read",
        createdAt: "2026-08-16T00:00:00.000Z",
        revokedAt: "2026-08-16T01:00:00.000Z"
      }
    }),
    listManagedCollectionItems: vi.fn().mockResolvedValue({
      items: [
        {
          id: "550e8400e29b41d4a716446655440000",
          displayName: "Sunday.mp4",
          mimeType: "video/mp4",
          sizeBytes: 1200,
          createdAt: "2026-08-18T06:30:00.000Z",
          retentionExempt: false
        }
      ],
      hasMore: false
    }),
    updateCollectionRetention: vi.fn().mockResolvedValue({
      ...collection.collection,
      retentionDays: 14
    }),
    renameManagedCollectionItem: vi.fn().mockResolvedValue({
      id: "550e8400e29b41d4a716446655440000",
      displayName: "Renamed.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1200,
      createdAt: "2026-08-18T06:30:00.000Z",
      retentionExempt: false
    }),
    setManagedCollectionItemsRetention: vi.fn().mockResolvedValue(undefined),
    deleteManagedCollectionItems: vi.fn().mockResolvedValue({ deleted: 1, alreadyRemoved: 0 }),
    issueManagedContentTickets: vi.fn().mockResolvedValue({
      tickets: [
        {
          itemId: "550e8400e29b41d4a716446655440000",
          contentUrl: "/api/assets/content?ticket=opaque",
          expiresAt: "2026-08-18T06:35:00.000Z",
          etag: "asset-version"
        }
      ],
      unavailableItemIds: []
    })
  } as unknown as AssetApiClient;
}

function store(): PostgresMediaSyncStore {
  return {
    findActiveBindingByCollection: vi.fn().mockResolvedValue(undefined),
    findPendingBindingCodeByCollection: vi.fn().mockResolvedValue(undefined),
    createBindingCode: vi.fn().mockResolvedValue({
      status: "issued",
      code: "PLAIN-CODE",
      expiresAt: "2026-08-16T01:00:00.000Z"
    }),
    disableBindingByCollection: vi.fn().mockResolvedValue(true)
  } as unknown as PostgresMediaSyncStore;
}

async function app(input: {
  account?: AccountAdminClient;
  assets?: AssetApiClient;
  store?: PostgresMediaSyncStore;
  token?: string;
}) {
  const instance = fastify({ logger: false, bodyLimit: 262_144 });
  instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );
  const accountClient = input.account ?? account();
  const assets = input.assets ?? asset();
  const mediaStore = input.store ?? store();
  registerMediaSyncRoutes(instance, {
    gatewayCallerAppId: "api-gateway",
    appApiToken: input.token ?? "app-token",
    requestIdFactory: () => "generated-request",
    accountAdminClient: accountClient,
    service: new MediaSyncManagementService(assets, mediaStore)
  });
  return { instance, accountClient, assets, mediaStore };
}

const trustedHeaders = {
  "dapr-caller-app-id": "api-gateway",
  "dapr-api-token": "app-token",
  "x-hhc-user-id": userId,
  "x-hhc-request-id": "request-1"
};

const routeRequests = [
  { method: "GET", url: "/api/line/media-sync/collections" },
  {
    method: "GET",
    url: "/api/line/media-sync/acl-subjects?subjectType=user&q=&page=1&perPage=20"
  },
  { method: "POST", url: "/api/line/media-sync/collections", payload: { name: "Media" } },
  {
    method: "PATCH",
    url: "/api/line/media-sync/collections/collection-1",
    payload: { name: "Renamed" }
  },
  { method: "DELETE", url: "/api/line/media-sync/collections/collection-1" },
  {
    method: "POST",
    url: "/api/line/media-sync/collections/collection-1/acl",
    payload: { subjectType: "user", subjectId: userId }
  },
  {
    method: "DELETE",
    url: "/api/line/media-sync/collections/collection-1/acl/acl-1"
  },
  {
    method: "POST",
    url: "/api/line/media-sync/collections/collection-1/binding-code",
    payload: {}
  },
  { method: "DELETE", url: "/api/line/media-sync/collections/collection-1/binding" },
  { method: "GET", url: "/api/line/media-sync/collections/collection-1/items" },
  {
    method: "PATCH",
    url: "/api/line/media-sync/collections/collection-1/retention",
    payload: { retentionDays: 14 }
  },
  {
    method: "PATCH",
    url: "/api/line/media-sync/collections/collection-1/items/550e8400e29b41d4a716446655440000",
    payload: { displayName: "Renamed.mp4" }
  },
  {
    method: "POST",
    url: "/api/line/media-sync/collections/collection-1/items/retention",
    payload: { itemIds: ["550e8400e29b41d4a716446655440000"], retentionExempt: true }
  },
  {
    method: "POST",
    url: "/api/line/media-sync/collections/collection-1/items/delete",
    payload: { itemIds: ["550e8400e29b41d4a716446655440000"] }
  },
  {
    method: "POST",
    url: "/api/line/media-sync/collections/collection-1/items/content-tickets",
    payload: { itemIds: ["550e8400e29b41d4a716446655440000"] }
  }
] as const;

describe("media sync management HTTP", () => {
  it.each([
    ["missing token", { ...trustedHeaders, "dapr-api-token": undefined }],
    ["wrong token", { ...trustedHeaders, "dapr-api-token": "wrong" }],
    ["missing caller", { ...trustedHeaders, "dapr-caller-app-id": undefined }],
    ["wrong caller", { ...trustedHeaders, "dapr-caller-app-id": "attacker" }]
  ])("rejects %s before trusting HHC identity", async (_label, headers) => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: Object.fromEntries(
        Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
    });

    expect(response.statusCode).toBe(403);
    expect(accountClient.verifyPermission).not.toHaveBeenCalled();
    await instance.close();
  });

  it("fails closed when the runtime app token is empty", async () => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient, token: "" });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: { ...trustedHeaders, "dapr-api-token": "" }
    });

    expect(response.statusCode).toBe(403);
    expect(accountClient.verifyPermission).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each([
    [
      "missing caller",
      {
        ...trustedHeaders,
        "dapr-caller-app-id": undefined,
        "x-internal-caller-app-id": "api-gateway"
      }
    ],
    ["wrong caller", { ...trustedHeaders, "dapr-caller-app-id": "attacker" }],
    ["missing token", { ...trustedHeaders, "dapr-api-token": undefined }],
    ["wrong token", { ...trustedHeaders, "dapr-api-token": "attacker" }]
  ])("rejects %s on all management routes before Account lookup", async (_label, headers) => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    for (const request of routeRequests) {
      const response = await instance.inject({
        ...request,
        headers: Object.fromEntries(
          Object.entries(headers).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        )
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    expect(accountClient.verifyPermission).not.toHaveBeenCalled();
    await instance.close();
  });

  it("requires normalized user identity on all management routes before Account lookup", async () => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    for (const request of routeRequests) {
      const response = await instance.inject({
        ...request,
        headers: { ...trustedHeaders, "x-hhc-user-id": "" }
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
    }
    expect(accountClient.verifyPermission).not.toHaveBeenCalled();
    await instance.close();
  });

  it("requires media-sync:manage on all management routes", async () => {
    const accountClient = account(false);
    const { instance } = await app({ account: accountClient });
    for (const request of routeRequests) {
      const response = await instance.inject({ ...request, headers: trustedHeaders });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    expect(accountClient.verifyPermission).toHaveBeenCalledTimes(routeRequests.length);
    await instance.close();
  });

  it("requires an idempotency key on every idempotent mutation route", async () => {
    const { instance } = await app({});
    for (const request of routeRequests.filter(
      (request) => request.method !== "GET" && !request.url.endsWith("/content-tickets")
    )) {
      const response = await instance.inject({ ...request, headers: trustedHeaders });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
    }
    await instance.close();
  });

  it("does not accept reader ACL identity as a management permission", async () => {
    const accountClient = account(false);
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections/collection-1/items",
      headers: { ...trustedHeaders, "x-collection-reader-role": "media_sync_reader" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "forbidden" });
    expect(accountClient.verifyPermission).toHaveBeenCalledWith({ userId, requestId: "request-1" });
    await instance.close();
  });

  it("validates managed retention and item selection boundaries", async () => {
    const assets = asset();
    const { instance } = await app({ assets });
    const itemId = "550e8400e29b41d4a716446655440000";
    const requests = [
      {
        method: "PATCH",
        url: "/api/line/media-sync/collections/collection-1/retention",
        payload: { retentionDays: 0 }
      },
      {
        method: "PATCH",
        url: "/api/line/media-sync/collections/collection-1/retention",
        payload: { retentionDays: 366 }
      },
      {
        method: "POST",
        url: "/api/line/media-sync/collections/collection-1/items/retention",
        payload: { itemIds: [], retentionExempt: true }
      },
      {
        method: "POST",
        url: "/api/line/media-sync/collections/collection-1/items/delete",
        payload: { itemIds: Array.from({ length: 101 }, () => itemId) }
      },
      {
        method: "POST",
        url: "/api/line/media-sync/collections/collection-1/items/content-tickets",
        payload: { itemIds: Array.from({ length: 101 }, () => itemId) }
      }
    ] as const;

    for (const request of requests) {
      const response = await instance.inject({
        ...request,
        headers: { ...trustedHeaders, "idempotency-key": "request-1" }
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
    }
    expect(assets.updateCollectionRetention).not.toHaveBeenCalled();
    expect(assets.setManagedCollectionItemsRetention).not.toHaveBeenCalled();
    expect(assets.deleteManagedCollectionItems).not.toHaveBeenCalled();
    expect(assets.issueManagedContentTickets).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each([
    ["collection name", "POST", "/api/line/media-sync/collections", { name: "Media\u0085" }],
    [
      "managed item query",
      "GET",
      "/api/line/media-sync/collections/collection-1/items?q=Media%C2%85",
      undefined
    ],
    [
      "managed item name",
      "PATCH",
      "/api/line/media-sync/collections/collection-1/items/550e8400e29b41d4a716446655440000",
      { displayName: "Sunday\u0085.mp4" }
    ]
  ])("rejects Unicode control text in %s", async (_label, method, url, payload) => {
    const assets = asset();
    const { instance } = await app({ assets });
    const response = await instance.inject({
      method,
      url,
      headers: { ...trustedHeaders, "idempotency-key": "request-1" },
      ...(payload === undefined ? {} : { payload })
    });

    expect(response.statusCode).toBe(400);
    expect(assets.createCollection).not.toHaveBeenCalled();
    expect(assets.listManagedCollectionItems).not.toHaveBeenCalled();
    expect(assets.renameManagedCollectionItem).not.toHaveBeenCalled();
    await instance.close();
  });

  it("issues content tickets without an idempotency key", async () => {
    const assets = asset();
    const { instance } = await app({ assets });
    const itemId = "550e8400e29b41d4a716446655440000";
    const response = await instance.inject({
      method: "POST",
      url: "/api/line/media-sync/collections/collection-1/items/content-tickets",
      headers: trustedHeaders,
      payload: { itemIds: [itemId] }
    });

    expect(response.statusCode).toBe(201);
    expect(assets.issueManagedContentTickets).toHaveBeenCalledWith("collection-1", [itemId], {
      requestId: "request-1"
    });
    await instance.close();
  });

  it("maps an Asset 403 without revealing managed item existence", async () => {
    const assets = asset();
    vi.mocked(assets.listManagedCollectionItems).mockRejectedValue(new Error("asset_api_403"));
    const { instance } = await app({ assets });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections/collection-1/items",
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "asset_request_failed" });
    expect(response.body).not.toContain("collection-1");
    await instance.close();
  });

  it("proxies bounded ACL subject search with only the authenticated requester", async () => {
    const accountClient = account();
    vi.mocked(accountClient.searchMediaSyncAclSubjects).mockResolvedValue({
      subjects: [
        { id: userId, type: "user", displayName: "Ada Lovelace", email: "ada@example.com" }
      ],
      page: 2,
      perPage: 20,
      hasMore: false
    });
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/acl-subjects?subjectType=user&q=%20Ada%20&page=2&perPage=20",
      headers: { ...trustedHeaders, "x-hhc-user-id": userId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-hhc-request-id"]).toBe("request-1");
    expect(response.json()).toEqual({
      subjects: [
        { id: userId, type: "user", displayName: "Ada Lovelace", email: "ada@example.com" }
      ],
      page: 2,
      perPage: 20,
      hasMore: false
    });
    expect(accountClient.searchMediaSyncAclSubjects).toHaveBeenCalledWith({
      requestingUserId: userId,
      subjectType: "user",
      query: "Ada",
      page: 2,
      perPage: 20,
      requestId: "request-1"
    });
    await instance.close();
  });

  it.each([
    ["missing subject type", "q=&page=1&perPage=20"],
    ["unknown subject type", "subjectType=service&q=&page=1&perPage=20"],
    ["missing query", "subjectType=user&page=1&perPage=20"],
    ["oversized UTF-8 query", `subjectType=user&q=${"界".repeat(41)}&page=1&perPage=20`],
    ["control query", "subjectType=user&q=%0A&page=1&perPage=20"],
    ["Unicode control query", "subjectType=user&q=%C2%85&page=1&perPage=20"],
    ["zero page", "subjectType=user&q=&page=0&perPage=20"],
    ["page above bound", "subjectType=user&q=&page=1001&perPage=20"],
    ["non-canonical page", "subjectType=user&q=&page=01&perPage=20"],
    ["zero page size", "subjectType=user&q=&page=1&perPage=0"],
    ["page size above bound", "subjectType=user&q=&page=1&perPage=51"],
    ["duplicate query", "subjectType=user&q=a&q=b&page=1&perPage=20"],
    ["requester override", "subjectType=user&q=&page=1&perPage=20&requestingUserId=attacker"]
  ])("rejects an invalid ACL subject query: %s", async (_label, query) => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: `/api/line/media-sync/acl-subjects?${query}`,
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(400);
    expect(accountClient.searchMediaSyncAclSubjects).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each([
    ["Account denial", new AccountApiError("account_api_http_403", false), 403, "forbidden"],
    [
      "Account timeout",
      new AccountApiError("account_api_transport_error", true),
      503,
      "subject_service_unavailable"
    ],
    [
      "Account 5xx",
      new AccountApiError("account_api_http_503", true),
      503,
      "subject_service_unavailable"
    ],
    [
      "malformed response",
      new AccountApiError("account_api_invalid_acl_subjects", false),
      503,
      "subject_service_unavailable"
    ]
  ])("maps %s without reflecting Account errors", async (_label, error, status, outwardError) => {
    const accountClient = account();
    vi.mocked(accountClient.searchMediaSyncAclSubjects).mockRejectedValue(error);
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/acl-subjects?subjectType=role&q=&page=1&perPage=20",
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ ok: false, error: outwardError });
    expect(response.body).not.toContain("account_api");
    await instance.close();
  });

  it("rejects malformed input on every route", async () => {
    const longId = "a".repeat(256);
    const requests = [
      { method: "GET", url: "/api/line/media-sync/collections?unknown=true" },
      {
        method: "POST",
        url: "/api/line/media-sync/collections",
        payload: { name: "Media", namespace: "override" }
      },
      {
        method: "PATCH",
        url: `/api/line/media-sync/collections/${longId}`,
        payload: { name: "Renamed" }
      },
      {
        method: "DELETE",
        url: "/api/line/media-sync/collections/collection-1",
        payload: { unexpected: true }
      },
      {
        method: "POST",
        url: "/api/line/media-sync/collections/collection-1/acl",
        payload: { subjectType: "service", subjectId: "asset-api" }
      },
      {
        method: "DELETE",
        url: "/api/line/media-sync/collections/collection-1/acl/acl-1",
        payload: { unexpected: true }
      },
      {
        method: "POST",
        url: "/api/line/media-sync/collections/collection-1/binding-code",
        payload: { code: "chosen" }
      },
      {
        method: "DELETE",
        url: "/api/line/media-sync/collections/collection-1/binding",
        payload: { unexpected: true }
      }
    ] as const;
    const { instance } = await app({});
    for (const request of requests) {
      const response = await instance.inject({
        ...request,
        headers: { ...trustedHeaders, "idempotency-key": "request-1" }
      });
      expect([400, 414], `${request.method} ${request.url}`).toContain(response.statusCode);
    }
    await instance.close();
  });

  it("requires a canonical user and an Account media-sync:manage decision", async () => {
    const denied = account(false);
    const { instance } = await app({ account: denied });
    const missing = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: { ...trustedHeaders, "x-hhc-user-id": "" }
    });
    const forbidden = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: trustedHeaders
    });

    expect(missing.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(denied.verifyPermission).toHaveBeenCalledWith({
      userId,
      requestId: "request-1"
    });
    await instance.close();
  });

  it("replaces an invalid normalized request ID instead of reflecting it", async () => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: { ...trustedHeaders, "x-hhc-request-id": "x".repeat(129) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-hhc-request-id"]).toBe("generated-request");
    expect(accountClient.verifyPermission).toHaveBeenCalledWith({
      userId,
      requestId: "generated-request"
    });
    await instance.close();
  });

  it("returns an explicit null binding status for unbound collections", async () => {
    const { instance } = await app({});
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().collections[0]).toEqual({
      ...collection,
      binding: null,
      pendingBinding: null
    });
    await instance.close();
  });

  it("dispatches the exact eight routes and propagates request/idempotency identity", async () => {
    const assets = asset();
    const mediaStore = store();
    const { instance } = await app({ assets, store: mediaStore });
    const cases = [
      ["GET", "/api/line/media-sync/collections", undefined, undefined, 200],
      ["POST", "/api/line/media-sync/collections", { name: "Media" }, "create-1", 201],
      [
        "PATCH",
        "/api/line/media-sync/collections/collection-1",
        { name: "Renamed" },
        "rename-1",
        200
      ],
      ["DELETE", "/api/line/media-sync/collections/collection-1", undefined, "delete-1", 200],
      [
        "POST",
        "/api/line/media-sync/collections/collection-1/acl",
        { subjectType: "user", subjectId: userId },
        "acl-add-1",
        201
      ],
      [
        "DELETE",
        "/api/line/media-sync/collections/collection-1/acl/acl-1",
        undefined,
        "acl-delete-1",
        200
      ],
      ["POST", "/api/line/media-sync/collections/collection-1/binding-code", {}, "binding-1", 201],
      [
        "DELETE",
        "/api/line/media-sync/collections/collection-1/binding",
        undefined,
        "unbind-1",
        200
      ]
    ] as const;

    for (const [method, url, payload, key, statusCode] of cases) {
      const response = await instance.inject({
        method,
        url,
        headers: { ...trustedHeaders, ...(key ? { "idempotency-key": key } : {}) },
        ...(payload === undefined ? {} : { payload })
      });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(statusCode);
      expect(response.headers["x-hhc-request-id"]).toBe("request-1");
    }

    expect(assets.createCollection).toHaveBeenCalledWith("Media", "create-1", {
      requestId: "request-1"
    });
    expect(assets.addCollectionAcl).toHaveBeenCalledWith(
      "collection-1",
      { subjectType: "user", subjectId: userId },
      "acl-add-1",
      { requestId: "request-1" }
    );
    expect(mediaStore.createBindingCode).toHaveBeenCalledWith({
      profileName: "helper",
      collectionId: "collection-1",
      createdByHhcUserId: userId,
      idempotencyKey: "binding-1"
    });
    await instance.close();
  });

  it("returns a deterministic non-secret conflict for a same-key binding-code retry", async () => {
    const mediaStore = store();
    vi.mocked(mediaStore.createBindingCode).mockResolvedValue({
      status: "already_issued",
      expiresAt: "2026-08-16T01:00:00.000Z"
    });
    const { instance } = await app({ store: mediaStore });

    const response = await instance.inject({
      method: "POST",
      url: "/api/line/media-sync/collections/collection-1/binding-code",
      headers: { ...trustedHeaders, "idempotency-key": "binding-1" },
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["x-hhc-request-id"]).toBe("request-1");
    expect(response.json()).toEqual({ ok: false, error: "binding_code_already_issued" });
    expect(response.body).not.toContain("command");
    expect(response.body).not.toContain("PLAIN-CODE");
    expect(response.body).not.toContain("expiresAt");
    await instance.close();
  });

  it.each([
    ["PUT", "/api/line/media-sync/collections"],
    ["GET", "/api/line/media-sync/collections/collection-1"],
    ["POST", "/api/line/media-sync/collections/collection-1"],
    ["GET", "/api/line/media-sync/collections/collection-1/acl"],
    ["PATCH", "/api/line/media-sync/collections/collection-1/acl/acl-1"],
    ["GET", "/api/line/media-sync/collections/collection-1/binding-code"],
    ["POST", "/api/line/media-sync/collections/collection-1/binding"]
  ])("does not expose an unplanned %s route at %s", async (method, url) => {
    const accountClient = account();
    const { instance } = await app({ account: accountClient });
    const response = await instance.inject({ method, url, headers: trustedHeaders });

    expect(response.statusCode).toBe(404);
    expect(accountClient.verifyPermission).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each([
    ["unknown field", '{"name":"Media","namespace":"override"}'],
    ["trailing value", '{"name":"Media"} {}'],
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])]
  ])("rejects strict JSON: %s", async (_label, payload) => {
    const assets = asset();
    const { instance } = await app({ assets });
    const response = await instance.inject({
      method: "POST",
      url: "/api/line/media-sync/collections",
      headers: {
        ...trustedHeaders,
        "idempotency-key": "create-1",
        "content-type": "application/json"
      },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(assets.createCollection).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each(["", "   ", "a".repeat(129)])("rejects invalid raw idempotency keys", async (key) => {
    const assets = asset();
    const { instance } = await app({ assets });
    const response = await instance.inject({
      method: "POST",
      url: "/api/line/media-sync/collections",
      headers: { ...trustedHeaders, "idempotency-key": key },
      payload: { name: "Media" }
    });

    expect(response.statusCode).toBe(400);
    expect(assets.createCollection).not.toHaveBeenCalled();
    await instance.close();
  });

  it("lists manager metadata and binding status without reader content", async () => {
    const assets = asset();
    const mediaStore = store();
    vi.mocked(mediaStore.findActiveBindingByCollection).mockResolvedValue({
      id: "binding-internal",
      profileName: "helper",
      groupId: "group-1",
      collectionId: "collection-1",
      groupDisplayName: "Worship Team",
      bindingCodeCreatedByHhcUserId: "manager-secret",
      boundAt: "2026-08-16T00:00:00.000Z"
    });
    const { instance } = await app({ assets, store: mediaStore });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections?cursor=next&limit=25",
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      collections: [
        {
          ...collection,
          binding: {
            groupId: "group-1",
            groupDisplayName: "Worship Team",
            boundAt: "2026-08-16T00:00:00.000Z"
          },
          pendingBinding: null
        }
      ],
      hasMore: false
    });
    expect(response.body).not.toContain("items");
    expect(response.body).not.toContain("binding-internal");
    expect(response.body).not.toContain("manager-secret");
    expect(assets.listManagedCollections).toHaveBeenCalledWith(
      { cursor: "next", limit: 25 },
      { requestId: "request-1" }
    );
    await instance.close();
  });

  it("lists pending binding expiry without exposing code material", async () => {
    const mediaStore = store();
    vi.mocked(mediaStore.findPendingBindingCodeByCollection).mockResolvedValue({
      expiresAt: "2026-08-16T01:00:00.000Z"
    });
    const { instance } = await app({ store: mediaStore });
    const response = await instance.inject({
      method: "GET",
      url: "/api/line/media-sync/collections",
      headers: trustedHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().collections[0]).toMatchObject({
      binding: null,
      pendingBinding: { expiresAt: "2026-08-16T01:00:00.000Z" }
    });
    expect(response.body).not.toContain("PLAIN-CODE");
    expect(response.body).not.toContain("request_key_hash");
    await instance.close();
  });

  it.each(["missing", "deleted", "bound", "raced-bound"])(
    "does not issue a binding code for a %s collection",
    async (state) => {
      const assets = asset();
      const mediaStore = store();
      if (state === "missing") {
        vi.mocked(assets.getManagedCollection).mockRejectedValue(new Error("asset_api_404"));
      } else if (state === "deleted") {
        vi.mocked(assets.getManagedCollection).mockResolvedValue({
          ...collection,
          collection: { ...collection.collection, deletedAt: "2026-08-16T00:00:00.000Z" }
        });
      } else {
        if (state === "bound") {
          vi.mocked(mediaStore.findActiveBindingByCollection).mockResolvedValue({
            id: "binding-1",
            profileName: "helper",
            groupId: "group-1",
            collectionId: "collection-1",
            groupDisplayName: "Group",
            bindingCodeCreatedByHhcUserId: userId,
            boundAt: "2026-08-16T00:00:00.000Z"
          });
        } else {
          vi.mocked(mediaStore.createBindingCode).mockResolvedValue({ status: "collection_bound" });
        }
      }
      const service = new MediaSyncManagementService(assets, mediaStore);

      await expect(
        service.createBindingCode("collection-1", userId, "binding-1", "request-1")
      ).rejects.toBeInstanceOf(Error);
      if (state === "raced-bound") {
        expect(mediaStore.createBindingCode).toHaveBeenCalledOnce();
      } else {
        expect(mediaStore.createBindingCode).not.toHaveBeenCalled();
      }
    }
  );
});

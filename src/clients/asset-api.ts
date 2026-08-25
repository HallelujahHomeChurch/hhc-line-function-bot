import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";

export type AssetScanStatus = "pending" | "scanning" | "clean" | "infected" | "failed";

export interface AssetRecord {
  id: string;
  ownerService?: string;
  ownerType?: string;
  ownerId?: string;
  visibility?: "private" | "public" | "restricted";
  uploadStatus: "created" | "completed" | "failed";
  scanStatus: AssetScanStatus;
  scanSignatureVersion?: string;
  scanFailureCategory?: string;
  etag?: string;
  processingStatus?: "not_required" | "pending" | "ready" | "failed";
  sizeBytes?: number;
  checksumSha256?: string;
  detectedMimeType?: string;
}

export interface AssetUploadTarget {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type CollectionSubjectType = "user" | "role";

export interface CollectionRecord {
  id: string;
  namespace: "line.group.media-sync";
  name: string;
  revision: number;
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CollectionAclRecord {
  id: string;
  collectionId: string;
  subjectType: CollectionSubjectType;
  subjectId: string;
  permission: "read";
  createdAt: string;
  revokedAt?: string;
}

export interface ManagedCollection {
  collection: CollectionRecord;
  acls: CollectionAclRecord[];
}

export interface ManagedCollectionPage {
  collections: ManagedCollection[];
  cursor?: string;
  hasMore: boolean;
}

export interface ManagedCollectionItem {
  id: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  retentionExempt: boolean;
}

export interface ManagedCollectionItemPage {
  items: ManagedCollectionItem[];
  cursor?: string;
  hasMore: boolean;
}

export interface ManagedContentTicket {
  itemId: string;
  contentUrl: string;
  expiresAt: string;
  etag: string;
}

export interface ManagedContentTicketBatch {
  tickets: ManagedContentTicket[];
  unavailableItemIds: string[];
}

export interface CollectionAclMutation {
  collection: CollectionRecord;
  acl: CollectionAclRecord;
}

export interface CollectionItemRecord {
  id: string;
  collectionId: string;
  assetId: string;
  remoteItemId: string;
  displayName: string;
  sourceRevision: string;
  createdRevision: number;
  retentionExempt: boolean;
  updatedRevision: number;
  deletedRevision?: number;
  mimeType?: string;
  sizeBytes?: number;
  etag?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CollectionItemMutation {
  collection: CollectionRecord;
  item: CollectionItemRecord;
}

export interface AssetApiClient {
  listManagedCollections(
    input?: { cursor?: string; limit?: number },
    options?: AssetApiRequestOptions
  ): Promise<ManagedCollectionPage>;
  getManagedCollection(
    collectionId: string,
    options?: AssetApiRequestOptions
  ): Promise<ManagedCollection>;
  listManagedCollectionItems(
    collectionId: string,
    input?: { query?: string; cursor?: string; limit?: number },
    options?: AssetApiRequestOptions
  ): Promise<ManagedCollectionItemPage>;
  updateCollectionRetention(
    collectionId: string,
    retentionDays: number,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionRecord>;
  renameManagedCollectionItem(
    collectionId: string,
    itemId: string,
    displayName: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<ManagedCollectionItem>;
  setManagedCollectionItemsRetention(
    collectionId: string,
    input: { itemIds: string[]; retentionExempt: boolean },
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<void>;
  deleteManagedCollectionItems(
    collectionId: string,
    itemIds: string[],
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<{ deleted: number; alreadyRemoved: number }>;
  issueManagedContentTickets(
    collectionId: string,
    itemIds: string[],
    options?: AssetApiRequestOptions
  ): Promise<ManagedContentTicketBatch>;
  createCollection(
    name: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionRecord>;
  renameCollection(
    collectionId: string,
    name: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionRecord>;
  deleteCollection(
    collectionId: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionRecord>;
  addCollectionAcl(
    collectionId: string,
    input: { subjectType: CollectionSubjectType; subjectId: string },
    idempotencyKey: string,
    options: CollectionAclRequestOptions
  ): Promise<CollectionAclMutation>;
  revokeCollectionAcl(
    collectionId: string,
    aclId: string,
    idempotencyKey: string,
    options: CollectionAclRequestOptions
  ): Promise<CollectionAclMutation>;
  createUpload(
    input: {
      namespace?: "line.group.file" | "line.group.media-sync";
      idempotencyKey: string;
      ownerType: string;
      ownerId: string;
      purpose: string;
      fileName: string;
      mimeType: string;
      maxSizeBytes: number;
    },
    options?: AssetApiRequestOptions
  ): Promise<{ asset: AssetRecord; uploadTarget?: AssetUploadTarget }>;
  upload(
    target: AssetUploadTarget,
    data: Uint8Array,
    options?: AssetApiRequestOptions
  ): Promise<void>;
  uploadFile(
    target: AssetUploadTarget,
    filePath: string,
    options?: AssetApiRequestOptions
  ): Promise<void>;
  complete(
    assetId: string,
    input: { sizeBytes: number; checksumSha256: string; mimeType: string },
    options?: AssetApiRequestOptions
  ): Promise<AssetRecord>;
  grantServiceRead(
    assetId: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<{ id: string }>;
  revokeGrant(assetId: string, grantId: string, options?: AssetApiRequestOptions): Promise<void>;
  get(assetId: string, options?: AssetApiRequestOptions): Promise<AssetRecord>;
  download(
    assetId: string,
    options?: AssetApiRequestOptions
  ): Promise<{ data: Uint8Array; contentType?: string }>;
  softDelete(assetId: string, options?: AssetApiRequestOptions): Promise<void>;
  addCollectionItem(
    collectionId: string,
    input: {
      assetId: string;
      remoteItemId: string;
      displayName: string;
      sourceRevision: string;
    },
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionItemMutation>;
  deleteCollectionItem(
    collectionId: string,
    itemId: string,
    idempotencyKey: string,
    options?: AssetApiRequestOptions
  ): Promise<CollectionItemMutation>;
}

export interface AssetApiRequestOptions {
  signal?: AbortSignal;
  requestId?: string;
}

export interface CollectionAclRequestOptions extends AssetApiRequestOptions {
  requestId: string;
  actorUserId: string;
}

export type AssetApiRejectionTelemetry = {
  operationStage: string;
  httpStatus: number;
  category:
    "authorization_rejected" | "rate_limited" | "upstream_rejected" | "upstream_unavailable";
};

class AssetApiRequestError extends Error {
  constructor(
    code: string,
    readonly transient: boolean
  ) {
    super(code);
  }
}

export function isTransientAssetApiError(error: unknown): boolean {
  return error instanceof AssetApiRequestError && error.transient;
}

export function isPermanentAssetApiError(error: unknown): boolean {
  return error instanceof AssetApiRequestError && !error.transient;
}

export function isAssetAccessDeniedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "asset_api_403" || error.message === "asset_api_404")
  );
}

export function assetAccessTokenScope(audience: string): string {
  return `${audience.replace(/\/$/u, "")}/.default`;
}

function reportAssetApiRejection(
  onRejection: ((telemetry: AssetApiRejectionTelemetry) => void) | undefined,
  operationStage: string,
  httpStatus: number
): void {
  if (!onRejection) return;
  try {
    onRejection({
      operationStage,
      httpStatus,
      category:
        httpStatus === 401 || httpStatus === 403
          ? "authorization_rejected"
          : httpStatus === 429
            ? "rate_limited"
            : httpStatus === 0 || httpStatus >= 500
              ? "upstream_unavailable"
              : "upstream_rejected"
    });
  } catch {
    // Rejection telemetry must not alter Asset operation behavior.
  }
}

export function createAssetApiClient(options: {
  baseUrl: string;
  getAccessToken?: (signal?: AbortSignal) => Promise<string>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  onRejection?: (telemetry: AssetApiRejectionTelemetry) => void;
}): AssetApiClient {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const request = async (
    operationStage: string,
    path: string,
    init: RequestInit = {},
    requestOptions?: AssetApiRequestOptions
  ): Promise<Response> => {
    let response: Response;
    try {
      const signal =
        requestOptions?.signal ??
        (options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs));
      const token = options.getAccessToken ? await options.getAccessToken(signal) : undefined;
      if (token !== undefined && !token.trim()) throw new Error("empty_token");
      response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        signal,
        redirect: "manual",
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...toHeaders(init.headers),
          ...(requestOptions?.requestId ? { "x-hhc-request-id": requestOptions.requestId } : {})
        }
      });
    } catch {
      reportAssetApiRejection(options.onRejection, operationStage, 0);
      throw new AssetApiRequestError("asset_api_unavailable", true);
    }
    if (!response.ok) {
      reportAssetApiRejection(options.onRejection, operationStage, response.status);
      throw new AssetApiRequestError(
        `asset_api_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }
    return response;
  };

  return {
    async listManagedCollections(input = {}, requestOptions) {
      const query = new URLSearchParams();
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const response = await request(
        "list_managed_collections",
        `/priv/assets/collections${query.size ? `?${query.toString()}` : ""}`,
        {},
        requestOptions
      );
      const page = parseManagedCollectionPage(await readJson(response));
      if (!page) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return page;
    },
    async getManagedCollection(collectionId, requestOptions) {
      const response = await request(
        "get_managed_collection",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}`,
        {},
        requestOptions
      );
      const collection = parseManagedCollection(await readJson(response));
      if (!collection) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return collection;
    },
    async listManagedCollectionItems(collectionId, input = {}, requestOptions) {
      const query = new URLSearchParams();
      if (input.query !== undefined) query.set("q", input.query);
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const response = await request(
        "list_managed_collection_items",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items${
          query.size ? `?${query.toString()}` : ""
        }`,
        {},
        requestOptions
      );
      const page = parseManagedCollectionItemPage(await readJson(response));
      if (!page) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return page;
    },
    async updateCollectionRetention(collectionId, retentionDays, idempotencyKey, requestOptions) {
      const response = await request(
        "update_collection_retention",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/retention`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({ retentionDays })
        },
        requestOptions
      );
      return requireCollection(await readJson(response));
    },
    async renameManagedCollectionItem(
      collectionId,
      itemId,
      displayName,
      idempotencyKey,
      requestOptions
    ) {
      const response = await request(
        "rename_managed_collection_item",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({ displayName })
        },
        requestOptions
      );
      const item = parseManagedCollectionItem(await readJson(response));
      if (!item) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return item;
    },
    async setManagedCollectionItemsRetention(collectionId, input, idempotencyKey, requestOptions) {
      await request(
        "set_managed_collection_items_retention",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items/retention`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify(input)
        },
        requestOptions
      );
    },
    async deleteManagedCollectionItems(collectionId, itemIds, idempotencyKey, requestOptions) {
      const response = await request(
        "delete_managed_collection_items",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items/delete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({ itemIds })
        },
        requestOptions
      );
      return requireDeleteCollectionItemsResult(await readJson(response));
    },
    async issueManagedContentTickets(collectionId, itemIds, requestOptions) {
      const response = await request(
        "issue_managed_content_tickets",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items/content-tickets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds })
        },
        requestOptions
      );
      const tickets = parseManagedContentTicketBatch(await readJson(response), itemIds);
      if (!tickets) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return tickets;
    },
    async createCollection(name, idempotencyKey, requestOptions) {
      const response = await request(
        "create_collection",
        "/priv/assets/collections",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({ namespace: "line.group.media-sync", name })
        },
        requestOptions
      );
      return requireCollection(await readJson(response));
    },
    async renameCollection(collectionId, name, idempotencyKey, requestOptions) {
      const response = await request(
        "rename_collection",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({ name })
        },
        requestOptions
      );
      return requireCollection(await readJson(response));
    },
    async deleteCollection(collectionId, idempotencyKey, requestOptions) {
      const response = await request(
        "delete_collection",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}`,
        { method: "DELETE", headers: { "idempotency-key": idempotencyKey } },
        requestOptions
      );
      return requireCollection(await readJson(response));
    },
    async addCollectionAcl(collectionId, input, idempotencyKey, requestOptions) {
      const { actorUserId, ...options } = requestOptions;
      const response = await request(
        "add_collection_acl",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/acl`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-hhc-actor-user-id": actorUserId
          },
          body: JSON.stringify({ ...input, permission: "read" })
        },
        options
      );
      return requireCollectionAclMutation(await readJson(response));
    },
    async revokeCollectionAcl(collectionId, aclId, idempotencyKey, requestOptions) {
      const { actorUserId, ...options } = requestOptions;
      const response = await request(
        "revoke_collection_acl",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/acl/${encodeURIComponent(aclId)}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": idempotencyKey, "x-hhc-actor-user-id": actorUserId }
        },
        options
      );
      return requireCollectionAclMutation(await readJson(response));
    },
    async createUpload(input, requestOptions) {
      const response = await request(
        "create_upload",
        "/priv/assets/upload-sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey
          },
          body: JSON.stringify({
            namespace: input.namespace ?? "line.group.file",
            ownerService: "hhc-line-function-bot",
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            purpose: input.purpose,
            originalFileName: input.fileName,
            expectedMimeType: input.mimeType,
            maxSizeBytes: input.maxSizeBytes,
            visibility: "restricted"
          })
        },
        requestOptions
      );
      const value = await readJson(response);
      if (!value || typeof value !== "object" || !("asset" in value)) {
        throw new AssetApiRequestError("asset_api_invalid_response", false);
      }
      const asset = parseAssetRecord(value.asset);
      const uploadTarget =
        "uploadTarget" in value ? parseUploadTarget(value.uploadTarget) : undefined;
      if (!asset || (asset.uploadStatus !== "completed" && !uploadTarget)) {
        throw new AssetApiRequestError("asset_api_invalid_response", false);
      }
      return { asset, ...(uploadTarget ? { uploadTarget } : {}) };
    },
    async upload(target, data, requestOptions) {
      let response: Response;
      try {
        response = await fetcher(target.url, {
          method: target.method || "PUT",
          headers: target.headers,
          body: data,
          signal: requestOptions?.signal
        });
      } catch {
        throw new AssetApiRequestError("asset_upload_unavailable", true);
      }
      if (!response.ok) {
        throw new AssetApiRequestError(
          `asset_upload_${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500
        );
      }
    },
    async uploadFile(target, filePath, requestOptions) {
      await streamUploadFile(target, filePath, requestOptions?.signal);
    },
    async complete(assetId, input, requestOptions) {
      const response = await request(
        "complete_upload",
        `/priv/assets/${encodeURIComponent(assetId)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        },
        requestOptions
      );
      const asset = parseAssetRecord(await readJson(response));
      if (!asset) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return asset;
    },
    async grantServiceRead(assetId, idempotencyKey, requestOptions) {
      const response = await request(
        "grant_service_read",
        `/priv/assets/${encodeURIComponent(assetId)}/grants`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({
            subjectType: "service",
            subjectId: "hhc-line-function-bot",
            permission: "read",
            idempotencyKey
          })
        },
        requestOptions
      );
      const grant = await readJson(response);
      if (
        !grant ||
        typeof grant !== "object" ||
        !("id" in grant) ||
        typeof grant.id !== "string" ||
        !grant.id
      ) {
        throw new AssetApiRequestError("asset_api_invalid_response", false);
      }
      return { id: grant.id };
    },
    async revokeGrant(assetId, grantId, requestOptions) {
      await request(
        "revoke_grant",
        `/priv/assets/${encodeURIComponent(assetId)}/grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
        requestOptions
      );
    },
    async get(assetId, requestOptions) {
      const response = await request(
        "get_asset",
        `/priv/assets/${encodeURIComponent(assetId)}`,
        {},
        requestOptions
      );
      const asset = parseAssetRecord(await readJson(response));
      if (!asset) throw new AssetApiRequestError("asset_api_invalid_response", false);
      return asset;
    },
    async download(assetId, requestOptions) {
      const response = await request(
        "download_asset",
        `/priv/assets/${encodeURIComponent(assetId)}/download`,
        {
          headers: {
            "x-asset-subject-type": "service",
            "x-asset-subject-id": "hhc-line-function-bot"
          }
        },
        requestOptions
      );
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? undefined
      };
    },
    async softDelete(assetId, requestOptions) {
      await request(
        "soft_delete_asset",
        `/priv/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE" },
        requestOptions
      );
    },
    async addCollectionItem(collectionId, input, idempotencyKey, requestOptions) {
      const response = await request(
        "add_collection_item",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify(input)
        },
        requestOptions
      );
      return requireCollectionItemMutation(await readJson(response));
    },
    async deleteCollectionItem(collectionId, itemId, idempotencyKey, requestOptions) {
      const response = await request(
        "delete_collection_item",
        `/priv/assets/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
        { method: "DELETE", headers: { "idempotency-key": idempotencyKey } },
        requestOptions
      );
      return requireCollectionItemMutation(await readJson(response));
    }
  };
}

async function streamUploadFile(
  target: AssetUploadTarget,
  filePath: string,
  signal?: AbortSignal
): Promise<void> {
  const url = new URL(target.url);
  const request =
    url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : undefined;
  if (!request) throw new AssetApiRequestError("asset_upload_invalid_target", false);
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new AssetApiRequestError("asset_upload_invalid_file", false);
    await new Promise<void>((resolve, reject) => {
      const upload = request(
        url,
        {
          method: target.method || "PUT",
          headers: { ...target.headers, "content-length": String(file.size) },
          signal
        },
        (response) => {
          response.resume();
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve();
              return;
            }
            reject(
              new AssetApiRequestError(
                `asset_upload_${status}`,
                status === 408 || status === 429 || status >= 500
              )
            );
          });
        }
      );
      upload.on("error", reject);
      void pipeline(createReadStream(filePath), upload).catch(reject);
    });
  } catch (error) {
    if (error instanceof AssetApiRequestError) throw error;
    throw new AssetApiRequestError("asset_upload_unavailable", true);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
}

function parseAssetRecord(value: unknown): AssetRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const asset = value as Partial<AssetRecord>;
  if (
    typeof asset.id !== "string" ||
    !asset.id ||
    (asset.ownerService !== undefined && typeof asset.ownerService !== "string") ||
    (asset.ownerType !== undefined && typeof asset.ownerType !== "string") ||
    (asset.ownerId !== undefined && typeof asset.ownerId !== "string") ||
    (asset.visibility !== undefined &&
      !["private", "public", "restricted"].includes(asset.visibility)) ||
    !["created", "completed", "failed"].includes(asset.uploadStatus ?? "") ||
    !["pending", "scanning", "clean", "infected", "failed"].includes(asset.scanStatus ?? "") ||
    (asset.scanSignatureVersion !== undefined && typeof asset.scanSignatureVersion !== "string") ||
    (asset.scanFailureCategory !== undefined && typeof asset.scanFailureCategory !== "string") ||
    (asset.etag !== undefined && typeof asset.etag !== "string") ||
    (asset.processingStatus !== undefined &&
      !["not_required", "pending", "ready", "failed"].includes(asset.processingStatus)) ||
    (asset.sizeBytes !== undefined &&
      (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0)) ||
    (asset.checksumSha256 !== undefined && typeof asset.checksumSha256 !== "string") ||
    (asset.detectedMimeType !== undefined && typeof asset.detectedMimeType !== "string")
  ) {
    return undefined;
  }
  return asset as AssetRecord;
}

function requireCollectionItemMutation(value: unknown): CollectionItemMutation {
  if (!isExactRecord(value, ["collection", "item"], ["tombstone"])) {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
  const collection = parseCollection(value.collection);
  const item = parseCollectionItem(value.item);
  if (!collection || !item || !validOptionalTombstone(value.tombstone)) {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
  return { collection, item };
}

function parseCollectionItem(value: unknown): CollectionItemRecord | undefined {
  if (
    !isExactRecord(
      value,
      [
        "id",
        "collectionId",
        "assetId",
        "remoteItemId",
        "displayName",
        "sourceRevision",
        "createdRevision",
        "retentionExempt",
        "updatedRevision",
        "createdAt",
        "updatedAt"
      ],
      ["deletedRevision", "mimeType", "sizeBytes", "etag", "deletedAt"]
    ) ||
    !validOpaqueId(value.id) ||
    !validOpaqueId(value.collectionId) ||
    !validOpaqueId(value.assetId) ||
    typeof value.remoteItemId !== "string" ||
    !value.remoteItemId ||
    typeof value.displayName !== "string" ||
    !value.displayName ||
    typeof value.sourceRevision !== "string" ||
    !value.sourceRevision ||
    !Number.isSafeInteger(value.createdRevision) ||
    (value.createdRevision as number) < 1 ||
    typeof value.retentionExempt !== "boolean" ||
    !Number.isSafeInteger(value.updatedRevision) ||
    (value.updatedRevision as number) < 1 ||
    (value.deletedRevision !== undefined &&
      (!Number.isSafeInteger(value.deletedRevision) || (value.deletedRevision as number) < 1)) ||
    (value.mimeType !== undefined && typeof value.mimeType !== "string") ||
    (value.sizeBytes !== undefined &&
      (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0)) ||
    (value.etag !== undefined && typeof value.etag !== "string") ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt) ||
    (value.deletedAt !== undefined && !validDate(value.deletedAt))
  ) {
    return undefined;
  }
  return value as unknown as CollectionItemRecord;
}

function validOptionalTombstone(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isExactRecord(value, ["id", "remoteItemId", "deletedRevision", "deletedAt"])) return false;
  if (
    value.id === "" &&
    value.remoteItemId === "" &&
    value.deletedRevision === 0 &&
    typeof value.deletedAt === "string" &&
    isZeroTime(value.deletedAt)
  ) {
    return true;
  }
  return (
    validOpaqueId(value.id) &&
    typeof value.remoteItemId === "string" &&
    Boolean(value.remoteItemId) &&
    Number.isSafeInteger(value.deletedRevision) &&
    (value.deletedRevision as number) >= 1 &&
    validDate(value.deletedAt)
  );
}

function parseUploadTarget(value: unknown): AssetUploadTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Partial<AssetUploadTarget>;
  if (
    typeof target.url !== "string" ||
    !target.url.startsWith("https://") ||
    typeof target.method !== "string" ||
    !target.method ||
    !target.headers ||
    typeof target.headers !== "object" ||
    Array.isArray(target.headers) ||
    Object.values(target.headers).some((header) => typeof header !== "string")
  ) {
    return undefined;
  }
  return target as AssetUploadTarget;
}

function requireCollection(value: unknown): CollectionRecord {
  const collection = parseCollection(value);
  if (!collection) throw new AssetApiRequestError("asset_api_invalid_response", false);
  return collection;
}

function requireCollectionAclMutation(value: unknown): CollectionAclMutation {
  if (!isExactRecord(value, ["collection", "acl"])) {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
  const collection = parseCollection(value.collection);
  const acl = parseCollectionAcl(value.acl);
  if (!collection || !acl) {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
  return { collection, acl };
}

function parseManagedCollectionPage(value: unknown): ManagedCollectionPage | undefined {
  if (
    !isExactRecord(value, ["collections", "hasMore"], ["cursor"]) ||
    !Array.isArray(value.collections) ||
    typeof value.hasMore !== "boolean" ||
    (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor))
  ) {
    return undefined;
  }
  const collections = value.collections.map(parseManagedCollection);
  if (collections.some((entry) => entry === undefined)) return undefined;
  return {
    collections: collections as ManagedCollection[],
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    hasMore: value.hasMore
  };
}

function parseManagedCollection(value: unknown): ManagedCollection | undefined {
  if (!isExactRecord(value, ["collection", "acls"]) || !Array.isArray(value.acls)) {
    return undefined;
  }
  const collection = parseCollection(value.collection);
  const acls = value.acls.map(parseCollectionAcl);
  if (!collection || acls.some((entry) => entry === undefined)) return undefined;
  return { collection, acls: acls as CollectionAclRecord[] };
}

function parseManagedCollectionItemPage(value: unknown): ManagedCollectionItemPage | undefined {
  if (
    !isExactRecord(value, ["items", "hasMore"], ["cursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    typeof value.hasMore !== "boolean" ||
    (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor))
  ) {
    return undefined;
  }
  const items = value.items.map(parseManagedCollectionItem);
  if (items.some((item) => item === undefined)) return undefined;
  return {
    items: items as ManagedCollectionItem[],
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    hasMore: value.hasMore
  };
}

export function parseManagedCollectionItem(value: unknown): ManagedCollectionItem | undefined {
  if (
    !isExactRecord(value, [
      "id",
      "displayName",
      "mimeType",
      "sizeBytes",
      "createdAt",
      "retentionExempt"
    ]) ||
    !validOpaqueId(value.id) ||
    typeof value.displayName !== "string" ||
    !value.displayName ||
    Buffer.byteLength(value.displayName, "utf8") > 255 ||
    hasControl(value.displayName) ||
    typeof value.mimeType !== "string" ||
    !value.mimeType ||
    Buffer.byteLength(value.mimeType, "utf8") > 255 ||
    hasControl(value.mimeType) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    !validDate(value.createdAt) ||
    typeof value.retentionExempt !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as ManagedCollectionItem;
}

function parseManagedContentTicketBatch(
  value: unknown,
  requestedItemIds: string[]
): ManagedContentTicketBatch | undefined {
  if (
    !isExactRecord(value, ["tickets", "unavailableItemIds"]) ||
    !Array.isArray(value.tickets) ||
    !Array.isArray(value.unavailableItemIds)
  ) {
    return undefined;
  }
  const tickets = value.tickets.map(parseManagedContentTicket);
  const requested = new Set(requestedItemIds);
  const ticketIds = new Set<string>();
  const unavailableIds = new Set<string>();
  if (
    value.tickets.length + value.unavailableItemIds.length > 100 ||
    tickets.some((ticket) => ticket === undefined) ||
    tickets.some((ticket) => {
      if (!ticket || !requested.has(ticket.itemId) || ticketIds.has(ticket.itemId)) return true;
      ticketIds.add(ticket.itemId);
      return false;
    }) ||
    value.unavailableItemIds.some((itemId) => {
      if (!validOpaqueId(itemId) || !requested.has(itemId) || unavailableIds.has(itemId))
        return true;
      unavailableIds.add(itemId);
      return false;
    }) ||
    [...ticketIds].some((itemId) => unavailableIds.has(itemId))
  ) {
    return undefined;
  }
  return {
    tickets: tickets as ManagedContentTicket[],
    unavailableItemIds: value.unavailableItemIds as string[]
  };
}

function parseManagedContentTicket(value: unknown): ManagedContentTicket | undefined {
  if (
    !isExactRecord(value, ["itemId", "contentUrl", "expiresAt", "etag"]) ||
    !validOpaqueId(value.itemId) ||
    !validContentTicketUrl(value.contentUrl) ||
    !validTicketExpiry(value.expiresAt) ||
    typeof value.etag !== "string" ||
    !value.etag ||
    Buffer.byteLength(value.etag, "utf8") > 1024 ||
    hasControl(value.etag)
  ) {
    return undefined;
  }
  return value as unknown as ManagedContentTicket;
}

function requireDeleteCollectionItemsResult(value: unknown): {
  deleted: number;
  alreadyRemoved: number;
} {
  if (
    !isExactRecord(value, ["deleted", "alreadyRemoved"]) ||
    !Number.isSafeInteger(value.deleted) ||
    (value.deleted as number) < 0 ||
    !Number.isSafeInteger(value.alreadyRemoved) ||
    (value.alreadyRemoved as number) < 0
  ) {
    throw new AssetApiRequestError("asset_api_invalid_response", false);
  }
  return value as { deleted: number; alreadyRemoved: number };
}

function parseCollection(value: unknown): CollectionRecord | undefined {
  if (
    !isExactRecord(
      value,
      ["id", "namespace", "name", "revision", "retentionDays", "createdAt", "updatedAt"],
      ["deletedAt"]
    ) ||
    !validOpaqueId(value.id) ||
    value.namespace !== "line.group.media-sync" ||
    typeof value.name !== "string" ||
    !value.name ||
    hasControl(value.name) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.retentionDays) ||
    (value.retentionDays as number) < 1 ||
    (value.retentionDays as number) > 365 ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt) ||
    (value.deletedAt !== undefined && !validDate(value.deletedAt))
  ) {
    return undefined;
  }
  return {
    id: value.id as string,
    namespace: "line.group.media-sync",
    name: value.name,
    revision: value.revision,
    retentionDays: value.retentionDays as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.deletedAt === "string" && !isZeroTime(value.deletedAt)
      ? { deletedAt: value.deletedAt }
      : {})
  };
}

function parseCollectionAcl(value: unknown): CollectionAclRecord | undefined {
  if (
    !isExactRecord(
      value,
      ["id", "collectionId", "subjectType", "subjectId", "permission", "createdAt"],
      ["revokedAt"]
    ) ||
    !validOpaqueId(value.id) ||
    !validOpaqueId(value.collectionId) ||
    (value.subjectType !== "user" && value.subjectType !== "role") ||
    typeof value.subjectId !== "string" ||
    !value.subjectId ||
    value.permission !== "read" ||
    !validDate(value.createdAt) ||
    (value.revokedAt !== undefined && !validDate(value.revokedAt))
  ) {
    return undefined;
  }
  return {
    id: value.id as string,
    collectionId: value.collectionId as string,
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    permission: "read",
    createdAt: value.createdAt,
    ...(typeof value.revokedAt === "string" && !isZeroTime(value.revokedAt)
      ? { revokedAt: value.revokedAt }
      : {})
  };
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    Buffer.byteLength(value) <= 255 &&
    !hasControl(value)
  );
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value !== "" && Number.isFinite(Date.parse(value));
}

function validContentTicketUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/api/assets/content?") ||
    Buffer.byteLength(value, "utf8") > 2048 ||
    hasControl(value)
  ) {
    return false;
  }
  try {
    const base = new URL("https://asset.invalid");
    const url = new URL(value, base);
    const ticket = url.searchParams.get("ticket");
    return (
      url.origin === base.origin &&
      url.pathname === "/api/assets/content" &&
      url.hash === "" &&
      url.searchParams.size === 1 &&
      url.searchParams.getAll("ticket").length === 1 &&
      typeof ticket === "string" &&
      ticket.trim() !== "" &&
      !hasControl(ticket)
    );
  } catch {
    return false;
  }
}

function validTicketExpiry(value: unknown): value is string {
  if (!validDate(value)) return false;
  const expiresAt = Date.parse(value);
  const now = Date.now();
  return expiresAt > now && expiresAt - now <= 5 * 60_000;
}

function hasControl(value: string): boolean {
  return /\p{Cc}|[\uD800-\uDFFF]/u.test(value);
}

function isZeroTime(value: string): boolean {
  return new Date(value).getUTCFullYear() === 1;
}

function isExactRecord(
  value: unknown,
  required: string[],
  optional: string[] = []
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function toHeaders(value: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(value).entries());
}

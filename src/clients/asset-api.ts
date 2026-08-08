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
  sizeBytes?: number;
  checksumSha256?: string;
  detectedMimeType?: string;
}

export interface AssetUploadTarget {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface AssetApiClient {
  createUpload(
    input: {
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
}

export interface AssetApiRequestOptions {
  signal?: AbortSignal;
}

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

export function createAssetApiClient(options: {
  baseUrl: string;
  getAccessToken: (signal?: AbortSignal) => Promise<string>;
  fetcher?: typeof fetch;
}): AssetApiClient {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const request = async (
    path: string,
    init: RequestInit = {},
    requestOptions?: AssetApiRequestOptions
  ): Promise<Response> => {
    let token: string;
    let response: Response;
    try {
      token = await options.getAccessToken(requestOptions?.signal);
      if (!token.trim()) throw new Error("empty_token");
      response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        signal: requestOptions?.signal,
        headers: { authorization: `Bearer ${token}`, ...toHeaders(init.headers) }
      });
    } catch {
      throw new AssetApiRequestError("asset_api_unavailable", true);
    }
    if (!response.ok) {
      throw new AssetApiRequestError(
        `asset_api_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }
    return response;
  };

  return {
    async createUpload(input, requestOptions) {
      const response = await request(
        "/priv/assets/upload-sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey
          },
          body: JSON.stringify({
            namespace: "line.group.file",
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
    async complete(assetId, input, requestOptions) {
      const response = await request(
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
        `/priv/assets/${encodeURIComponent(assetId)}/grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
        requestOptions
      );
    },
    async get(assetId, requestOptions) {
      const response = await request(
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
        `/priv/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE" },
        requestOptions
      );
    }
  };
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
    (asset.sizeBytes !== undefined &&
      (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0)) ||
    (asset.checksumSha256 !== undefined && typeof asset.checksumSha256 !== "string") ||
    (asset.detectedMimeType !== undefined && typeof asset.detectedMimeType !== "string")
  ) {
    return undefined;
  }
  return asset as AssetRecord;
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

function toHeaders(value: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(value).entries());
}

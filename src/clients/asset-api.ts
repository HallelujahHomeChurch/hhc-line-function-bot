export type AssetScanStatus = "pending" | "scanning" | "clean" | "infected" | "failed";

export interface AssetRecord {
  id: string;
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
  createUpload(input: {
    workId: string;
    lineMessageId: string;
    fileName: string;
    mimeType: string;
    maxSizeBytes: number;
  }): Promise<{ asset: AssetRecord; uploadTarget?: AssetUploadTarget }>;
  upload(target: AssetUploadTarget, data: Uint8Array): Promise<void>;
  complete(
    assetId: string,
    input: { sizeBytes: number; checksumSha256: string; mimeType: string }
  ): Promise<AssetRecord>;
  grantServiceRead(assetId: string, workId: string): Promise<void>;
  get(assetId: string): Promise<AssetRecord>;
  download(assetId: string): Promise<{ data: Uint8Array; contentType?: string }>;
}

export function createAssetApiClient(options: {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}): AssetApiClient {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const token = await options.getAccessToken();
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...toHeaders(init.headers) }
    });
    if (!response.ok) throw new Error(`asset_api_${response.status}`);
    return response;
  };

  return {
    async createUpload(input) {
      const response = await request("/priv/assets/upload-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `line-attachment:${input.workId}`
        },
        body: JSON.stringify({
          namespace: "line.group.file",
          ownerService: "hhc-line-function-bot",
          ownerType: "line_message",
          ownerId: input.lineMessageId,
          purpose: "resource",
          originalFileName: input.fileName,
          expectedMimeType: input.mimeType,
          maxSizeBytes: input.maxSizeBytes,
          visibility: "restricted"
        })
      });
      const value = (await response.json()) as {
        asset: AssetRecord;
        uploadTarget?: AssetUploadTarget;
      };
      if (!value.asset?.id) throw new Error("asset_api_invalid_response");
      return value;
    },
    async upload(target, data) {
      const response = await fetcher(target.url, {
        method: target.method || "PUT",
        headers: target.headers,
        body: data
      });
      if (!response.ok) throw new Error(`asset_upload_${response.status}`);
    },
    async complete(assetId, input) {
      const response = await request(`/priv/assets/${encodeURIComponent(assetId)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      return (await response.json()) as AssetRecord;
    },
    async grantServiceRead(assetId, workId) {
      await request(`/priv/assets/${encodeURIComponent(assetId)}/grants`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `line-attachment-read:${workId}`
        },
        body: JSON.stringify({
          subjectType: "service",
          subjectId: "hhc-line-function-bot",
          permission: "read",
          idempotencyKey: `line-attachment-read:${workId}`
        })
      });
    },
    async get(assetId) {
      const response = await request(`/priv/assets/${encodeURIComponent(assetId)}`);
      return (await response.json()) as AssetRecord;
    },
    async download(assetId) {
      const response = await request(`/priv/assets/${encodeURIComponent(assetId)}/download`, {
        headers: {
          "x-asset-subject-type": "service",
          "x-asset-subject-id": "hhc-line-function-bot"
        }
      });
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? undefined
      };
    }
  };
}

function toHeaders(value: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(value).entries());
}

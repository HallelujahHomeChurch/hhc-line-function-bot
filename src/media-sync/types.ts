export type MediaSyncBinding = {
  id: string;
  profileName: string;
  groupId: string;
  collectionId: string;
  groupDisplayName: string;
  boundByLineUserId?: string;
  bindingCodeCreatedByHhcUserId: string;
  boundAt: string;
  disabledAt?: string;
};

export type CreateMediaSyncBindingCodeInput = {
  profileName: string;
  collectionId: string;
  createdByHhcUserId: string;
  idempotencyKey: string;
  now?: Date;
};

export type CreateMediaSyncBindingCodeResult =
  | { status: "issued"; code: string; expiresAt: string }
  | { status: "already_issued"; expiresAt: string }
  | { status: "collection_bound" };

export type BindMediaSyncCodeInput = {
  profileName: string;
  code: string;
  groupId: string;
  groupDisplayName: string;
  boundByLineUserId?: string;
  now?: Date;
};

export type BindMediaSyncCodeResult =
  | { status: "bound"; binding: MediaSyncBinding }
  | { status: "invalid_code" }
  | { status: "group_already_bound" }
  | { status: "collection_already_bound" };

export type MediaSyncMediaKind = "image" | "video" | "audio" | "file";
export type MediaSyncIngestState =
  "pending" | "processing" | "awaiting_scan" | "ready" | "failed" | "tombstoned";
export type MediaSyncPublicationType = "collection" | "manual";
export type MediaSyncPublicationState = "pending" | "published" | "failed" | "revoked";
export type MediaSyncOutboxOperation = "intake" | "delete";

export type CreateMediaSyncIngestInput = {
  sourceKey: string;
  profileName: string;
  messageId: string;
  groupId: string;
  collectionId: string;
  displayName: string;
  mediaKind: MediaSyncMediaKind;
  expectedMime: string;
  sizeBytes?: number;
  checksumSha256?: string;
};

export type MediaSyncIngest = CreateMediaSyncIngestInput & {
  workId: string;
  assetId?: string;
  assetEtag?: string;
  state: MediaSyncIngestState;
  tombstonedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaSyncOutboxItem = {
  workId: string;
  sourceKey: string;
  operation: MediaSyncOutboxOperation;
  attempts: number;
  availableAt: string;
  claimedUntil?: string;
  dispatchedAt?: string;
  completedAt?: string;
  lastErrorCategory?: string;
};

export type MediaSyncWorkClaim = MediaSyncOutboxItem | "busy" | "terminal" | "missing";

export type MediaSyncPublication = {
  sourceKey: string;
  publicationType: MediaSyncPublicationType;
  destinationId: string;
  targetId?: string;
  state: MediaSyncPublicationState;
  failureCategory?: string;
  requesterUserId?: string;
  jobId?: string;
  manualSourceKey?: string;
  manualItemKind?: string;
  manualDomain?: string;
  manualTitle?: string;
};

export type MediaSyncWork = {
  ingest: MediaSyncIngest;
  publications: MediaSyncPublication[];
};

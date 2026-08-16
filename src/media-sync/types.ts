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
  | { status: "already_issued"; expiresAt: string };

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
export type MediaSyncIngestState = "pending" | "processing" | "ready" | "failed" | "tombstoned";
export type MediaSyncPublicationType = "collection" | "manual";
export type MediaSyncPublicationState = "pending" | "published" | "revoked";
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
  assetId?: string;
  state: MediaSyncIngestState;
  tombstonedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaSyncOutboxItem = {
  sourceKey: string;
  operation: MediaSyncOutboxOperation;
  attempts: number;
  availableAt: string;
  claimedUntil?: string;
  completedAt?: string;
  lastErrorCategory?: string;
};

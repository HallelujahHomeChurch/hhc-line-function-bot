import type { GraphDriveClient, ValidatedSharingLinkResult } from "../types.js";

export async function createValidatedSharingLink(input: {
  graph: GraphDriveClient;
  driveId: string;
  itemId: string;
  expiresAt: string;
}): Promise<ValidatedSharingLinkResult> {
  if (!input.graph.getItemById) {
    return { status: "unavailable", reason: "validator_unavailable" };
  }

  let item;
  try {
    item = await input.graph.getItemById(input.driveId, input.itemId);
  } catch {
    return { status: "unavailable", reason: "validation_failed" };
  }

  if (!item) return { status: "unavailable", reason: "item_missing" };
  if (item.deleted) return { status: "unavailable", reason: "item_deleted" };

  return {
    status: "available",
    item,
    link: await input.graph.createSharingLink(input.driveId, input.itemId, input.expiresAt)
  };
}

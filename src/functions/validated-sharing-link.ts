import type { DriveItem, GraphDriveClient } from "../types.js";

export async function createValidatedSharingLink(input: {
  graph: GraphDriveClient;
  driveId: string;
  itemId: string;
  expiresAt: string;
}): Promise<{ item?: DriveItem; link?: string }> {
  const item = input.graph.getItemById
    ? await input.graph.getItemById(input.driveId, input.itemId)
    : undefined;
  if (input.graph.getItemById && !item) return {};
  return {
    item,
    link: await input.graph.createSharingLink(input.driveId, input.itemId, input.expiresAt)
  };
}

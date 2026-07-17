import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";

import type { DriveItem, GraphConfig, GraphDriveClient } from "../types.js";

interface GraphItem {
  id?: string;
  name?: string;
  webUrl?: string;
  file?: unknown;
  folder?: unknown;
  deleted?: unknown;
  remoteItem?: DriveItem["remoteItem"] & {
    file?: unknown;
    folder?: unknown;
  };
  parentReference?: {
    driveId?: string;
    path?: string;
  };
}

interface GraphPage {
  value?: GraphItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export function createGraphDriveClient(config: GraphConfig): GraphDriveClient {
  const credential = new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret
  );
  const client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken("https://graph.microsoft.com/.default");
        if (!token?.token) {
          throw new Error("graph_access_token_empty");
        }
        return token.token;
      }
    }
  });

  const listFolderChildren = async (
    driveId: string,
    folderItemId: string
  ): Promise<DriveItem[]> => {
    const items: DriveItem[] = [];
    let path = `/drives/${driveId}/items/${folderItemId}/children?$top=200&$select=id,name,webUrl,file,folder,remoteItem,parentReference`;

    while (path) {
      const page = (await client.api(path).get()) as GraphPage;
      for (const item of page.value ?? []) {
        if (item.id && item.name) {
          items.push(graphItemToDriveItem(item, driveId));
        }
      }
      path = page["@odata.nextLink"] ?? "";
    }

    return items;
  };

  return {
    listFolderChildren,

    async listFolderDelta(
      driveId: string,
      folderItemId: string,
      deltaLink?: string
    ): Promise<{ items: DriveItem[]; deltaLink: string }> {
      const items: DriveItem[] = [];
      let path = deltaLink
        ? validateGraphContinuationUrl(deltaLink)
        : `/drives/${driveId}/items/${folderItemId}/delta?$select=id,name,webUrl,file,folder,deleted,remoteItem,parentReference`;
      let nextDeltaLink = "";
      while (path) {
        const page = (await client.api(path).get()) as GraphPage;
        for (const item of page.value ?? []) {
          if (!item.id) {
            continue;
          }
          items.push({
            ...graphItemToDriveItem(item, driveId),
            deleted: Boolean(item.deleted)
          });
        }
        if (page["@odata.nextLink"]) {
          path = validateGraphContinuationUrl(page["@odata.nextLink"]);
          continue;
        }
        nextDeltaLink = page["@odata.deltaLink"]
          ? validateGraphContinuationUrl(page["@odata.deltaLink"])
          : "";
        path = "";
      }
      if (!nextDeltaLink) {
        throw new Error("graph_delta_link_missing");
      }
      return { items, deltaLink: nextDeltaLink };
    },

    async getItemByPath(driveId: string, itemPath: string): Promise<DriveItem | undefined> {
      const encodedPath = itemPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const item = (await client
        .api(
          `/drives/${driveId}/root:/${encodedPath}?$select=id,name,webUrl,file,folder,remoteItem,parentReference`
        )
        .get()) as GraphItem;
      if (!item.id || !item.name) {
        return undefined;
      }
      return graphItemToDriveItem(item, driveId);
    },

    async listFolderFilesRecursive(driveId: string, folderItemId: string): Promise<DriveItem[]> {
      const files: DriveItem[] = [];
      const visited = new Set<string>();
      const visit = async (currentDriveId: string, currentItemId: string, prefix: string) => {
        const key = `${currentDriveId}:${currentItemId}`;
        if (visited.has(key)) {
          return;
        }
        visited.add(key);

        const children = await listFolderChildren(currentDriveId, currentItemId);
        for (const child of children) {
          const childPath = [prefix, child.name].filter(Boolean).join("/");
          if (child.isFolder) {
            const target = resolveDriveItemTraversalTarget(child, currentDriveId);
            await visit(target.driveId, target.itemId, childPath);
            continue;
          }
          files.push({
            ...child,
            driveId: child.driveId ?? currentDriveId,
            path: childPath
          });
        }
      };

      await visit(driveId, folderItemId, "");
      return files;
    },

    async createSharingLink(
      driveId: string,
      itemId: string,
      expirationDateTime: string
    ): Promise<string> {
      const response = (await client.api(`/drives/${driveId}/items/${itemId}/createLink`).post({
        type: config.linkType,
        scope: config.linkScope,
        expirationDateTime
      })) as { link?: { webUrl?: string } };

      if (!response.link?.webUrl) {
        throw new Error("graph_create_link_missing_web_url");
      }

      return response.link.webUrl;
    },

    async uploadFile(
      driveId: string,
      parentItemId: string,
      fileName: string,
      data: Uint8Array,
      contentType: string
    ): Promise<DriveItem> {
      const encodedName = encodeURIComponent(fileName);
      const item = (await client
        .api(`/drives/${driveId}/items/${parentItemId}:/${encodedName}:/content`)
        .header("Content-Type", contentType)
        .put(Buffer.from(data))) as GraphItem;
      if (!item.id || !item.name) {
        throw new Error("graph_upload_missing_item");
      }
      return graphItemToDriveItem(item, driveId);
    },

    async deleteItem(driveId: string, itemId: string): Promise<void> {
      await client.api(`/drives/${driveId}/items/${itemId}`).delete();
    }
  };
}

export function resolveDriveItemTraversalTarget(
  item: DriveItem,
  fallbackDriveId: string
): { driveId: string; itemId: string } {
  return {
    driveId: item.remoteItem?.parentReference?.driveId ?? item.driveId ?? fallbackDriveId,
    itemId: item.remoteItem?.id ?? item.id
  };
}

function graphItemToDriveItem(item: GraphItem, fallbackDriveId: string): DriveItem {
  return {
    id: item.id ?? "",
    driveId: item.parentReference?.driveId ?? fallbackDriveId,
    name: item.name ?? "",
    webUrl: item.webUrl,
    path: item.parentReference?.path,
    isFolder: Boolean(item.folder || item.remoteItem?.folder),
    remoteItem: item.remoteItem
  };
}

function validateGraphContinuationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "graph.microsoft.com") {
    throw new Error("graph_continuation_url_invalid");
  }
  return url.toString();
}

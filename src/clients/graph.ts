import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";

import type { DriveItem, GraphConfig, GraphDriveClient } from "../types.js";

interface GraphPage {
  value?: Array<{ id?: string; name?: string; webUrl?: string }>;
  "@odata.nextLink"?: string;
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

  return {
    async listFolderChildren(driveId: string, folderItemId: string): Promise<DriveItem[]> {
      const items: DriveItem[] = [];
      let path = `/drives/${driveId}/items/${folderItemId}/children?$top=200`;

      while (path) {
        const page = (await client.api(path).get()) as GraphPage;
        for (const item of page.value ?? []) {
          if (item.id && item.name) {
            items.push({ id: item.id, name: item.name, webUrl: item.webUrl });
          }
        }
        path = page["@odata.nextLink"] ?? "";
      }

      return items;
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
    }
  };
}

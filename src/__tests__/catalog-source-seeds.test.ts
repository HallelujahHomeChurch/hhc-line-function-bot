import { describe, expect, it } from "vitest";

import { buildCatalogSourceSeeds, seedCatalogSources } from "../catalog/source-seeds.js";
import { InMemoryCatalogStore } from "../catalog/store.js";

describe("catalog source seeds", () => {
  it("builds built-in helper catalog sources from environment-backed roots", () => {
    const seeds = buildCatalogSourceSeeds({
      env: {
        GRAPH_DRIVE_ID: "drive-1",
        GRAPH_PPT_FOLDER_ITEM_ID: "ppt-root",
        GRAPH_POP_SHEET_DRIVE_ID: "pop-drive",
        GRAPH_POP_SHEET_FOLDER_ITEM_ID: "pop-root",
        GRAPH_HYMN_SHEET_FOLDER_ITEM_ID: "hymn-root",
        GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID: "doc-root",
        GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID: "image-root",
        GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID: "other-root",
        NOTION_SERVICE_DATABASE_ID: "notion-db"
      },
      profileNames: ["helper"]
    });

    expect(seeds.map((source) => source.sourceKey)).toEqual([
      "ppt_slides",
      "pop_sheet_music",
      "hymn_sheet_music",
      "media_team_service_schedule",
      "xiaoha_database"
    ]);
    expect(seeds.find((source) => source.sourceKey === "ppt_slides")?.rootLocation).toEqual({
      driveId: "drive-1",
      folderItemId: "ppt-root"
    });
    expect(seeds.find((source) => source.sourceKey === "pop_sheet_music")).toMatchObject({
      rootLocation: { driveId: "pop-drive", folderItemId: "pop-root" },
      syncPolicy: { allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"] }
    });
    expect(seeds.find((source) => source.sourceKey === "xiaoha_database")?.rootLocation).toEqual({
      driveId: "drive-1",
      documentFolderItemId: "doc-root",
      imageFolderItemId: "image-root",
      otherFolderItemId: "other-root"
    });
  });

  it("seeds missing catalog sources without overwriting existing DB-owned state", async () => {
    const catalog = new InMemoryCatalogStore();
    await catalog.upsertSource({
      profileName: "helper",
      sourceKey: "ppt_slides",
      adapterType: "onedrive",
      domain: "presentation",
      defaultItemKind: "ppt_slide",
      rootLocation: { driveId: "drive-1", folderItemId: "admin-changed-root" },
      enabled: false,
      syncPolicy: { mode: "manual" },
      capabilities: { read: ["custom-read"], write: [] }
    });

    const result = await seedCatalogSources({
      catalog,
      sources: [
        {
          profileName: "helper",
          sourceKey: "ppt_slides",
          adapterType: "onedrive",
          domain: "presentation",
          defaultItemKind: "ppt_slide",
          rootLocation: { driveId: "drive-1", folderItemId: "seed-root" },
          enabled: true,
          syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
          capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
        }
      ]
    });

    expect(result).toEqual({ considered: 1, created: 0 });
    await expect(catalog.listSources({ profileName: "helper" })).resolves.toMatchObject([
      {
        sourceKey: "ppt_slides",
        enabled: false,
        rootLocation: { driveId: "drive-1", folderItemId: "admin-changed-root" },
        syncPolicy: { mode: "manual" },
        capabilities: { read: ["custom-read"], write: [] }
      }
    ]);
  });
});

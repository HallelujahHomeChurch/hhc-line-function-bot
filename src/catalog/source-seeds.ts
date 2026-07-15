import type { BotProfileConfig } from "../types.js";
import type { CatalogSourceInput, CatalogStore } from "./store.js";

export interface BuildCatalogSourceSeedsOptions {
  env: NodeJS.ProcessEnv;
  profileNames: string[];
}

export interface SeedCatalogSourcesOptions {
  catalog: CatalogStore;
  sources: CatalogSourceInput[];
}

export interface SeedCatalogSourcesResult {
  considered: number;
  created: number;
}

export function buildCatalogSourceSeeds(
  options: BuildCatalogSourceSeedsOptions
): CatalogSourceInput[] {
  if (!options.profileNames.includes("helper")) {
    return [];
  }
  const env = options.env;
  const sources: CatalogSourceInput[] = [];
  const driveId = env.GRAPH_DRIVE_ID?.trim();
  const sheetMusicExtensions = readExtensions(
    env.SHEET_MUSIC_ALLOWED_EXTENSIONS || "pdf,jpg,jpeg,png"
  );

  addOneDriveSource(sources, {
    profileName: "helper",
    sourceKey: "ppt_slides",
    domain: "presentation",
    defaultItemKind: "ppt_slide",
    driveId,
    folderItemId: env.GRAPH_PPT_FOLDER_ITEM_ID,
    enabled: true,
    capabilities: { read: ["helper"], write: ["helper:ppt_slide:write"] }
  });
  addOneDriveSource(sources, {
    profileName: "helper",
    sourceKey: "pop_sheet_music",
    domain: "sheet_music",
    defaultItemKind: "pop_sheet",
    driveId: env.GRAPH_POP_SHEET_DRIVE_ID?.trim() || driveId,
    folderItemId: env.GRAPH_POP_SHEET_FOLDER_ITEM_ID,
    enabled: true,
    allowedExtensions: sheetMusicExtensions,
    capabilities: { read: ["helper"], write: ["helper:pop_sheet:write"] }
  });
  addOneDriveSource(sources, {
    profileName: "helper",
    sourceKey: "hymn_sheet_music",
    domain: "sheet_music",
    defaultItemKind: "hymn_sheet",
    driveId,
    folderItemId: env.GRAPH_HYMN_SHEET_FOLDER_ITEM_ID,
    enabled: true,
    allowedExtensions: sheetMusicExtensions,
    capabilities: { read: ["helper"], write: ["helper:hymn_sheet:write"] }
  });
  const databaseId = env.NOTION_SERVICE_DATABASE_ID?.trim();
  if (databaseId) {
    sources.push({
      profileName: "helper",
      sourceKey: "media_team_service_schedule",
      adapterType: "notion",
      domain: "schedule",
      defaultItemKind: "media_service_schedule",
      rootLocation: { databaseId },
      enabled: true,
      syncPolicy: { mode: "scheduled", intervalMinutes: 15 },
      capabilities: { read: ["query_schedule"], write: [] }
    });
  }

  addXiaohaDatabaseSource(sources, env, driveId);
  addOneDriveSource(sources, {
    profileName: "helper",
    sourceKey: "weekly_report_audio",
    domain: "audio",
    defaultItemKind: "weekly_report_audio",
    driveId,
    folderItemId: env.GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID,
    enabled: false,
    capabilities: { read: ["helper"], write: [] }
  });

  return sources;
}

export function buildCatalogSourceSeedsForProfiles(
  env: NodeJS.ProcessEnv,
  profiles: Pick<BotProfileConfig, "name">[]
): CatalogSourceInput[] {
  return buildCatalogSourceSeeds({
    env,
    profileNames: profiles.map((profile) => profile.name)
  });
}

export async function seedCatalogSources(
  options: SeedCatalogSourcesOptions
): Promise<SeedCatalogSourcesResult> {
  let created = 0;
  for (const source of options.sources) {
    const result = await options.catalog.createSourceIfMissing(source);
    if (result.created) {
      created += 1;
    }
  }
  return { considered: options.sources.length, created };
}

function addOneDriveSource(
  sources: CatalogSourceInput[],
  input: {
    profileName: string;
    sourceKey: string;
    domain: string;
    defaultItemKind: string;
    driveId: string | undefined;
    folderItemId: string | undefined;
    enabled: boolean;
    allowedExtensions?: string[];
    capabilities: CatalogSourceInput["capabilities"];
  }
): void {
  const folderItemId = input.folderItemId?.trim();
  if (!input.driveId || !folderItemId) {
    return;
  }
  sources.push({
    profileName: input.profileName,
    sourceKey: input.sourceKey,
    adapterType: "onedrive",
    domain: input.domain,
    defaultItemKind: input.defaultItemKind,
    rootLocation: { driveId: input.driveId, folderItemId },
    enabled: input.enabled,
    syncPolicy: {
      mode: "scheduled",
      intervalMinutes: 15,
      ...(input.allowedExtensions ? { allowedExtensions: input.allowedExtensions } : {})
    },
    capabilities: input.capabilities
  });
}

function readExtensions(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
    )
  );
}

function addXiaohaDatabaseSource(
  sources: CatalogSourceInput[],
  env: NodeJS.ProcessEnv,
  driveId: string | undefined
): void {
  const documentFolderItemId = env.GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID?.trim();
  const imageFolderItemId = env.GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID?.trim();
  const otherFolderItemId = env.GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID?.trim();
  if (!driveId || !documentFolderItemId || !imageFolderItemId || !otherFolderItemId) {
    return;
  }
  sources.push({
    profileName: "helper",
    sourceKey: "xiaoha_database",
    adapterType: "manual",
    domain: "general",
    defaultItemKind: "church_document",
    rootLocation: { driveId, documentFolderItemId, imageFolderItemId, otherFolderItemId },
    enabled: true,
    syncPolicy: { mode: "manual" },
    capabilities: { read: ["helper"], write: ["helper:church_database:write"] }
  });
}

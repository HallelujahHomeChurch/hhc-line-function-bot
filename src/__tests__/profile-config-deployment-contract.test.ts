import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("production profile configuration deployment contract", () => {
  it("ships file-backed profiles and does not deploy an ACA profile secret", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const manifest = readProjectFile("aca.containerapp.yaml");
    const pipeline = readProjectFile("azure-pipelines.yml");

    expect(dockerfile).toContain("COPY config ./config");
    expect(manifest).toContain("name: PROFILE_CONFIG_PATH");
    expect(manifest).toContain("value: /app/config/profiles.json");
    expect(manifest).not.toContain("name: CATALOG_SOURCES_PATH");
    expect(manifest).toContain("dapr:\n      enabled: false");
    expect(manifest).toContain("name: GRAPH_POP_SHEET_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_POP_SHEET_DRIVE_ID");
    expect(manifest).toContain("name: GRAPH_HYMN_SHEET_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID");
    expect(manifest).not.toContain("name: GRAPH_SHEET_MUSIC_FOLDER_PATH");
    expect(manifest).not.toContain("name: SHEET_MUSIC_DEFAULT_RECURSIVE");
    expect(manifest).not.toContain("BOT_PROFILES_BASE64_JSON");
    expect(manifest).not.toContain("bot-profiles-base64-json");
    expect(pipeline).toContain("- config/**");
    expect(pipeline).toContain("pnpm config:validate");
    expect(pipeline).toContain("PROFILE_CONFIG_PATH=/app/config/profiles.json");
    expect(pipeline).toContain("--remove-env-vars");
    expect(pipeline).toContain("az containerapp dapr disable");
    expect(pipeline).toContain("--secret-names bot-profiles-base64-json");
    expect(pipeline).not.toContain("--secret-name bot-profiles-base64-json");
    expect(readProjectFile("README.md")).toContain("sole complete");
    expect(readProjectFile("README.md")).not.toContain("Example shape:");
    expect(readProjectFile("README.md")).not.toContain('"personaPrompt"');
    expect(readProjectFile("README.md")).toContain("durable source registry");
    expect(readProjectFile(".env.example")).not.toContain("BOT_PROFILES_JSON=");
    expect(readProjectFile(".env.example")).not.toContain("BOT_PROFILES_BASE64_JSON=");
    expect(readProjectFile(".env.example")).not.toContain("CATALOG_SOURCES_PATH");
  });

  it("defines a scheduled ACA catalog sync job that reuses the app image", () => {
    const job = readProjectFile("aca.catalog-sync-job.yaml");
    const pipeline = readProjectFile("azure-pipelines.yml");
    const readme = readProjectFile("README.md");

    expect(job).toContain("type: Microsoft.App/jobs");
    expect(job).toContain("triggerType: Schedule");
    expect(job).toContain('cronExpression: "*/15 * * * *"');
    expect(job).toContain("replicaTimeout: 600");
    expect(job).toContain("image: alive.azurecr.io/alive/hhc-line-function-bot:latest");
    expect(job).not.toContain("command:");
    expect(job).toContain("args:");
    expect(job).toContain("- dist/tools/sync-catalog.js");
    expect(job).not.toContain("name: CATALOG_SOURCES_PATH");
    expect(job).toContain("name: GRAPH_POP_SHEET_FOLDER_ITEM_ID");
    expect(job).toContain("name: GRAPH_POP_SHEET_DRIVE_ID");
    expect(job).toContain("name: GRAPH_HYMN_SHEET_FOLDER_ITEM_ID");
    expect(job).toContain("name: GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID");
    expect(job).toContain("name: GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID");
    expect(job).toContain("name: GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID");
    expect(job).toContain("name: GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID");
    expect(job).not.toContain("name: GRAPH_SHEET_MUSIC_FOLDER_PATH");
    expect(job).not.toContain("name: SHEET_MUSIC_DEFAULT_RECURSIVE");
    expect(job).toContain("name: PROFILE_CONFIG_PATH");
    expect(job).toContain("value: /app/config/profiles.json");
    expect(job).toContain("name: DATABASE_URL");
    expect(job).toContain("name: LINE_HELPER_CHANNEL_SECRET");
    expect(job).toContain("name: LINE_HELPER_CHANNEL_ACCESS_TOKEN");
    expect(job).toContain("name: LINE_HELPER_ADMIN_USER_ID");
    expect(job).toContain("name: GRAPH_CLIENT_SECRET");
    expect(job).toContain("name: NOTION_TOKEN");
    expect(job).toContain("name: NOTION_SERVICE_DATABASE_ID");
    expect(job).not.toContain("ingress:");
    expect(pipeline).toContain("- aca.catalog-sync-job.yaml");
    expect(readme).toContain("aca.catalog-sync-job.yaml");
    expect(readme).toContain("node dist/tools/sync-catalog.js");
  });
});

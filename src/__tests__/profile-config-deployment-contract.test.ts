import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function projectFileExists(path: string): boolean {
  return existsSync(resolve(root, path));
}

describe("production profile configuration deployment contract", () => {
  it("ships file-backed profiles and does not deploy an ACA profile secret", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const manifest = readProjectFile("aca.containerapp.yaml");
    const ciWorkflow = readProjectFile(".github/workflows/ci.yml");
    const releaseWorkflow = readProjectFile(".github/workflows/release.yml");
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const profiles = JSON.parse(readProjectFile("config/profiles.json")) as Array<{
      name: string;
      allowedMessageTypes: string[];
      enabledFunctions: string[];
      controlledAgent?: {
        enabled: boolean;
        shadow: boolean;
        maxCandidates: number;
        minPlannerConfidence: number;
      };
      providerPolicy?: {
        function_routing?: { primary: string; fallback?: string };
      };
    }>;
    const helper = profiles.find((profile) => profile.name === "helper");

    expect(dockerfile).toContain("COPY config ./config");
    expect(manifest).toContain("name: PROFILE_CONFIG_PATH");
    expect(manifest).toContain("value: /app/config/profiles.json");
    expect(manifest).not.toContain("name: CATALOG_SOURCES_PATH");
    expect(manifest).toContain("dapr:\n      enabled: true");
    expect(manifest).toContain("appId: hhc-line-function-bot");
    expect(manifest).toContain("appPort: 3000");
    expect(manifest).toContain("appProtocol: http");
    expect(manifest).toContain("name: GRAPH_POP_SHEET_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_POP_SHEET_DRIVE_ID");
    expect(manifest).toContain("name: GRAPH_HYMN_SHEET_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_DOCUMENT_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_IMAGE_FOLDER_ITEM_ID");
    expect(manifest).toContain("name: GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID");
    expect(manifest).not.toContain("name: GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID");
    expect(manifest).not.toContain("name: GRAPH_SHEET_MUSIC_FOLDER_PATH");
    expect(manifest).not.toContain("name: SHEET_MUSIC_DEFAULT_RECURSIVE");
    expect(manifest).toContain("name: SEARXNG_BASE_URL");
    expect(manifest).toContain("name: CLAMAV_HOST");
    expect(manifest).toContain("name: CLAMAV_PORT");
    expect(manifest).toContain("name: MAX_ATTACHMENT_BYTES");
    expect(manifest).toContain("name: observability-hmac-key");
    expect(manifest).toContain("name: OBSERVABILITY_HMAC_KEY");
    expect(manifest).toContain("secretRef: observability-hmac-key");
    expect(manifest).toContain('value: "26214400"');
    expect(manifest).toContain("name: LINE_CONTENT_DOWNLOAD_TIMEOUT_MS");
    expect(manifest).toContain('value: "30000"');
    expect(manifest).toContain("name: EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS");
    expect(manifest).toContain("name: EXTERNAL_RESOURCE_MAX_REDIRECTS");
    expect(manifest).not.toContain("BOT_PROFILES_BASE64_JSON");
    expect(manifest).not.toContain("bot-profiles-base64-json");
    expect(releaseWorkflow).toContain("- config/**");
    expect(ciWorkflow).toContain("pnpm config:validate");
    expect(deployment).toContain("PROFILE_CONFIG_PATH=/app/config/profiles.json");
    expect(deployment).toContain("OBSERVABILITY_HMAC_KEY=secretref:observability-hmac-key");
    expect(deployment).toContain("--remove-env-vars");
    expect(deployment).toContain("az containerapp dapr enable");
    expect(deployment).toContain('--dapr-app-id "hhc-line-function-bot"');
    expect(deployment).toContain("--dapr-app-port 3000");
    expect(deployment).not.toContain("az containerapp dapr disable");
    expect(deployment).toContain("SEARXNG_BASE_URL=http://172.16.65.5:8888");
    expect(deployment).toContain("CLAMAV_HOST=172.16.65.5");
    expect(deployment).toContain("MAX_ATTACHMENT_BYTES=26214400");
    expect(deployment).toContain("LINE_CONTENT_DOWNLOAD_TIMEOUT_MS=30000");
    expect(deployment).toContain("EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS=15000");
    expect(deployment).toContain("EXTERNAL_RESOURCE_MAX_REDIRECTS=3");
    expect(deployment).toContain("OLLAMA_EMBEDDING_MODEL=bge-m3");
    expect(deployment).toContain("EMBEDDING_BATCH_SIZE=16");
    expect(deployment).toContain("EMBEDDING_TIMEOUT_MS=30000");
    expect(deployment).toContain("EMBEDDING_KEEP_ALIVE=1m");
    expect(helper?.enabledFunctions).toEqual(
      expect.arrayContaining(["find_resource", "save_resource", "save_memory", "retrieve_memory"])
    );
    expect(helper?.allowedMessageTypes).toEqual(expect.arrayContaining(["text", "image", "file"]));
    expect(helper?.controlledAgent).toEqual({
      maxCandidates: 3,
      minPlannerConfidence: 0.65
    });
    expect(helper?.providerPolicy?.function_routing).toEqual({
      primary: "deepseek"
    });
    expect(readProjectFile("README.md")).toContain("sole complete");
    expect(readProjectFile("README.md")).not.toContain("Example shape:");
    expect(readProjectFile("README.md")).not.toContain('"personaPrompt"');
    expect(readProjectFile("README.md")).toContain("durable source registry");
    expect(readProjectFile(".env.example")).not.toContain("BOT_PROFILES_JSON=");
    expect(readProjectFile(".env.example")).not.toContain("BOT_PROFILES_BASE64_JSON=");
    expect(readProjectFile(".env.example")).not.toContain("CATALOG_SOURCES_PATH");
  });

  it("validates pull requests before a separate main-only production release", () => {
    const ciWorkflow = readProjectFile(".github/workflows/ci.yml");
    const releaseWorkflow = readProjectFile(".github/workflows/release.yml");

    expect(ciWorkflow).toContain("name: PR CI");
    expect(ciWorkflow).toContain("pull_request:");
    expect(ciWorkflow).not.toContain("push:");
    expect(ciWorkflow).toContain("contents: read");
    expect(ciWorkflow).not.toContain("id-token: write");
    expect(ciWorkflow).toContain("pnpm format:check");
    expect(ciWorkflow).toContain("pnpm typecheck");
    expect(ciWorkflow).toContain("pnpm lint");
    expect(ciWorkflow).toContain("pnpm test");
    expect(ciWorkflow).toContain("pnpm config:validate");
    expect(ciWorkflow).toContain("pnpm eval:agent");
    expect(ciWorkflow).toContain("pnpm eval:kernel");
    expect(ciWorkflow.indexOf("pnpm eval:kernel")).toBeLessThan(ciWorkflow.indexOf("pnpm build"));
    expect(ciWorkflow).toContain("pnpm build");

    expect(releaseWorkflow).toContain("name: Production Release");
    expect(releaseWorkflow).toContain("push:");
    expect(releaseWorkflow).toContain("branches: [main]");
    expect(releaseWorkflow).not.toContain("pull_request:");
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("az acr build");
    expect(releaseWorkflow).toContain("bash scripts/deploy-aca.sh");
    expect(releaseWorkflow).not.toContain("pnpm ");

    expect(projectFileExists(".github/workflows/hhc-line-function-bot.yml")).toBe(false);
    expect(projectFileExists("azure-pipelines.yml")).toBe(false);
  });

  it("defines a scheduled ACA catalog sync job that reuses the app image", () => {
    const job = readProjectFile("aca.catalog-sync-job.yaml");
    const releaseWorkflow = readProjectFile(".github/workflows/release.yml");
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
    expect(job).not.toContain("name: GRAPH_WEEKLY_REPORT_AUDIO_FOLDER_ITEM_ID");
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
    expect(job).toContain("name: OLLAMA_BASE_URL");
    expect(job).toContain("secretRef: ollama-base-url");
    expect(job).toContain("name: OLLAMA_EMBEDDING_MODEL");
    expect(job).toContain("value: bge-m3");
    expect(job).toContain("name: EMBEDDING_BATCH_SIZE");
    expect(job).toContain("name: EMBEDDING_TIMEOUT_MS");
    expect(job).toContain("name: EMBEDDING_KEEP_ALIVE");
    expect(job).not.toContain("ingress:");
    expect(releaseWorkflow).toContain("- aca.catalog-sync-job.yaml");
    expect(readme).toContain("aca.catalog-sync-job.yaml");
    expect(readme).toContain("node dist/tools/sync-catalog.js");
  });

  it("defines private restartable workstation search and scanner services", () => {
    const compose = readProjectFile("infra/local-services/docker-compose.yml");
    const startup = readProjectFile("scripts/start-local-services.ps1");
    const installer = readProjectFile("scripts/install-local-services-autostart.ps1");

    expect(compose).toContain("searxng/searxng@sha256:");
    expect(compose).toContain("clamav/clamav@sha256:");
    expect(compose.match(/restart: unless-stopped/g)).toHaveLength(2);
    expect(compose.match(/healthcheck:/g)).toHaveLength(2);
    expect(compose).toContain('"8888:8080"');
    expect(compose).toContain('"3310:3310"');
    expect(startup).toContain("Docker Desktop.exe");
    expect(startup).toContain("docker compose --project-directory");
    expect(installer).toContain("/SC ONLOGON");
    expect(installer).toContain('GetFolderPath("Startup")');
  });
});

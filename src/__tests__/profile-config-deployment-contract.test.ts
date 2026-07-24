import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const retiredOfficeAddress = ["172", "16", "65", "5"].join(".");
const retiredEndpointNames = [["CLAM", "AV_HOST"].join(""), ["CLAM", "AV_PORT"].join("")];
const retiredEndpointPrefixes = [["OLLA", "MA_"].join(""), ["VIRUS_", "SCAN_"].join("")];

function readProjectFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function projectFileExists(path: string): boolean {
  return existsSync(resolve(root, path));
}

describe("production profile configuration deployment contract", () => {
  it("hosts SearXNG as an internal always-on ACA app without office-network routes", () => {
    const searxng = readProjectFile("aca.searxng.containerapp.yaml");
    const bot = readProjectFile("aca.containerapp.yaml");
    const deployment = readProjectFile("scripts/deploy-aca.sh");

    expect(searxng).toContain("type: Microsoft.App/containerApps");
    expect(searxng).toContain("external: false");
    expect(searxng).toContain("targetPort: 8080");
    expect(searxng).toContain("minReplicas: 1");
    expect(searxng).toContain("searxng/searxng@sha256:");
    expect(searxng).toContain("storageType: Secret");
    expect(searxng).toContain("mountPath: /etc/searxng");
    expect(searxng).toContain("secretRef: searxng-settings");
    expect(searxng).not.toContain("storageType: AzureFile");
    expect(bot).not.toContain("SEARXNG_BASE_URL\n            value: http://");

    for (const path of [
      "aca.containerapp.yaml",
      "aca.searxng.containerapp.yaml",
      "scripts/deploy-aca.sh"
    ]) {
      expect(readProjectFile(path)).not.toContain(retiredOfficeAddress);
    }

    expect(deployment).toContain("SEARXNG_CONTAINER_APP_NAME:=hhc-searxng");
    expect(deployment).toContain("properties.configuration.ingress.fqdn");
    expect(deployment).toContain('searxng_base_url="https://${searxng_fqdn}"');
    expect(deployment).toContain('"SEARXNG_BASE_URL=${searxng_base_url}"');
    expect(deployment.indexOf('az containerapp update --yaml "${searxng_manifest}"')).toBeLessThan(
      deployment.indexOf('az containerapp update "${update_args[@]}"')
    );
    const searxngUpdateStart = deployment.indexOf(
      'az containerapp update --yaml "${searxng_manifest}"'
    );
    const searxngUpdate = deployment.slice(
      searxngUpdateStart,
      deployment.indexOf("\nelse", searxngUpdateStart)
    );
    expect(searxngUpdate).toContain('--resource-group "${RESOURCE_GROUP}"');
    expect(searxngUpdate).toContain('--name "${SEARXNG_CONTAINER_APP_NAME}"');
    expect(projectFileExists("infra/searxng/settings.yml")).toBe(true);
  });

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
    expect(deployment).toContain('"SEARXNG_BASE_URL=${searxng_base_url}"');
    expect(deployment).toContain("MAX_ATTACHMENT_BYTES=26214400");
    expect(deployment).toContain("LINE_CONTENT_DOWNLOAD_TIMEOUT_MS=30000");
    expect(deployment).toContain("EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS=15000");
    expect(deployment).toContain("EXTERNAL_RESOURCE_MAX_REDIRECTS=3");
    expect(deployment).toContain(
      "AZURE_OPENAI_EMBEDDING_RESOURCE_NAME:=bible-text-embedding-resource"
    );
    expect(deployment).toContain("az cognitiveservices account deployment list");
    expect(deployment).toContain("az cognitiveservices account keys list");
    expect(deployment).toContain('"azure-openai-embedding-key=${azure_openai_embedding_key}"');
    expect(deployment).toContain(
      '"AZURE_OPENAI_EMBEDDING_API_KEY=secretref:azure-openai-embedding-key"'
    );
    expect(deployment).toContain("EMBEDDING_PROVIDER=azure_openai");
    expect(deployment).toContain(
      "AZURE_OPENAI_EMBEDDING_DEPLOYMENT=${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}"
    );
    expect(deployment).toContain(
      "AZURE_OPENAI_EMBEDDING_API_VERSION=${AZURE_OPENAI_EMBEDDING_API_VERSION}"
    );
    expect(deployment).toContain("EMBEDDING_MODEL=text-embedding-3-small");
    expect(deployment).not.toContain("https://api.openai.com");
    expect(deployment).toContain("EMBEDDING_BATCH_SIZE=16");
    expect(deployment).toContain("EMBEDDING_TIMEOUT_MS=30000");
    expect(deployment).not.toContain("EMBEDDING_KEEP_ALIVE=");
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
    expect(ciWorkflow).toContain("pnpm eval:kernel:integration");
    expect(ciWorkflow.indexOf("pnpm eval:kernel")).toBeLessThan(ciWorkflow.indexOf("pnpm build"));
    expect(ciWorkflow.indexOf("pnpm eval:kernel:integration")).toBeLessThan(
      ciWorkflow.indexOf("pnpm build")
    );
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

  it("owns a loopback-only disposable Redis AOF and pgvector integration stack", () => {
    const compose = readProjectFile("compose.kernel-integration.yml");
    const vitestConfig = readProjectFile("vitest.config.ts");
    const integrationVitestConfig = readProjectFile("vitest.kernel-integration.config.ts");
    const integrationCli = readProjectFile("src/tools/eval-kernel-integration.ts");

    expect(compose).toContain("redis:7.4.2-alpine");
    expect(compose).toContain("pgvector/pgvector:0.8.1-pg16");
    expect(compose).toContain("--appendonly");
    expect(compose).toContain("--appendfsync");
    expect(compose).toContain('"127.0.0.1:${KERNEL_REDIS_PORT}:6379"');
    expect(compose).toContain('"127.0.0.1:${KERNEL_POSTGRES_PORT}:5432"');
    expect(compose.match(/healthcheck:/g)).toHaveLength(2);
    expect(compose).toContain("redis-data:");
    expect(compose).toContain("postgres-data:");
    expect(vitestConfig).toContain("kernel-redis-integration.test.ts");
    expect(vitestConfig).toContain("kernel-postgres-integration.test.ts");
    expect(integrationVitestConfig).toContain("testTimeout: 60_000");
    expect(integrationCli).toContain("kernel-redis-integration.test.ts");
    expect(integrationCli).toContain("kernel-postgres-integration.test.ts");
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
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_API_KEY");
    expect(job).toContain("secretRef: azure-openai-embedding-key");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_ENDPOINT");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_API_VERSION");
    expect(job).toContain("name: EMBEDDING_MODEL");
    expect(job).toContain("value: text-embedding-3-small");
    expect(job).toContain("name: EMBEDDING_BATCH_SIZE");
    expect(job).toContain("name: EMBEDDING_TIMEOUT_MS");
    expect(job).not.toContain("ingress:");
    expect(releaseWorkflow).toContain("- aca.catalog-sync-job.yaml");
    expect(readme).toContain("aca.catalog-sync-job.yaml");
    expect(readme).toContain("node dist/tools/sync-catalog.js");
  });

  it("provisions finite queue scans and atomic scheduled ClamAV signature refreshes", () => {
    const scanJob = readProjectFile("aca.attachment-scan-job.yaml");
    const refreshJob = readProjectFile("aca.clamav-signature-refresh-job.yaml");
    const bot = readProjectFile("aca.containerapp.yaml");
    const catalogJob = readProjectFile("aca.catalog-sync-job.yaml");
    const dockerfile = readProjectFile("Dockerfile");
    const releaseWorkflow = readProjectFile(".github/workflows/release.yml");
    const deployment = readProjectFile("scripts/deploy-aca.sh");

    expect(scanJob).toContain("type: Microsoft.App/jobs");
    expect(scanJob).toContain("triggerType: Event");
    expect(scanJob).toContain("eventTriggerConfig:");
    expect(scanJob).toContain("minExecutions: 0");
    expect(scanJob).toContain("replicaTimeout: 900");
    expect(scanJob).toContain("parallelism: 1");
    expect(scanJob).toContain("replicaCompletionCount: 1");
    expect(scanJob).toContain("type: azure-queue");
    expect(scanJob).toContain("queueLength: 1");
    expect(scanJob).toContain("triggerParameter: connection");
    expect(scanJob).toContain("secretRef: attachment-scan-queue-connection-string");
    expect(scanJob).toContain("name: LINE_HELPER_CHANNEL_ACCESS_TOKEN");
    expect(scanJob).toContain("name: DATABASE_URL");
    expect(scanJob).toContain("name: REDIS_URL");
    expect(scanJob).toContain("name: GRAPH_CLIENT_SECRET");
    expect(scanJob).not.toContain("name: LINE_HELPER_CHANNEL_SECRET");
    expect(scanJob).not.toContain("name: LINE_HELPER_ADMIN_USER_ID");
    expect(scanJob).not.toContain("name: AZURE_OPENAI_EMBEDDING_API_KEY");
    expect(scanJob).not.toContain("name: DEEPSEEK_API_KEY");
    expect(scanJob).not.toContain("name: NOTION_TOKEN");
    expect(scanJob).not.toContain("name: OBSERVABILITY_HMAC_KEY");
    expect(scanJob).not.toContain("name: ATTACHMENT_SCAN_QUEUE_URL");
    expect(scanJob).toContain("image: alive.azurecr.io/alive/hhc-line-function-bot-scan:latest");
    expect(scanJob).toContain("cpu: 1.0");
    expect(scanJob).toContain("memory: 4Gi");
    expect(scanJob).toContain("mountPath: /var/lib/clamav");
    expect(scanJob).toContain("storageName: clamav-signatures-readonly");
    expect(scanJob).not.toContain("ingress:");

    expect(refreshJob).toContain("type: Microsoft.App/jobs");
    expect(refreshJob).toContain("triggerType: Schedule");
    expect(refreshJob).toContain('cronExpression: "10 19 */2 * *"');
    expect(refreshJob).toContain("parallelism: 1");
    expect(refreshJob).toContain("replicaCompletionCount: 1");
    expect(refreshJob).toContain("dist/tools/refresh-clamav-signatures.js");
    expect(refreshJob).toContain("mountPath: /var/lib/clamav");
    expect(refreshJob).toContain("storageName: clamav-signatures-readwrite");
    expect(refreshJob).not.toContain("ingress:");
    expect(dockerfile).toContain('"clamav-freshclam=${CLAMAV_VERSION}"');
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("UpdateLogFile /tmp/hhc-line-bot-freshclam.log");
    expect(dockerfile.indexOf("clamav-freshclam")).toBeLessThan(
      dockerfile.indexOf("FROM gcr.io/distroless")
    );

    expect(bot).toContain("name: ATTACHMENT_SCAN_QUEUE_URL");
    expect(bot).toContain("secretRef: attachment-scan-queue-url");
    expect(bot).not.toContain("name: CLAMAV_DATABASE_DIRECTORY");
    expect(catalogJob).not.toContain("name: CLAMAV_DATABASE_DIRECTORY");
    expect(catalogJob).toContain("name: ATTACHMENT_SCAN_QUEUE_URL");

    expect(releaseWorkflow).toContain("- aca.attachment-scan-job.yaml");
    expect(releaseWorkflow).toContain("- aca.clamav-signature-refresh-job.yaml");
    expect(releaseWorkflow).toContain("--target attachment-scan-worker");
    expect(releaseWorkflow).toContain("SCAN_IMAGE_REPOSITORY");

    expect(deployment).toContain("az containerapp env storage set");
    expect(deployment).toContain("az storage account keys list");
    expect(deployment).not.toContain('secrets.get("clamav-signature-storage-key")');
    expect(deployment).toContain("--storage-name clamav-signatures-readonly");
    expect(deployment).toContain("--access-mode ReadOnly");
    expect(deployment).toContain("--storage-name clamav-signatures-readwrite");
    expect(deployment).toContain("--access-mode ReadWrite");
    expect(deployment).toContain("az containerapp secret set");
    expect(deployment).toContain("az storage queue generate-sas");
    expect(deployment).toContain("--permissions a");
    expect(deployment).toContain('"attachment-scan-queue-url=${attachment_scan_queue_url}"');
    expect(deployment).not.toContain(
      '"attachment-scan-queue-url=${attachment_scan_queue_connection_string}"'
    );
    expect(deployment).toContain("legacy_openai_embedding_secret");
    expect(deployment).not.toContain('"OPENAI_API_KEY=secretref:openai-api-key"');
    expect(bot).not.toContain("name: OPENAI_API_KEY");
    expect(bot).not.toContain("name: OPENAI_BASE_URL");
    expect(bot).not.toContain("name: OPENAI_EMBEDDING_MODEL");
    expect(catalogJob).not.toContain("name: OPENAI_API_KEY");
    expect(catalogJob).not.toContain("name: OPENAI_BASE_URL");
    expect(catalogJob).not.toContain("name: OPENAI_EMBEDDING_MODEL");
    expect(deployment).toContain("az containerapp job update");
    expect(deployment).toContain("ATTACHMENT_SCAN_JOB_NAME");
    expect(deployment).toContain("CLAMAV_SIGNATURE_REFRESH_JOB_NAME");
    expect(deployment).toContain("CONTAINER_APP_JOB_IDENTITY_NAME:=hhc-line-bot-jobs");
    expect(deployment).toContain("az identity show");
    expect(deployment).toContain("CONTAINER_APP_JOB_IDENTITY_ID");

    for (const jobManifest of [catalogJob, scanJob, refreshJob]) {
      expect(jobManifest).toContain("type: UserAssigned");
      expect(jobManifest).toContain("PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID: {}");
      expect(jobManifest).toContain("registries:");
      expect(jobManifest).toContain("server: alive.azurecr.io");
      expect(jobManifest).toContain("identity: PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID");
    }

    const retiredEnvBlock = deployment.slice(
      deployment.indexOf("retired_exact = {"),
      deployment.indexOf("retired_prefixes =")
    );
    for (const name of [
      "LLM_PROVIDER",
      "LLM_FALLBACK_PROVIDER",
      "EMBEDDING_KEEP_ALIVE",
      "CLAMAV_TIMEOUT_MS"
    ]) {
      expect(retiredEnvBlock).toContain(`"${name}"`);
    }
    expect(deployment).toContain('retired_provider_token = "".join(("OLLA", "MA"))');
    expect(deployment).toContain('or f"_{retired_provider_token}_" in name');

    const queueSecretDeploy = deployment.indexOf("az containerapp secret set");
    const searxngDeploy = deployment.indexOf('az containerapp update --yaml "${searxng_manifest}"');
    const botDeploy = deployment.indexOf('az containerapp update "${update_args[@]}"');
    const refreshedSecretSnapshot = deployment.indexOf(
      'bot_secrets_json="$(az containerapp secret list',
      botDeploy
    );
    const refreshedEnvSnapshot = deployment.indexOf(
      'bot_env_json="$(az containerapp show',
      botDeploy
    );
    const refreshDeploy = deployment.indexOf('deploy_job "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"');
    const refreshBootstrap = deployment.indexOf(
      'start_job_and_wait "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"'
    );
    const scanDeploy = deployment.indexOf('deploy_job "${ATTACHMENT_SCAN_JOB_NAME}"');
    expect(queueSecretDeploy).toBeGreaterThanOrEqual(0);
    expect(queueSecretDeploy).toBeLessThan(botDeploy);
    expect(refreshedSecretSnapshot).toBeGreaterThan(botDeploy);
    expect(refreshedEnvSnapshot).toBeGreaterThan(botDeploy);
    expect(searxngDeploy).toBeGreaterThanOrEqual(0);
    expect(searxngDeploy).toBeLessThan(botDeploy);
    expect(botDeploy).toBeLessThan(refreshDeploy);
    expect(refreshDeploy).toBeLessThan(refreshBootstrap);
    expect(refreshBootstrap).toBeLessThan(scanDeploy);
    expect(refreshDeploy).toBeLessThan(scanDeploy);

    for (const contents of [scanJob, refreshJob, bot, catalogJob]) {
      for (const name of retiredEndpointNames) {
        expect(contents).not.toContain(name);
      }
      for (const prefix of retiredEndpointPrefixes) {
        expect(contents).not.toContain(prefix);
      }
      expect(contents).not.toContain(retiredOfficeAddress);
    }
    expect(bot).not.toContain("mountPath: /var/lib/clamav");
    expect(catalogJob).not.toContain("mountPath: /var/lib/clamav");
  });

  it("does not ship workstation auxiliary-service startup assets", () => {
    expect(projectFileExists("infra/local-services/docker-compose.yml")).toBe(false);
    expect(projectFileExists("scripts/start-local-services.ps1")).toBe(false);
    expect(projectFileExists("scripts/install-local-services-autostart.ps1")).toBe(false);
  });
});

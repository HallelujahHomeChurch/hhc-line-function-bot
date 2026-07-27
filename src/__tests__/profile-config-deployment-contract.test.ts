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
    expect(searxng).toContain("resources:");
    expect(searxng).toContain("cpu: 0.25");
    expect(searxng).toContain("memory: 0.5Gi");
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
    expect(deployment).toContain('SEARXNG_BASE_URL="${searxng_base_url}"');
    expect(deployment.indexOf('az containerapp update --yaml "${searxng_manifest}"')).toBeLessThan(
      deployment.indexOf('--yaml "${bot_manifest}"')
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

  it("deploys the bot from a secret-value-free rendered manifest before dependent jobs", () => {
    const manifest = readProjectFile("aca.containerapp.yaml");
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const secretRefs = [
      ["ATTACHMENT_SCAN_QUEUE_URL", "PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_URL_SECRET_REF"],
      ["LINE_HELPER_CHANNEL_SECRET", "PLACEHOLDER_LINE_HELPER_CHANNEL_SECRET_REF"],
      [
        "LINE_HELPER_CHANNEL_ACCESS_TOKEN",
        "PLACEHOLDER_LINE_HELPER_CHANNEL_ACCESS_TOKEN_SECRET_REF"
      ],
      ["LINE_HELPER_ADMIN_USER_ID", "PLACEHOLDER_LINE_HELPER_ADMIN_USER_ID_SECRET_REF"],
      ["AZURE_OPENAI_EMBEDDING_API_KEY", "PLACEHOLDER_AZURE_OPENAI_EMBEDDING_API_KEY_SECRET_REF"],
      ["DEEPSEEK_API_KEY", "PLACEHOLDER_DEEPSEEK_API_KEY_SECRET_REF"],
      ["OBSERVABILITY_HMAC_KEY", "PLACEHOLDER_OBSERVABILITY_HMAC_KEY_SECRET_REF"],
      ["DATABASE_URL", "PLACEHOLDER_DATABASE_URL_SECRET_REF"],
      ["REDIS_URL", "PLACEHOLDER_REDIS_URL_SECRET_REF"],
      ["GRAPH_CLIENT_SECRET", "PLACEHOLDER_GRAPH_CLIENT_SECRET_REF"],
      ["NOTION_TOKEN", "PLACEHOLDER_NOTION_TOKEN_SECRET_REF"]
    ] as const;

    expect(manifest).toMatch(/^name: PLACEHOLDER_CONTAINER_APP_NAME$/m);
    expect(manifest).toContain("dapr:\n      enabled: true");
    expect(manifest).toContain("appId: hhc-line-function-bot");
    expect(manifest).toContain("appPort: 3000");
    expect(manifest).toContain("appProtocol: http");
    expect(manifest).toContain("ingress:\n      external: false");
    expect(manifest).toContain("type: Liveness");
    expect(manifest).toContain("path: /healthz");
    expect(manifest).toContain("type: Readiness");
    expect(manifest).toContain("path: /readyz");
    expect(manifest).toContain("scale:");
    expect(manifest).toContain("minReplicas:");
    expect(manifest).toContain("maxReplicas:");
    expect(manifest).toContain("resources:");
    expect(manifest).toContain("cpu:");
    expect(manifest).toContain("memory:");

    for (const [envName, placeholder] of secretRefs) {
      expect(manifest).toContain(`- name: ${envName}\n            secretRef: ${placeholder}`);
      expect(manifest.match(new RegExp(placeholder, "g"))).toHaveLength(1);
    }
    expect(manifest.match(/secretRef:/g)).toHaveLength(secretRefs.length);
    expect(manifest).not.toMatch(/\n {4}secrets:/);
    expect(manifest).not.toContain("PLACEHOLDER_SET_IN_AZURE_CONTAINER_APP_SECRETS");
    expect(manifest).not.toContain("attachment-scan-queue-connection-string");
    expect(manifest).not.toContain("clamav-signature-storage-key");

    expect(deployment).toContain('bot_manifest_template="${script_dir}/../aca.containerapp.yaml"');
    expect(deployment).toContain('bot_manifest="$(mktemp)"');
    expect(deployment).toContain('"${bot_manifest}"');
    expect(deployment).toContain('! -f "${bot_manifest_template}"');
    expect(deployment).toContain('if "PLACEHOLDER_" in text:');
    expect(deployment).toContain('raise SystemExit("A bot manifest placeholder was not resolved")');
    expect(deployment).toContain('Path(os.environ["BOT_MANIFEST"]).write_text(text)');
    expect(deployment).toContain('CONTAINER_APP_NAME="${CONTAINER_APP_NAME}"');
    expect(deployment).toContain(
      '"PLACEHOLDER_CONTAINER_APP_NAME": os.environ["CONTAINER_APP_NAME"]'
    );

    const searxngDeploy = deployment.indexOf('az containerapp update --yaml "${searxng_manifest}"');
    const botRendererStart = deployment.indexOf('BOT_MANIFEST_TEMPLATE="${bot_manifest_template}"');
    const botApplyStart = deployment.indexOf(
      'az containerapp update \\\n  --resource-group "${RESOURCE_GROUP}"',
      botRendererStart
    );
    const botRenderer = deployment.slice(botRendererStart, botApplyStart);
    const botDeploy = deployment.indexOf('--yaml "${bot_manifest}"', botApplyStart);
    const refreshedSecretSnapshot = deployment.indexOf(
      'bot_secrets_json="$(az containerapp secret list',
      botDeploy
    );
    const refreshedEnvSnapshot = deployment.indexOf(
      'bot_env_json="$(az containerapp show',
      botDeploy
    );
    const renderJobs = deployment.indexOf('render_job_manifest \\\n  "${clamav_refresh');
    const refreshDeploy = deployment.indexOf('deploy_job "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"');
    const refreshBootstrap = deployment.indexOf(
      'start_release_job \\\n  "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"'
    );
    const scanDeploy = deployment.indexOf('deploy_job "${ATTACHMENT_SCAN_JOB_NAME}"');
    const catalogDeploy = deployment.indexOf('deploy_job "${CATALOG_SYNC_JOB_NAME}"');

    for (const position of [
      searxngDeploy,
      botRendererStart,
      botApplyStart,
      botDeploy,
      refreshedSecretSnapshot,
      refreshedEnvSnapshot,
      renderJobs,
      refreshDeploy,
      refreshBootstrap,
      scanDeploy,
      catalogDeploy
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(searxngDeploy).toBeLessThan(botDeploy);
    expect(botDeploy).toBeLessThan(refreshedSecretSnapshot);
    expect(botDeploy).toBeLessThan(refreshedEnvSnapshot);
    expect(refreshedSecretSnapshot).toBeLessThan(renderJobs);
    expect(refreshedEnvSnapshot).toBeLessThan(renderJobs);
    expect(renderJobs).toBeLessThan(refreshDeploy);
    expect(refreshDeploy).toBeLessThan(refreshBootstrap);
    expect(refreshBootstrap).toBeLessThan(scanDeploy);
    expect(scanDeploy).toBeLessThan(catalogDeploy);

    expect(botRenderer).not.toContain("BOT_SECRETS_JSON");
    expect(botRenderer).not.toContain("--show-values");
    expect(deployment).not.toContain("update_args=(");
    expect(deployment).not.toContain('az containerapp update "${update_args[@]}"');
    expect(deployment).not.toContain("az containerapp dapr enable");
  });

  it("keeps every bot template placeholder in lockstep with the guarded renderer map", () => {
    const manifest = readProjectFile("aca.containerapp.yaml");
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const rendererStart = deployment.indexOf('BOT_MANIFEST_TEMPLATE="${bot_manifest_template}"');
    const rendererEnd = deployment.indexOf(
      'az containerapp update \\\n  --resource-group "${RESOURCE_GROUP}"',
      rendererStart
    );
    const renderer = deployment.slice(rendererStart, rendererEnd);
    const templatePlaceholders = manifest.match(/\bPLACEHOLDER_[A-Z0-9_]+\b/g) ?? [];
    const directRendererPlaceholders = [
      ...renderer.matchAll(/^\s+"(PLACEHOLDER_[A-Z0-9_]+)":/gm)
    ].map((match) => match[1]);
    const sourceEnvBlock = renderer.slice(
      renderer.indexOf("source_env_names = ["),
      renderer.indexOf("]\nfor name in source_env_names:")
    );
    const sourceEnvPlaceholders = [...sourceEnvBlock.matchAll(/^\s+"([A-Z][A-Z0-9_]+)",$/gm)].map(
      (match) => `PLACEHOLDER_${match[1]}`
    );
    const rendererPlaceholders = [...directRendererPlaceholders, ...sourceEnvPlaceholders];

    expect(rendererStart).toBeGreaterThanOrEqual(0);
    expect(rendererEnd).toBeGreaterThan(rendererStart);
    expect(renderer).toContain("if text.count(placeholder) != 1:");
    expect([...new Set(templatePlaceholders)].sort()).toEqual(
      [...new Set(rendererPlaceholders)].sort()
    );
    for (const placeholder of new Set(templatePlaceholders)) {
      expect(templatePlaceholders.filter((candidate) => candidate === placeholder)).toHaveLength(1);
    }
    expect(rendererPlaceholders).toHaveLength(new Set(rendererPlaceholders).size);
  });

  it("cleans all retired bot secrets before dependent job snapshots", () => {
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const botDeploy = deployment.indexOf('--yaml "${bot_manifest}"');
    const retiredSecretCleanup = deployment.indexOf("retired_bot_secrets=(");
    const refreshedSecretSnapshot = deployment.indexOf(
      'bot_secrets_json="$(az containerapp secret list',
      botDeploy
    );
    const refreshedEnvSnapshot = deployment.indexOf(
      'bot_env_json="$(az containerapp show',
      botDeploy
    );
    const retiredSecretCleanupBlock = deployment.slice(
      retiredSecretCleanup,
      refreshedSecretSnapshot
    );

    expect(retiredSecretCleanup).toBeGreaterThan(botDeploy);
    expect(retiredSecretCleanup).toBeLessThan(refreshedSecretSnapshot);
    expect(retiredSecretCleanup).toBeLessThan(refreshedEnvSnapshot);
    for (const retiredSecret of [
      "bot-profiles-base64-json",
      "attachment-scan-queue-connection-string",
      "clamav-signature-storage-key",
      "openai-api-key"
    ]) {
      expect(retiredSecretCleanupBlock).toContain(retiredSecret);
    }
    expect(deployment).toContain(
      'ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING="${attachment_scan_queue_connection_string}"'
    );
  });

  it("explicitly clears bot container and template mounts", () => {
    const manifest = readProjectFile("aca.containerapp.yaml");

    expect(manifest).toContain("        volumeMounts: []");
    expect(manifest).toContain("\n    volumes: []\n    scale:");
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
    expect(manifest).toContain("name: OBSERVABILITY_HMAC_KEY");
    expect(manifest).toContain("secretRef: PLACEHOLDER_OBSERVABILITY_HMAC_KEY_SECRET_REF");
    expect(manifest).toContain('value: "26214400"');
    expect(manifest).toContain("name: LINE_CONTENT_DOWNLOAD_TIMEOUT_MS");
    expect(manifest).toContain('value: "30000"');
    expect(manifest).toContain("name: EXTERNAL_RESOURCE_DOWNLOAD_TIMEOUT_MS");
    expect(manifest).toContain("name: EXTERNAL_RESOURCE_MAX_REDIRECTS");
    expect(manifest).not.toContain("BOT_PROFILES_BASE64_JSON");
    expect(manifest).not.toContain("bot-profiles-base64-json");
    expect(releaseWorkflow).toContain("- config/**");
    expect(ciWorkflow).toContain("pnpm config:validate");
    expect(deployment).toContain('"PLACEHOLDER_OBSERVABILITY_HMAC_KEY_SECRET_REF"');
    expect(deployment).toContain('"observability-hmac-key"');
    expect(deployment).not.toContain("--remove-env-vars");
    expect(deployment).not.toContain("az containerapp dapr enable");
    expect(deployment).not.toContain("az containerapp dapr disable");
    expect(deployment).toContain('SEARXNG_BASE_URL="${searxng_base_url}"');
    expect(deployment).toContain(
      "AZURE_OPENAI_EMBEDDING_RESOURCE_NAME:=bible-text-embedding-resource"
    );
    expect(deployment).toContain("az cognitiveservices account deployment list");
    expect(deployment).toContain("az cognitiveservices account keys list");
    expect(deployment).toContain('"azure-openai-embedding-key=${azure_openai_embedding_key}"');
    expect(deployment).toContain('"PLACEHOLDER_AZURE_OPENAI_EMBEDDING_API_KEY_SECRET_REF"');
    expect(deployment).toContain(
      'AZURE_OPENAI_EMBEDDING_ENDPOINT="${azure_openai_embedding_endpoint}"'
    );
    expect(deployment).toContain(
      'AZURE_OPENAI_EMBEDDING_DEPLOYMENT="${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}"'
    );
    expect(deployment).toContain(
      'AZURE_OPENAI_EMBEDDING_API_VERSION="${AZURE_OPENAI_EMBEDDING_API_VERSION}"'
    );
    expect(deployment).toContain('"PLACEHOLDER_AZURE_OPENAI_EMBEDDING_DEPLOYMENT": os.environ[');
    expect(deployment).toContain('"PLACEHOLDER_AZURE_OPENAI_EMBEDDING_API_VERSION": os.environ[');
    expect(deployment).not.toContain("https://api.openai.com");
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
    expect(job).toContain("name: OBSERVABILITY_HMAC_KEY");
    expect(job).toContain("secretRef: observability-hmac-key");
    expect(job).toContain("name: NOTION_SERVICE_DATABASE_ID");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_API_KEY");
    expect(job).toContain("secretRef: azure-openai-embedding-key");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_ENDPOINT");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    expect(job).toContain("name: AZURE_OPENAI_EMBEDDING_API_VERSION");
    for (const name of [
      "AZURE_OPENAI_EMBEDDING_ENDPOINT",
      "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
      "AZURE_OPENAI_EMBEDDING_API_VERSION"
    ]) {
      expect(job).toContain(`- name: ${name}\n            value: PLACEHOLDER_COPY_FROM_BOT_ENV`);
    }
    expect(job).not.toContain(
      "value: https://bible-text-embedding-resource.cognitiveservices.azure.com/"
    );
    expect(job).toContain("name: EMBEDDING_MODEL");
    expect(job).toContain("value: text-embedding-3-small");
    expect(job).toContain("name: EMBEDDING_BATCH_SIZE");
    expect(job).toContain("name: EMBEDDING_TIMEOUT_MS");
    expect(job).not.toContain("ingress:");
    expect(releaseWorkflow).toContain("- aca.catalog-sync-job.yaml");
    expect(readme).toContain("aca.catalog-sync-job.yaml");
    expect(readme).toContain("node dist/tools/sync-catalog.js");
  });

  it("defines a finite provider-free release probe job", () => {
    expect(projectFileExists("aca.release-probe-job.yaml")).toBe(true);
    const job = readProjectFile("aca.release-probe-job.yaml");

    expect(job).toMatch(/^name: hhc-line-bot-release-probe$/m);
    expect(job).toContain("type: Microsoft.App/jobs");
    expect(job).toContain("triggerType: Manual");
    expect(job).toContain("replicaTimeout: 300");
    expect(job).toContain("replicaRetryLimit: 0");
    expect(job).toContain("parallelism: 1");
    expect(job).toContain("replicaCompletionCount: 1");
    expect(job).toContain("type: UserAssigned");
    expect(job).toContain("PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID: {}");
    expect(job).toContain("server: alive.azurecr.io");
    expect(job).toContain("identity: PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID");
    expect(job).toContain("image: alive.azurecr.io/alive/hhc-line-function-bot:latest");
    expect(job).toContain("args:\n          - dist/tools/run-release-probe.js");
    expect(job).not.toContain("command:");
    expect(job).toContain("cpu: 0.25");
    expect(job).toContain("memory: 0.5Gi");
    expect(job).toContain("name: LINE_HELPER_CHANNEL_SECRET");
    expect(job).toContain("secretRef: line-helper-channel-secret");
    expect(job.match(/secretRef:/g)).toHaveLength(1);
    expect(job).toContain("name: BOT_BASE_URL");
    expect(job).toContain("value: PLACEHOLDER_BOT_BASE_URL");
    expect(job).toContain("name: SEARXNG_BASE_URL");
    expect(job).toContain("value: PLACEHOLDER_SEARXNG_BASE_URL");
    expect(job).toContain("name: GATEWAY_WEBHOOK_URL");
    expect(job).toContain("value: PLACEHOLDER_GATEWAY_WEBHOOK_URL");
    expect(job).toContain("name: CLAMAV_SIGNATURE_MANIFEST_PATH");
    expect(job).toContain("value: /var/lib/clamav/current/manifest.json");
    expect(job).toContain("mountPath: /var/lib/clamav");
    expect(job).toContain("storageName: clamav-signatures-readonly");
    expect(job).not.toContain("scheduleTriggerConfig:");
    expect(job).not.toContain("cronExpression:");
    expect(job).not.toContain("ingress:");
    expect(job).not.toContain("name: DEEPSEEK_API_KEY");
    expect(job).not.toMatch(/name: (?:AZURE_OPENAI_)?EMBEDDING_/);
  });

  it("defines a finite provider-free periodic assurance job", () => {
    expect(projectFileExists("aca.periodic-assurance-job.yaml")).toBe(true);
    const job = readProjectFile("aca.periodic-assurance-job.yaml");

    expect(job).toMatch(/^name: hhc-line-bot-periodic-assurance$/m);
    expect(job).toContain("type: Microsoft.App/jobs");
    expect(job).toContain("triggerType: Manual");
    expect(job).toContain("replicaTimeout: 600");
    expect(job).toContain("replicaRetryLimit: 0");
    expect(job).toContain("parallelism: 1");
    expect(job).toContain("replicaCompletionCount: 1");
    expect(job).toContain("type: UserAssigned");
    expect(job).toContain("PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID: {}");
    expect(job).toContain("server: alive.azurecr.io");
    expect(job).toContain("identity: PLACEHOLDER_CONTAINER_APP_JOB_IDENTITY_ID");
    expect(job).toContain("image: alive.azurecr.io/alive/hhc-line-function-bot-scan:latest");
    expect(job).toContain("args:\n          - dist/tools/run-periodic-assurance.js");
    expect(job).not.toContain("command:");
    expect(job).toContain("cpu: 2");
    expect(job).toContain("memory: 4Gi");
    expect(job).toContain("name: GRAPH_CLIENT_SECRET");
    expect(job).toContain("secretRef: graph-client-secret");
    expect(job).toContain("name: NOTION_TOKEN");
    expect(job).toContain("secretRef: notion-token");
    expect(job).toContain("name: ATTACHMENT_SCAN_QUEUE_CONNECTION_STRING");
    expect(job).toContain("secretRef: attachment-scan-queue-connection-string");
    expect(job.match(/secretRef:/g)).toHaveLength(3);
    expect(job).toContain("name: GRAPH_TENANT_ID");
    expect(job).toContain("name: GRAPH_CLIENT_ID");
    expect(job).toContain("name: GRAPH_DRIVE_ID");
    expect(job).toContain("name: GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID");
    expect(job).toContain("name: NOTION_SERVICE_DATABASE_ID");
    expect(job).toContain("name: ATTACHMENT_SCAN_QUEUE_NAME");
    expect(job).toContain("name: CLAMAV_SCAN_TIMEOUT_MS");
    expect(job).toContain('value: "15000"');
    expect(job).toContain("name: CLAMAV_SIGNATURE_MANIFEST_PATH");
    expect(job).toContain("value: /var/lib/clamav/current/manifest.json");
    expect(job).toContain("mountPath: /var/lib/clamav");
    expect(job).toContain("storageName: clamav-signatures-readonly");
    expect(job).not.toContain("scheduleTriggerConfig:");
    expect(job).not.toContain("cronExpression:");
    expect(job).not.toContain("ingress:");
    expect(job).not.toContain("name: DEEPSEEK_API_KEY");
    expect(job).not.toMatch(/name: (?:AZURE_OPENAI_)?EMBEDDING_/);
  });

  it("renders and deploys immutable assurance jobs before uploading the release report", () => {
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const releaseWorkflow = readProjectFile(".github/workflows/release.yml");

    expect(deployment).toContain("required_release_environment=(");
    expect(deployment).toMatch(/required_release_environment=\([\s\S]*RELEASE_PROBE_JOB_NAME/);
    expect(deployment).toMatch(/required_release_environment=\([\s\S]*PERIODIC_ASSURANCE_JOB_NAME/);
    expect(deployment).toContain("API_GATEWAY_CONTAINER_APP_NAME:=api-gateway");
    expect(deployment).toContain('bot_base_url="https://${bot_fqdn}"');
    expect(deployment).toContain(
      'gateway_webhook_url="https://${api_gateway_fqdn}/api/line/webhook/helper"'
    );
    expect(deployment).toContain('BOT_BASE_URL="${bot_base_url}"');
    expect(deployment).toContain('SEARXNG_BASE_URL="${searxng_base_url}"');
    expect(deployment).toContain('GATEWAY_WEBHOOK_URL="${gateway_webhook_url}"');
    expect(deployment).toContain('"PLACEHOLDER_BOT_BASE_URL": os.environ["BOT_BASE_URL"]');
    expect(deployment).toContain('"PLACEHOLDER_SEARXNG_BASE_URL": os.environ["SEARXNG_BASE_URL"]');
    expect(deployment).toContain(
      '"PLACEHOLDER_GATEWAY_WEBHOOK_URL": os.environ["GATEWAY_WEBHOOK_URL"]'
    );
    expect(deployment).toContain("if text.count(placeholder) != 1:");
    expect(deployment).toContain(
      'render_job_manifest \\\n  "${release_probe_job_manifest_template}"'
    );
    expect(deployment).toContain(
      'render_job_manifest \\\n  "${periodic_assurance_job_manifest_template}"'
    );
    expect(deployment).toContain('"${RELEASE_PROBE_JOB_NAME}" \\\n  "${image_ref}"');
    expect(deployment).toContain('"${PERIODIC_ASSURANCE_JOB_NAME}" \\\n  "${scan_image_ref}"');
    expect(deployment).toContain(
      'deploy_job "${RELEASE_PROBE_JOB_NAME}" "${release_probe_job_manifest}"'
    );
    expect(deployment).toContain(
      'deploy_job "${PERIODIC_ASSURANCE_JOB_NAME}" "${periodic_assurance_job_manifest}"'
    );
    expect(deployment).not.toMatch(/cat "\$\{(?:release_probe|periodic_assurance)_job_manifest\}"/);

    expect(releaseWorkflow).toContain("- aca.release-probe-job.yaml");
    expect(releaseWorkflow).toContain("- aca.periodic-assurance-job.yaml");
    expect(releaseWorkflow).toContain("RELEASE_PROBE_JOB_NAME: hhc-line-bot-release-probe");
    expect(releaseWorkflow).toContain(
      "PERIODIC_ASSURANCE_JOB_NAME: hhc-line-bot-periodic-assurance"
    );
    expect(releaseWorkflow).toContain(
      "RELEASE_REPORT_PATH: artifacts/release-assurance/report.json"
    );
    expect(releaseWorkflow).toContain("uses: actions/upload-artifact@v4");
    expect(releaseWorkflow).toContain("if: always()");
    expect(releaseWorkflow).toContain("path: artifacts/release-assurance/report.json");
    expect(releaseWorkflow).toContain("if-no-files-found: error");
    expect(releaseWorkflow).not.toContain("pnpm ");
    const azureLoginSteps = [...releaseWorkflow.matchAll(/uses: azure\/login@v2/gu)];
    const finalImageBuild = releaseWorkflow.lastIndexOf("az acr build");
    const refreshedLogin = azureLoginSteps.at(1)?.index ?? -1;
    const deploy = releaseWorkflow.indexOf("bash scripts/deploy-aca.sh");
    const upload = releaseWorkflow.indexOf("uses: actions/upload-artifact@v4");
    expect(azureLoginSteps).toHaveLength(2);
    expect(finalImageBuild).toBeGreaterThanOrEqual(0);
    expect(refreshedLogin).toBeGreaterThan(finalImageBuild);
    expect(deploy).toBeGreaterThan(refreshedLogin);
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(deploy);
  });

  it("schedules weekly periodic assurance with OIDC and always uploads its fixed report", () => {
    expect(projectFileExists(".github/workflows/periodic-assurance.yml")).toBe(true);
    const workflow = readProjectFile(".github/workflows/periodic-assurance.yml");

    expect(workflow).toContain('cron: "30 20 * * 1"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read\n  id-token: write");
    expect(workflow).toContain("uses: azure/login@v2");
    expect(workflow).toContain("client-id: ${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("tenant-id: ${{ vars.AZURE_TENANT_ID }}");
    expect(workflow).toContain("subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).toContain("bash scripts/run-periodic-assurance.sh");
    expect(workflow).toContain(
      "PERIODIC_REPORT_PATH: artifacts/release-assurance/periodic-report.json"
    );
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain("path: artifacts/release-assurance/periodic-report.json");
    expect(workflow).not.toMatch(/containerapp (?:update|revision|ingress)/);
    expect(workflow).not.toMatch(/deepseek|embedding|eval:agent:live/iu);
    const login = workflow.indexOf("uses: azure/login@v2");
    const extension = workflow.indexOf("az extension add --name containerapp");
    const runner = workflow.indexOf("bash scripts/run-periodic-assurance.sh");
    const upload = workflow.indexOf("uses: actions/upload-artifact@v4");
    const runnerStepStart = workflow.lastIndexOf("- name:", runner);
    const uploadStepStart = workflow.lastIndexOf("- name:", upload);
    const runnerStep = workflow.slice(runnerStepStart, uploadStepStart);
    const uploadStep = workflow.slice(uploadStepStart);
    expect(login).toBeGreaterThanOrEqual(0);
    expect(extension).toBeGreaterThan(login);
    expect(runner).toBeGreaterThan(extension);
    expect(runner).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(runner);
    expect(runnerStep).toContain("if: always()");
    expect(uploadStep).toContain("if: always()");
    expect(uploadStep).toContain("if-no-files-found: error");
  });

  it("wraps every bot and dependent-job mutation in the recoverable release transaction", () => {
    const deployment = readProjectFile("scripts/deploy-aca.sh");
    const helper = readProjectFile("scripts/release-assurance.sh");
    const helperSource = deployment.indexOf('source "${script_dir}/release-assurance.sh"');
    const snapshot = deployment.indexOf("capture_known_good_state");
    const exitTrap = deployment.indexOf("release_assurance_on_exit");
    const mutationMark = deployment.indexOf("mark_release_mutated");
    const firstProductionWrite = deployment.indexOf("az containerapp secret set");
    const botApply = deployment.indexOf(
      'az containerapp update \\\n  --resource-group "${RESOURCE_GROUP}"',
      mutationMark
    );
    const gate = deployment.indexOf("run_release_gates");
    const report = deployment.indexOf("write_release_report");
    const complete = deployment.indexOf("complete_release_transaction");

    for (const position of [
      helperSource,
      snapshot,
      exitTrap,
      mutationMark,
      firstProductionWrite,
      botApply,
      gate,
      report,
      complete
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(helperSource).toBeLessThan(exitTrap);
    expect(exitTrap).toBeLessThan(snapshot);
    expect(exitTrap).toBeLessThan(mutationMark);
    expect(snapshot).toBeLessThan(mutationMark);
    expect(mutationMark).toBeLessThan(firstProductionWrite);
    expect(firstProductionWrite).toBeLessThan(botApply);
    expect(botApply).toBeLessThan(gate);
    expect(gate).toBeLessThan(report);
    expect(report).toBeLessThan(complete);
    expect(deployment).toContain('RELEASE_TARGET_REVISION="${target_revision}"');
    expect(deployment).toContain('RELEASE_TARGET_IMAGE="${image_ref}"');
    expect(deployment).toContain('RELEASE_TARGET_SCAN_IMAGE="${scan_image_ref}"');
    expect(deployment).toContain(
      'RELEASE_CLAMAV_BOOTSTRAP_EXECUTION_NAME="${RELEASE_STARTED_EXECUTION_NAME}"'
    );
    for (const jobName of [
      "CLAMAV_SIGNATURE_REFRESH_JOB_NAME",
      "ATTACHMENT_SCAN_JOB_NAME",
      "CATALOG_SYNC_JOB_NAME",
      "RELEASE_PROBE_JOB_NAME",
      "PERIODIC_ASSURANCE_JOB_NAME"
    ]) {
      expect(deployment.indexOf(`mark_release_job_mutated "\${${jobName}}"`)).toBeLessThan(
        deployment.indexOf(`deploy_job "\${${jobName}}"`)
      );
    }
    expect(deployment).not.toContain("trap 'rm -f");
    expect(helper).toContain("RELEASE_POLL_ATTEMPTS:=30");
    expect(helper).toContain("az containerapp revision copy");
    expect(helper).toContain('--from-revision "${RELEASE_KNOWN_GOOD_REVISION}"');
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
    expect(scanJob).toContain("cpu: 2.0");
    expect(scanJob).toContain("memory: 4Gi");
    expect(scanJob).toContain("mountPath: /var/lib/clamav");
    expect(scanJob).toContain("storageName: clamav-signatures-readonly");
    expect(scanJob).toContain('name: CLAMAV_SIGNATURE_WARNING_AGE_HOURS\n            value: "168"');
    expect(scanJob).not.toContain("ingress:");

    expect(refreshJob).toContain("type: Microsoft.App/jobs");
    expect(refreshJob).toContain("triggerType: Schedule");
    expect(refreshJob).toContain('cronExpression: "10 19 * * 0"');
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
    expect(bot).toContain("secretRef: PLACEHOLDER_ATTACHMENT_SCAN_QUEUE_URL_SECRET_REF");
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

    for (const name of [
      "BOT_PROFILES_BASE64_JSON",
      "BOT_PROFILES_JSON",
      "PROFILE_CONFIG_VERSION",
      "PPT_ALLOWED_EXTENSIONS",
      "PPT_DEFAULT_INCLUDE_PDF",
      "GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID",
      "GRAPH_SHEET_MUSIC_FOLDER_PATH",
      "SHEET_MUSIC_DEFAULT_RECURSIVE",
      "LLM_PROVIDER",
      "LLM_FALLBACK_PROVIDER",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_EMBEDDING_MODEL",
      "EMBEDDING_KEEP_ALIVE",
      "CLAMAV_TIMEOUT_MS"
    ]) {
      expect(bot).not.toContain(`name: ${name}`);
    }

    const queueSecretDeploy = deployment.indexOf("az containerapp secret set");
    const searxngDeploy = deployment.indexOf('az containerapp update --yaml "${searxng_manifest}"');
    const botDeploy = deployment.indexOf('--yaml "${bot_manifest}"');
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
      'start_release_job \\\n  "${CLAMAV_SIGNATURE_REFRESH_JOB_NAME}"'
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

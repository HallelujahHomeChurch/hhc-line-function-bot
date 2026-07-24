import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAzureOpenAiEmbeddingClient } from "../clients/azure-openai-embedding.js";
import { createNotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { loadConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createKnowledgeStore } from "../knowledge/create-store.js";
import {
  syncScheduledKnowledgeSources,
  type ScheduledKnowledgeSyncResult
} from "../knowledge/scheduled-sync.js";

interface RebuildReport {
  sources: number;
  status: "complete" | "failed" | "skipped";
  chunks: number;
}

function report(value: RebuildReport): void {
  console.log(JSON.stringify(value));
}

function requestedSourceKeys(argv: readonly string[]): Set<string> {
  return new Set(argv.map((value) => value.trim()).filter(Boolean));
}

export function rebuildFailed(
  result: Pick<ScheduledKnowledgeSyncResult, "failed" | "embeddingPending">,
  missingRequested: boolean
): boolean {
  return missingRequested || result.failed > 0 || result.embeddingPending > 0;
}

async function main(): Promise<void> {
  let postgres: Awaited<ReturnType<typeof createPostgresRuntime>>;
  try {
    const config = loadConfigFromEnv(process.env);
    const requested = requestedSourceKeys(process.argv.slice(2));
    if (!config.knowledge) {
      report({ sources: 0, status: requested.size > 0 ? "failed" : "skipped", chunks: 0 });
      if (requested.size > 0) process.exitCode = 1;
      return;
    }

    postgres = await createPostgresRuntime(config.database);
    const store = await createKnowledgeStore({ db: postgres?.pool });
    const enabledSources = (
      await Promise.all(
        config.profiles.map((profile) =>
          store.listSources({ profileName: profile.name, includeDisabled: false })
        )
      )
    ).flat();
    const sources = enabledSources.filter(
      (source) => requested.size === 0 || requested.has(source.sourceKey)
    );
    const foundRequested = new Set(sources.map((source) => source.sourceKey));
    const missingRequested = [...requested].some((sourceKey) => !foundRequested.has(sourceKey));
    const embedding = createAzureOpenAiEmbeddingClient({
      apiKey: config.knowledge.embedding.apiKey,
      endpoint: config.knowledge.embedding.endpoint,
      deployment: config.knowledge.embedding.deployment,
      apiVersion: config.knowledge.embedding.apiVersion,
      model: config.knowledge.embedding.model,
      dimensions: config.knowledge.embedding.dimensions,
      timeoutMs: config.knowledge.embedding.timeoutMs
    });
    const result = await syncScheduledKnowledgeSources({
      sources,
      store,
      notion: createNotionKnowledgeClient(config.knowledge.notionToken),
      embedding,
      batchSize: config.knowledge.embedding.batchSize
    });
    const failed = rebuildFailed(result, missingRequested);
    report({
      sources: result.sources,
      status: failed ? "failed" : "complete",
      chunks: result.chunks
    });
    if (failed) process.exitCode = 1;
  } catch {
    report({ sources: 0, status: "failed", chunks: 0 });
    process.exitCode = 1;
  } finally {
    await postgres?.pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

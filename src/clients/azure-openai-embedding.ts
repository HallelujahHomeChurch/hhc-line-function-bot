import type { EmbeddingClient } from "./embedding.js";

export const AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "text-embedding-3-small";
export const AZURE_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const AZURE_OPENAI_EMBEDDING_API_VERSION = "2024-10-21";
export const AZURE_OPENAI_EMBEDDING_DIMENSIONS = 1536;

export interface AzureOpenAiEmbeddingOptions {
  apiKey?: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createAzureOpenAiEmbeddingClient(
  options: AzureOpenAiEmbeddingOptions
): EmbeddingClient {
  if (!options.apiKey?.trim()) throw new Error("embedding_missing_api_key");
  const endpoint = parseAzureEndpoint(options.endpoint);
  if (options.deployment !== AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    throw new Error("embedding_deployment_unsupported");
  }
  if (options.apiVersion !== AZURE_OPENAI_EMBEDDING_API_VERSION) {
    throw new Error("embedding_api_version_unsupported");
  }
  if (options.model !== AZURE_OPENAI_EMBEDDING_MODEL) {
    throw new Error("embedding_model_unsupported");
  }
  if (options.dimensions !== AZURE_OPENAI_EMBEDDING_DIMENSIONS) {
    throw new Error("embedding_dimension_unsupported");
  }
  const deployment = encodeURIComponent(options.deployment);
  const requestUrl = new URL(`/openai/deployments/${deployment}/embeddings`, endpoint);
  requestUrl.search = new URLSearchParams({ "api-version": options.apiVersion }).toString();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: "azure_openai",
    model: options.model,
    dimensions: options.dimensions,
    async embed(input): Promise<number[][]> {
      if (input.length === 0) return [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(requestUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "api-key": options.apiKey!
          },
          signal: controller.signal,
          body: JSON.stringify({
            input,
            encoding_format: "float"
          })
        });
        if (!response.ok) throw new Error(`embedding_http_${response.status}`);
        const payload = (await response.json()) as { data?: unknown };
        if (!Array.isArray(payload.data) || payload.data.length !== input.length) {
          throw new Error("embedding_response_invalid");
        }
        const vectors = Array.from(
          { length: input.length },
          () => undefined as number[] | undefined
        );
        for (const entry of payload.data) {
          if (!isEmbeddingEntry(entry) || entry.index >= input.length || vectors[entry.index]) {
            throw new Error("embedding_response_invalid");
          }
          if (
            entry.embedding.length !== options.dimensions ||
            entry.embedding.some((value) => !Number.isFinite(value))
          ) {
            throw new Error("embedding_dimension_mismatch");
          }
          vectors[entry.index] = entry.embedding;
        }
        if (vectors.some((vector) => !vector)) throw new Error("embedding_response_invalid");
        return vectors as number[][];
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("embedding_timeout");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

function parseAzureEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("embedding_endpoint_unsupported");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    endpoint.protocol !== "https:" ||
    (!hostname.endsWith(".cognitiveservices.azure.com") &&
      !hostname.endsWith(".openai.azure.com"))
  ) {
    throw new Error("embedding_endpoint_unsupported");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function isEmbeddingEntry(value: unknown): value is { index: number; embedding: number[] } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { index?: unknown; embedding?: unknown };
  return (
    typeof entry.index === "number" &&
    Number.isInteger(entry.index) &&
    entry.index >= 0 &&
    Array.isArray(entry.embedding) &&
    entry.embedding.every((item) => typeof item === "number")
  );
}

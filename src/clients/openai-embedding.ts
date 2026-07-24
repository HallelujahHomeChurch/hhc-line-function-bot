import type { EmbeddingClient } from "./embedding.js";

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;

export interface OpenAiEmbeddingOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createOpenAiEmbeddingClient(options: OpenAiEmbeddingOptions): EmbeddingClient {
  if (!options.apiKey?.trim()) throw new Error("embedding_missing_api_key");
  if (options.model !== OPENAI_EMBEDDING_MODEL) {
    throw new Error("embedding_model_unsupported");
  }
  if (options.dimensions !== OPENAI_EMBEDDING_DIMENSIONS) {
    throw new Error("embedding_dimension_unsupported");
  }
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: "openai",
    model: options.model,
    dimensions: options.dimensions,
    async embed(input): Promise<number[][]> {
      if (input.length === 0) return [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
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

import { describe, expect, it, vi } from "vitest";

import { createAzureOpenAiEmbeddingClient } from "../clients/azure-openai-embedding.js";

const vector = (value: number) => Array.from({ length: 1536 }, () => value);

describe("Azure OpenAI embedding client", () => {
  const options = (fetchImpl?: typeof fetch) => ({
    apiKey: "azure-test-key",
    endpoint: "https://bible-text-embedding-resource.cognitiveservices.azure.com/",
    deployment: "text-embedding-3-small",
    apiVersion: "2024-10-21",
    model: "text-embedding-3-small",
    dimensions: 1536 as const,
    timeoutMs: 1000,
    ...(fetchImpl ? { fetchImpl } : {})
  });

  it("rejects invalid provider configuration at construction", () => {
    expect(() => createAzureOpenAiEmbeddingClient({ ...options(), apiKey: undefined })).toThrow(
      "embedding_missing_api_key"
    );
    expect(() =>
      createAzureOpenAiEmbeddingClient({
        ...options(),
        endpoint: "https://api.openai.com/v1"
      })
    ).toThrow("embedding_endpoint_unsupported");
    expect(() =>
      createAzureOpenAiEmbeddingClient({
        ...options(),
        endpoint: "http://bible-text-embedding-resource.cognitiveservices.azure.com"
      })
    ).toThrow("embedding_endpoint_unsupported");
    expect(() =>
      createAzureOpenAiEmbeddingClient({ ...options(), deployment: "other-deployment" })
    ).toThrow("embedding_deployment_unsupported");
    expect(() =>
      createAzureOpenAiEmbeddingClient({ ...options(), apiVersion: "preview" })
    ).toThrow("embedding_api_version_unsupported");
    expect(() =>
      createAzureOpenAiEmbeddingClient({ ...options(), model: "text-embedding-3-large" })
    ).toThrow("embedding_model_unsupported");
    expect(() =>
      createAzureOpenAiEmbeddingClient({ ...options(), dimensions: 1535 as 1536 })
    ).toThrow("embedding_dimension_unsupported");
  });

  it("returns immediately for empty input without calling Azure", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createAzureOpenAiEmbeddingClient(options(fetchImpl));

    await expect(client.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the embeddings API and restores vectors by response index", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector(0.2) },
            { index: 0, embedding: vector(0.1) }
          ]
        }),
        { status: 200 }
      )
    );
    const client = createAzureOpenAiEmbeddingClient(options(fetchImpl));

    await expect(client.embed(["first", "second"])).resolves.toEqual([vector(0.1), vector(0.2)]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bible-text-embedding-resource.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "api-key": "azure-test-key"
        },
        body: JSON.stringify({
          input: ["first", "second"],
          encoding_format: "float"
        })
      })
    );
  });

  it("rejects a response with an unexpected vector dimension", async () => {
    const client = createAzureOpenAiEmbeddingClient({
      ...options(),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 })
        )
    });

    await expect(client.embed(["first"])).rejects.toThrow("embedding_dimension_mismatch");
  });

  it.each([1535, 1537])("rejects a %i-dimensional response vector", async (dimensions) => {
    const client = createAzureOpenAiEmbeddingClient(
      options(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ data: [{ index: 0, embedding: Array(dimensions).fill(0.1) }] }),
              { status: 200 }
            )
          )
      )
    );

    await expect(client.embed(["first"])).rejects.toThrow("embedding_dimension_mismatch");
  });

  it.each([401, 429, 500, 503])("maps Azure HTTP %i to a bounded error", async (status) => {
    const client = createAzureOpenAiEmbeddingClient(
      options(vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status })))
    );

    await expect(client.embed(["first"])).rejects.toThrow(`embedding_http_${status}`);
  });

  it("times out a stalled OpenAI request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const client = createAzureOpenAiEmbeddingClient({ ...options(fetchImpl), timeoutMs: 5 });

    await expect(client.embed(["first"])).rejects.toThrow("embedding_timeout");
  });

  it.each([
    {
      name: "count mismatch",
      data: [{ index: 0, embedding: vector(0.1) }]
    },
    {
      name: "duplicate index",
      data: [
        { index: 0, embedding: vector(0.1) },
        { index: 0, embedding: vector(0.2) }
      ]
    },
    {
      name: "out-of-range index",
      data: [
        { index: 0, embedding: vector(0.1) },
        { index: 2, embedding: vector(0.2) }
      ]
    }
  ])("rejects $name", async ({ data }) => {
    const client = createAzureOpenAiEmbeddingClient(
      options(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data }), {
            status: 200
          })
        )
      )
    );

    await expect(client.embed(["first", "second"])).rejects.toThrow("embedding_response_invalid");
  });

  it("rejects non-finite vector values", async () => {
    const embedding = vector(0.1);
    embedding[100] = Number.POSITIVE_INFINITY;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding }] })
    } as Response);
    const client = createAzureOpenAiEmbeddingClient(options(fetchImpl));

    await expect(client.embed(["first"])).rejects.toThrow("embedding_dimension_mismatch");
  });
});

import { describe, expect, it, vi } from "vitest";

import { createOpenAiEmbeddingClient } from "../clients/openai-embedding.js";

const vector = (value: number) => Array.from({ length: 1536 }, () => value);

describe("OpenAI embedding client", () => {
  const options = (fetchImpl?: typeof fetch) => ({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
    timeoutMs: 1000,
    ...(fetchImpl ? { fetchImpl } : {})
  });

  it("rejects a missing API key and unsupported model or dimension at construction", () => {
    expect(() => createOpenAiEmbeddingClient({ ...options(), apiKey: undefined })).toThrow(
      "embedding_missing_api_key"
    );
    expect(() =>
      createOpenAiEmbeddingClient({ ...options(), model: "text-embedding-3-large" })
    ).toThrow("embedding_model_unsupported");
    expect(() => createOpenAiEmbeddingClient({ ...options(), dimensions: 1535 })).toThrow(
      "embedding_dimension_unsupported"
    );
  });

  it("returns immediately for empty input without calling OpenAI", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createOpenAiEmbeddingClient(options(fetchImpl));

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
    const client = createOpenAiEmbeddingClient({
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1/",
      model: "text-embedding-3-small",
      dimensions: 1536,
      timeoutMs: 1000,
      fetchImpl
    });

    await expect(client.embed(["first", "second"])).resolves.toEqual([vector(0.1), vector(0.2)]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: ["first", "second"],
          encoding_format: "float"
        })
      })
    );
  });

  it("rejects a response with an unexpected vector dimension", async () => {
    const client = createOpenAiEmbeddingClient({
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 1536,
      timeoutMs: 1000,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 })
        )
    });

    await expect(client.embed(["first"])).rejects.toThrow("embedding_dimension_mismatch");
  });

  it.each([1535, 1537])("rejects a %i-dimensional response vector", async (dimensions) => {
    const client = createOpenAiEmbeddingClient(
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

  it.each([401, 429, 500, 503])("maps OpenAI HTTP %i to a bounded error", async (status) => {
    const client = createOpenAiEmbeddingClient(
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
    const client = createOpenAiEmbeddingClient({ ...options(fetchImpl), timeoutMs: 5 });

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
    const client = createOpenAiEmbeddingClient(
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
    const client = createOpenAiEmbeddingClient(options(fetchImpl));

    await expect(client.embed(["first"])).rejects.toThrow("embedding_dimension_mismatch");
  });
});

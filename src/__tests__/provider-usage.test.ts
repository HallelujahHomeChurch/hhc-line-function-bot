import { describe, expect, it } from "vitest";

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

async function extractor(): Promise<(message: unknown) => Usage> {
  const modulePath = "../evals/provider-usage.js";
  const loaded = (await import(modulePath).catch(() => ({}))) as {
    extractProviderUsage?: (message: unknown) => Usage;
  };
  expect(loaded.extractProviderUsage).toBeTypeOf("function");
  return loaded.extractProviderUsage!;
}

describe("provider usage extraction", () => {
  it("prefers DeepSeek response metadata without double counting normalized usage", async () => {
    const extract = await extractor();

    expect(
      extract({
        response_metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 40,
            prompt_cache_miss_tokens: 60
          }
        },
        usage_metadata: {
          input_tokens: 999,
          output_tokens: 999,
          input_token_details: { cache_read: 999 }
        }
      })
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 40, cacheMissTokens: 60 });
  });

  it("falls back to normalized usage and preserves the input-token cache invariant", async () => {
    const extract = await extractor();

    expect(
      extract({
        usage_metadata: {
          input_tokens: 80,
          output_tokens: 12,
          input_token_details: { cache_read: 30 }
        }
      })
    ).toEqual({ inputTokens: 80, outputTokens: 12, cacheHitTokens: 30, cacheMissTokens: 50 });
  });
});

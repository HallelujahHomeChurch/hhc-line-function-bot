export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export function extractProviderUsage(message: unknown): ProviderUsage {
  const candidate = message as {
    response_metadata?: {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { cache_read?: number; cache_miss?: number };
    };
  };
  const provider = candidate.response_metadata?.usage;
  const normalized = candidate.usage_metadata;
  const inputTokens = safeCount(provider?.prompt_tokens ?? normalized?.input_tokens);
  const outputTokens = safeCount(provider?.completion_tokens ?? normalized?.output_tokens);
  const cacheHitTokens = Math.min(
    inputTokens,
    safeCount(provider?.prompt_cache_hit_tokens ?? normalized?.input_token_details?.cache_read)
  );
  const cacheMissTokens = Math.min(
    inputTokens - cacheHitTokens,
    safeCount(
      provider?.prompt_cache_miss_tokens ?? normalized?.input_token_details?.cache_miss,
      inputTokens - cacheHitTokens
    )
  );
  return { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens };
}

function safeCount(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}

import { providerCapabilities } from "../llm/provider-metadata.js";
import { ProviderResponseError } from "../router.js";
import type {
  ChatProvider,
  ChatProviderRequest,
  TextGenerationProvider,
  TextGenerationRequest
} from "../types.js";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  routeMaxOutputTokens: number;
  generalMaxOutputTokens: number;
  fetchImpl?: typeof fetch;
}

export function createDeepSeekProvider(
  options: DeepSeekProviderOptions
): ChatProvider & TextGenerationProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    providerName: "deepseek",
    capabilities: providerCapabilities.deepseek,

    async completeJson(request: ChatProviderRequest): Promise<string> {
      return completeChat(fetchImpl, baseUrl, options, {
        model: options.model,
        stream: false,
        temperature: 0,
        max_tokens: options.routeMaxOutputTokens,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.prompt },
          { role: "user", content: request.text }
        ]
      });
    },

    async completeText(request: TextGenerationRequest): Promise<string> {
      return completeChat(fetchImpl, baseUrl, options, {
        model: options.model,
        stream: false,
        temperature: 0.4,
        max_tokens: request.maxChars ?? options.generalMaxOutputTokens,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: request.prompt },
          { role: "user", content: request.text }
        ]
      });
    }
  };
}

async function completeChat(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: DeepSeekProviderOptions,
  body: Record<string, unknown>
): Promise<string> {
  if (!options.apiKey) {
    throw new ProviderResponseError("deepseek_missing_api_key");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new ProviderResponseError(`deepseek_http_${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new ProviderResponseError("deepseek_empty_response");
    }
    return content;
  } catch (error) {
    if (error instanceof ProviderResponseError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderResponseError("timeout");
    }
    throw new ProviderResponseError("deepseek_unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

import { ProviderResponseError } from "../router.js";
import type {
  ChatProvider,
  ChatProviderRequest,
  TextGenerationProvider,
  TextGenerationRequest
} from "../types.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  keepAlive?: string | number;
}

export function createOllamaProvider(
  options: OllamaProviderOptions
): ChatProvider & TextGenerationProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    async completeJson(request: ChatProviderRequest): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        return await completeChat(baseUrl, options, controller.signal, {
          model: options.model,
          stream: false,
          think: false,
          options: {
            temperature: 0,
            num_predict: 256
          },
          messages: [
            { role: "system", content: request.prompt },
            { role: "user", content: request.text }
          ],
          format: "json"
        });
      } catch (error) {
        if (error instanceof ProviderResponseError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new ProviderResponseError("timeout");
        }
        throw new ProviderResponseError("ollama_unreachable");
      } finally {
        clearTimeout(timeout);
      }
    },

    async completeText(request: TextGenerationRequest): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        return await completeChat(baseUrl, options, controller.signal, {
          model: options.model,
          stream: false,
          think: false,
          options: {
            temperature: 0.4,
            num_predict: request.maxChars
          },
          messages: [
            { role: "system", content: request.prompt },
            { role: "user", content: request.text }
          ]
        });
      } catch (error) {
        if (error instanceof ProviderResponseError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new ProviderResponseError("timeout");
        }
        throw new ProviderResponseError("ollama_unreachable");
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

async function completeChat(
  baseUrl: string,
  options: OllamaProviderOptions,
  signal: AbortSignal,
  body: Record<string, unknown>
): Promise<string> {
  if (options.keepAlive !== undefined) {
    body.keep_alive = options.keepAlive;
  }

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new ProviderResponseError(`ollama_http_${res.status}`);
  }

  const payload = (await res.json()) as {
    message?: { content?: string };
    response?: string;
  };
  const content = payload.message?.content ?? payload.response;
  if (!content) {
    throw new ProviderResponseError("ollama_empty_response");
  }
  return content;
}

import { AzureOpenAI } from "openai";

import { ProviderResponseError } from "../router.js";
import type { AzureOpenAIConfig, ChatProvider, ChatProviderRequest } from "../types.js";

export function createAzureOpenAIProvider(config: AzureOpenAIConfig): ChatProvider {
  const client = new AzureOpenAI({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiVersion: config.apiVersion,
    deployment: config.deployment
  });

  return {
    async completeJson(request: ChatProviderRequest): Promise<string> {
      try {
        const completion = await client.chat.completions.create({
          model: config.deployment,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.prompt },
            { role: "user", content: request.text }
          ]
        });

        const content = completion.choices[0]?.message?.content;
        if (!content) {
          throw new ProviderResponseError("azure_openai_empty_response");
        }
        return content;
      } catch (error) {
        if (error instanceof ProviderResponseError) {
          throw error;
        }
        throw new ProviderResponseError("azure_openai_failed");
      }
    }
  };
}

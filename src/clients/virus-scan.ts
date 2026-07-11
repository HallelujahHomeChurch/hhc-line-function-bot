import { Buffer } from "node:buffer";

import type { VirusScanConfig, VirusScanInput, VirusScanResult, VirusScanner } from "../types.js";

interface VirusScanHttpResponse {
  status?: unknown;
  detail?: unknown;
}

export function createHttpVirusScanner(config: VirusScanConfig): VirusScanner {
  return {
    async scan(input: VirusScanInput): Promise<VirusScanResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(config.endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
          },
          body: JSON.stringify({
            fileName: input.fileName,
            contentType: input.contentType,
            sha256: input.sha256,
            dataBase64: Buffer.from(input.data).toString("base64")
          })
        });
        if (!response.ok) {
          return { status: "unavailable", detail: `http_${response.status}` };
        }
        const parsed = (await response.json()) as VirusScanHttpResponse;
        if (parsed.status === "clean" || parsed.status === "infected") {
          return {
            status: parsed.status,
            detail: typeof parsed.detail === "string" ? parsed.detail : undefined
          };
        }
        return { status: "unavailable", detail: "invalid_response" };
      } catch (error) {
        return {
          status: "unavailable",
          detail: error instanceof Error ? error.message : "unknown_error"
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

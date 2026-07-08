import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  extractAssistantTextFromNotification,
  type RpcNotification,
  type CodexAppServerTransport
} from "../codex-app-server/client.js";
import { createCodexAppServerProvider } from "../codex-app-server/provider.js";
import type { LlmConfig } from "../types.js";

function fakeTransport(): CodexAppServerTransport & { stdout: PassThrough; stdin: PassThrough } {
  const transport = new EventEmitter() as CodexAppServerTransport & {
    stdout: PassThrough;
    stdin: PassThrough;
  };
  transport.stdin = new PassThrough();
  transport.stdout = new PassThrough();
  transport.stderr = new PassThrough();
  transport.close = () => undefined;
  return transport;
}

function readWrittenJson(transport: { stdin: PassThrough }) {
  const chunk = transport.stdin.read();
  if (!chunk) {
    throw new Error("no rpc message written");
  }
  return JSON.parse(chunk.toString("utf8")) as { id: number; method: string };
}

describe("Codex app-server client", () => {
  it("routes JSON-RPC responses by id", async () => {
    const transport = fakeTransport();
    const client = CodexAppServerClient.fromTransportForTests(transport);
    const pending = client.request("initialize", { clientInfo: { name: "test" } });
    const written = readWrittenJson(transport);

    expect(written).toMatchObject({ id: 1, method: "initialize" });

    transport.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: written.id, result: { serverVersion: "0.1.0" } }) + "\n"
    );

    await expect(pending).resolves.toEqual({ serverVersion: "0.1.0" });
  });

  it("extracts assistant text from app-server notifications", () => {
    expect(
      extractAssistantTextFromNotification({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "final",
            text: "hello from codex"
          }
        }
      })
    ).toBe("hello from codex");

    expect(
      extractAssistantTextFromNotification({
        jsonrpc: "2.0",
        method: "rawResponseItem/completed",
        params: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "raw response" }]
          }
        }
      })
    ).toBe("raw response");
  });

  it("starts one app-server thread per provider request", async () => {
    const methods: string[] = [];
    const handlers = new Set<(notification: RpcNotification) => void>();
    const fakeClient = {
      initialize: async () => {
        methods.push("initialize");
        return {};
      },
      request: async (method: string) => {
        methods.push(method);
        if (method === "thread/start") {
          setTimeout(() => {
            for (const handler of handlers) {
              handler({
                method: "item/completed",
                params: { item: { type: "agentMessage", phase: "final", text: "ok" } }
              });
              handler({ method: "turn/completed", params: {} });
            }
          }, 0);
        }
        return { thread: { id: "thread_1" } };
      },
      onNotification: (handler: (notification: RpcNotification) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      close: () => undefined
    } as unknown as CodexAppServerClient;

    const provider = createCodexAppServerProvider({
      config: {
        provider: "codex_app_server",
        fallbackProvider: "ollama",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen3:4b-instruct",
        timeoutMs: 1000,
        keywordFallbackEnabled: true
      } satisfies LlmConfig,
      clientFactory: () => fakeClient
    });

    await expect(provider.completeText({ prompt: "reply briefly", text: "hello" })).resolves.toBe(
      "ok"
    );
    expect(methods).toEqual(["initialize", "thread/start"]);
  });
});

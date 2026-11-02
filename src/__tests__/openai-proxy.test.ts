import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getGlobalDispatcher } from "undici";
import { createOpenAiProxyTransport } from "../clients/openai-proxy.js";
import { readOpenAiProxyUrl } from "../config.js";

describe("dedicated OpenAI proxy", () => {
  it("defaults off and rejects credentials and non-origin configuration without leaking it", () => {
    expect(readOpenAiProxyUrl(undefined)).toBeUndefined();
    expect(readOpenAiProxyUrl("  ")).toBeUndefined();
    expect(readOpenAiProxyUrl("http://relay.invalid:18443/")).toBe("http://relay.invalid:18443");
    for (const value of [
      "socks5://relay",
      "http://secret:credential@relay",
      "http://relay/path",
      "http://relay/?secret",
      "http://relay/#secret",
      "secret"
    ]) {
      expect(() => readOpenAiProxyUrl(value)).toThrow("OPENAI_PROXY_URL must be");
    }
  });

  it("uses only its own CONNECT transport and fails closed without direct fallback", async () => {
    const globalDispatcher = getGlobalDispatcher();
    const server = createServer((_req, res) => res.end("direct"));
    const destinations: string[] = [];
    let credentialsExposed = false;
    server.on("connect", (req, socket) => {
      destinations.push(req.url!);
      credentialsExposed ||= Boolean(req.headers.authorization);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const proxy = createOpenAiProxyTransport(origin);
    try {
      for (const url of [
        "https://api.deepseek.com/v1",
        origin,
        "https://api.openai.com.evil.invalid/",
        "https://api.openai.com:444/",
        "https://secret@api.openai.com/"
      ]) {
        await expect(proxy.fetch(url)).rejects.toThrow("openai_proxy_destination_denied");
      }
      expect(destinations).toEqual([]);
      await expect(
        proxy.fetch("https://api.openai.com/v1/chat/completions", {
          headers: { authorization: "Bearer synthetic" },
          signal: AbortSignal.timeout(2_000)
        })
      ).rejects.toThrow();
      expect(destinations).toEqual(["api.openai.com:443"]);
      expect(credentialsExposed).toBe(false);
      expect(getGlobalDispatcher()).toBe(globalDispatcher);
      expect(await (await fetch(origin)).text()).toBe("direct");
    } finally {
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

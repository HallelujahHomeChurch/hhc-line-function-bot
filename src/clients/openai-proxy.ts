import { fetch as undiciFetch, ProxyAgent } from "undici";

/** A client-owned CONNECT tunnel; never changes process-wide proxy or TLS settings. */
export function createOpenAiProxyTransport(proxyUrl: string) {
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    connections: 4,
    connectTimeout: 5_000,
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  });
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.openai.com" || url.username || url.password) {
      throw new Error("openai_proxy_destination_denied");
    }
    // Do not follow redirects carrying a provider credential to another origin.
    return (undiciFetch as unknown as typeof fetch)(input, {
      ...init,
      redirect: "error",
      dispatcher
    } as unknown as RequestInit);
  };
  return { fetch: proxyFetch, close: () => dispatcher.destroy() };
}

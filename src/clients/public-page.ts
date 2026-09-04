import { promises as dns } from "node:dns";
import https from "node:https";

import { validateExternalBinaryUrl } from "./external-binary.js";

export interface PublicPageReadResult {
  kind: "direct_file" | "html" | "text";
  untrusted: true;
  text?: string;
  links: Array<{ title: string; url: string }>;
}

export interface PublicPageReader {
  read(url: string): Promise<PublicPageReadResult>;
}

interface SafeTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

interface PageResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

interface PublicPageReaderOptions {
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: (target: SafeTarget) => Promise<PageResponse>;
}

export function createPublicPageReader(options: PublicPageReaderOptions): PublicPageReader {
  const resolve = options.resolve ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  const request = options.request ?? ((target) => requestPage(target, options));
  return {
    read: (url) => readPage(url, 0, options, resolve, request)
  };
}

async function readPage(
  rawUrl: string,
  redirects: number,
  options: PublicPageReaderOptions,
  resolve: NonNullable<PublicPageReaderOptions["resolve"]>,
  request: NonNullable<PublicPageReaderOptions["request"]>
): Promise<PublicPageReadResult> {
  const target = await validateExternalBinaryUrl(rawUrl, resolve);
  const response = await request(target);
  const declaredLength = Number(header(response.headers, "content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new Error("public_page_too_large");
  }
  if (response.body.byteLength > options.maxBytes) throw new Error("public_page_too_large");

  if (response.statusCode >= 300 && response.statusCode < 400) {
    if (redirects >= options.maxRedirects) throw new Error("public_page_too_many_redirects");
    const location = header(response.headers, "location");
    if (!location) throw new Error("public_page_invalid_redirect");
    return readPage(
      new URL(location, target.url).toString(),
      redirects + 1,
      options,
      resolve,
      request
    );
  }
  if (response.statusCode !== 200) throw new Error(`public_page_http_${response.statusCode}`);

  const contentType = (header(response.headers, "content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (["application/pdf", "image/jpeg", "image/png"].includes(contentType)) {
    return { kind: "direct_file", untrusted: true, links: [] };
  }
  const raw = new TextDecoder().decode(response.body);
  if (contentType && contentType !== "text/html" && contentType !== "text/plain") {
    throw new Error("public_page_unsupported_content_type");
  }
  if (contentType === "text/plain") {
    return { kind: "text", untrusted: true, text: cleanText(raw), links: [] };
  }
  return {
    kind: "html",
    untrusted: true,
    text: cleanText(
      raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    ),
    links: directFileLinks(raw, target.url)
  };
}

function requestPage(
  target: SafeTarget,
  options: Pick<PublicPageReaderOptions, "maxBytes" | "timeoutMs">
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      target.url,
      {
        headers: { accept: "text/html,text/plain,application/pdf,image/jpeg,image/png" },
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        method: "GET",
        servername: target.hostname
      },
      async (response) => {
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.byteLength;
            if (size > options.maxBytes) {
              response.destroy();
              throw new Error("public_page_too_large");
            }
            chunks.push(buffer);
          }
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: new Uint8Array(Buffer.concat(chunks, size))
          });
        } catch (error) {
          reject(error);
        }
      }
    );
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error("public_page_timeout"));
    });
    request.once("error", reject);
    request.end();
  });
}

function directFileLinks(html: string, base: URL): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    try {
      const url = new URL(match[1]!, base);
      if (url.protocol !== "https:" || !/\.(?:pdf|jpe?g|png)(?:$|[?#])/iu.test(url.href)) continue;
      links.push({ title: cleanText(match[2]!) || "檔案", url: url.toString() });
      if (links.length === 10) break;
    } catch {
      continue;
    }
  }
  return links;
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 8_000);
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

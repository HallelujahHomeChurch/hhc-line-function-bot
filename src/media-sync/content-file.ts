import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LineContentReadError } from "../clients/line.js";

export type MediaContentFile = {
  directory: string;
  path: string;
  sizeBytes: number;
  checksumSha256: string;
  contentType?: string;
};

export async function withMediaContentFile<T>(
  stream: Readable,
  options: {
    maxBytes: number;
    timeoutMs: number;
    contentType?: string;
    tmpRoot?: string;
    signal?: AbortSignal;
  },
  use: (file: MediaContentFile) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "hhc-media-sync-"));
  const path = join(directory, "content");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > options.maxBytes) {
        callback(new LineContentReadError("line_content_too_large"));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    try {
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      await pipeline(stream, counter, createWriteStream(path, { flags: "wx" }), { signal });
    } catch (error) {
      if (controller.signal.aborted) throw new LineContentReadError("line_content_timeout");
      if (options.signal?.aborted) throw new LineContentReadError("line_content_cancelled");
      throw error;
    }
    if (sizeBytes === 0) throw new LineContentReadError("line_content_empty");
    return await use({
      directory,
      path,
      sizeBytes,
      checksumSha256: hash.digest("hex"),
      ...(options.contentType ? { contentType: options.contentType } : {})
    });
  } finally {
    clearTimeout(timer);
    stream.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

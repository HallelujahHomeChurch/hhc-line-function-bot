import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { contentTypeFromLineStream, readableToUint8Array } from "../clients/line.js";

describe("LINE content streaming", () => {
  it("retains a safe response content type for worker-side extension validation", () => {
    const stream = Readable.from([]);
    Object.assign(stream, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      }
    });

    expect(contentTypeFromLineStream(stream)).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
  });

  it("accepts content at the exact byte limit", async () => {
    await expect(
      readableToUint8Array(Readable.from([Buffer.from([1, 2, 3, 4])]), {
        maxBytes: 4,
        timeoutMs: 100
      })
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("rejects content as soon as it exceeds the byte limit", async () => {
    await expect(
      readableToUint8Array(Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]), {
        maxBytes: 4,
        timeoutMs: 100
      })
    ).rejects.toMatchObject({ code: "line_content_too_large" });
  });

  it("rejects an empty stream", async () => {
    await expect(
      readableToUint8Array(Readable.from([]), { maxBytes: 4, timeoutMs: 100 })
    ).rejects.toMatchObject({ code: "line_content_empty" });
  });

  it("destroys a stream that exceeds the deadline", async () => {
    const stream = new Readable({ read() {} });

    await expect(readableToUint8Array(stream, { maxBytes: 4, timeoutMs: 5 })).rejects.toMatchObject(
      { code: "line_content_timeout" }
    );
    expect(stream.destroyed).toBe(true);
  });
});

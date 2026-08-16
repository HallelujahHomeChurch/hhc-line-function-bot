import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { withMediaContentFile } from "../media-sync/content-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("media sync bounded content file", () => {
  it("streams the exact byte limit while hashing and always removes its directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhc-media-sync-test-"));
    roots.push(root);
    let observedPath = "";

    const result = await withMediaContentFile(
      Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
      { maxBytes: 4, timeoutMs: 1_000, tmpRoot: root, contentType: "video/mp4" },
      async (file) => {
        observedPath = file.path;
        await expect(writeFile(join(file.directory, "proof"), "ok")).resolves.toBeUndefined();
        return file;
      }
    );

    expect(result).toMatchObject({
      path: observedPath,
      sizeBytes: 4,
      checksumSha256: "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589",
      contentType: "video/mp4"
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects above the limit before the callback and removes partial content", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhc-media-sync-test-"));
    roots.push(root);
    let called = false;

    await expect(
      withMediaContentFile(
        Readable.from([Buffer.alloc(4), Buffer.alloc(1)]),
        { maxBytes: 4, timeoutMs: 1_000, tmpRoot: root },
        async () => {
          called = true;
        }
      )
    ).rejects.toMatchObject({ code: "line_content_too_large" });
    expect(called).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("destroys and cleans up a stream when the deadline expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhc-media-sync-test-"));
    roots.push(root);
    const stream = new Readable({ read() {} });

    await expect(
      withMediaContentFile(stream, { maxBytes: 4, timeoutMs: 5, tmpRoot: root }, async () => {})
    ).rejects.toMatchObject({ code: "line_content_timeout" });
    expect(stream.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("destroys and cleans up a stream when the caller cancels", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhc-media-sync-test-"));
    roots.push(root);
    const stream = new Readable({ read() {} });
    const controller = new AbortController();
    setImmediate(() => controller.abort());

    await expect(
      withMediaContentFile(
        stream,
        { maxBytes: 4, timeoutMs: 1_000, tmpRoot: root, signal: controller.signal },
        async () => {}
      )
    ).rejects.toMatchObject({ code: "line_content_cancelled" });
    expect(stream.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
});

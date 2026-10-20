import { Client, LogLevel } from "@notionhq/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogNotionFetch } from "../tools/catalog-notion-fetch.js";

afterEach(() => vi.useRealTimers());
describe("catalog Notion wire ownership", () => {
  it("joins late headers and actual orphan body cancellation after the SDK timeout", async () => {
    vi.useFakeTimers();
    const headers = Promise.withResolvers<Response>();
    const cancelled = Promise.withResolvers<void>();
    const wire = vi.fn<typeof fetch>().mockReturnValue(headers.promise);
    const owner = createCatalogNotionFetch(new AbortController().signal, wire, 60_000);
    const sdk = new Client({
      auth: "fixture",
      fetch: owner.fetch,
      retry: false,
      timeoutMs: 1,
      logLevel: LogLevel.ERROR
    });
    const request = sdk.pages.retrieve({ page_id: "fixture" }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect((await request).code).toBe("notionhq_client_request_timeout");
    let settled = false;
    const closing = owner.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const beforeHeaders = settled;
    const cancel = vi.fn(() => cancelled.promise);
    headers.resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    const beforeCancel = settled;
    cancelled.resolve();
    await closing;
    expect(beforeHeaders).toBe(false);
    expect(beforeCancel).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(wire.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("keeps the real per-request timeout through response body consumption and joins cancel", async () => {
    vi.useFakeTimers();
    const cancelled = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cancelled.promise);
    let body!: ReadableStreamDefaultController;
    const wire = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            body = controller;
          },
          cancel
        })
      )
    );
    const owner = createCatalogNotionFetch(new AbortController().signal, wire, 20);
    const sdk = new Client({
      auth: "fixture",
      fetch: owner.fetch,
      retry: false,
      timeoutMs: 100,
      logLevel: LogLevel.ERROR
    });
    let failed = false;
    const request = sdk.pages.retrieve({ page_id: "fixture" }).catch(() => {
      failed = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    const bodyAborted = wire.mock.calls[0]?.[1]?.signal?.aborted;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const closedEarly = closed;
    cancelled.resolve();
    await closing;
    // Baseline SDK body waits forever without an owner; cancel its fixture to reap it.
    if (!failed) {
      try {
        body.close();
      } catch {
        /* Already canceled by owner. */
      }
    }
    await request;
    expect(bodyAborted).toBe(true);
    expect(closedEarly).toBe(false);
    expect(failed).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("reports an actual body cancellation failure instead of claiming clean drain", async () => {
    const controller = new AbortController();
    const error = new Error("wire_cancel_failed");
    const owner = createCatalogNotionFetch(
      controller.signal,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel: async () => {
              throw error;
            }
          })
        )
      )
    );
    await owner.fetch("https://example.invalid");
    controller.abort(new Error("stopped"));
    await expect(owner.close()).rejects.toBe(error);
  });
});

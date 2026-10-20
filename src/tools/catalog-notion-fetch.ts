// The Notion SDK timeout only rejects its wrapper. Own the real headers and streaming body.
export function createCatalogNotionFetch(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 60_000
) {
  const stopped = new AbortController();
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let closing: Promise<void> | undefined;
  const ownedFetch: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    stopped.signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("notion_request_timeout", "TimeoutError")),
      timeoutMs
    );
    const requestSignal = AbortSignal.any([
      signal,
      stopped.signal,
      timeout.signal,
      ...(init?.signal ? [init.signal] : [])
    ]);
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    pending.add(finished);
    let completed = false;
    let headersPending = true;
    let bodyDone = false;
    let reads = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelling: Promise<void> | undefined;
    const finish = () => {
      if (completed || headersPending || !bodyDone || reads) return;
      completed = true;
      try {
        reader?.releaseLock();
      } catch (error) {
        errors.push(error);
      }
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", abort);
      pending.delete(finished);
      resolveFinished();
    };
    const cancelBody = (reason: unknown): Promise<void> => {
      if (!reader) return Promise.resolve();
      if (cancelling) return cancelling;
      bodyDone = true;
      reads++;
      cancelling = Promise.resolve()
        .then(() => reader!.cancel(reason))
        .catch((error: unknown) => {
          errors.push(error);
        })
        .finally(() => {
          reads--;
          finish();
        });
      return cancelling;
    };
    const abort = () => {
      try {
        stream?.error(requestSignal.reason);
      } catch {
        /* The consumer may already have closed it. */
      }
      void cancelBody(requestSignal.reason);
    };
    requestSignal.addEventListener("abort", abort, { once: true });
    return (async () => {
      try {
        const response = await fetchImpl(input, { ...init, signal: requestSignal });
        headersPending = false;
        if (!response.body) {
          bodyDone = true;
          finish();
          requestSignal.throwIfAborted();
          return response;
        }
        reader = response.body.getReader();
        if (requestSignal.aborted) {
          await cancelBody(requestSignal.reason);
          requestSignal.throwIfAborted();
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
          async pull(controller) {
            if (requestSignal.aborted) {
              abort();
              return;
            }
            reads++;
            try {
              const chunk = await reader!.read();
              if (requestSignal.aborted) {
                abort();
                return;
              }
              if (chunk.done) {
                bodyDone = true;
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              bodyDone = true;
              try {
                controller.error(error);
              } catch {
                /* Already aborted. */
              }
            } finally {
              reads--;
              finish();
            }
          },
          cancel(reason) {
            return cancelBody(reason);
          }
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (error) {
        headersPending = false;
        if (!reader) bodyDone = true;
        else await cancelBody(error);
        finish();
        throw error;
      }
    })();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped.abort(new DOMException("catalog_notion_scope_closed", "AbortError"));
    closing = (async () => {
      while (pending.size) await Promise.all([...pending]);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "catalog_notion_close_failed", { cause: errors[0] });
    })();
    return closing;
  };
  return { fetch: ownedFetch, close };
}

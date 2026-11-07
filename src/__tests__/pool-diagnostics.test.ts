import { afterEach, describe, expect, it, vi } from "vitest";
import { startPoolDiagnostics } from "../db/pool-diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("global pool pressure diagnostics", () => {
  it("records only waiting pressure and stops with a final bounded flush", () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = { waitingCount: 0, totalCount: 2, idleCount: 1 };
    const stop = startPoolDiagnostics(pool);
    vi.advanceTimersByTime(15_000);
    expect(error).not.toHaveBeenCalled();
    pool.waitingCount = 1;
    pool.idleCount = 0;
    vi.advanceTimersByTime(15_000);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(error.mock.calls[0][0])).toEqual({
      event: "database_pool_pressure",
      scope: "global",
      phase: "db_pool",
      pool: "runtime",
      waiting: 1,
      total: 2,
      idle: 0
    });
    stop();
    stop();
    expect(error).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(error).toHaveBeenCalledTimes(2);
  });
  it("does not emit a healthy final snapshot", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startPoolDiagnostics({ waitingCount: 0, totalCount: 0, idleCount: 0 })();
    expect(error).not.toHaveBeenCalled();
  });
});

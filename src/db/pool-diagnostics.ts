import type { Pool } from "pg";

/** Global pool pressure only: these counters cannot attribute a particular request's wait. */
export function startPoolDiagnostics(
  pool: Pick<Pool, "waitingCount" | "totalCount" | "idleCount">,
  name: "runtime" | "history" | "helper_lock" = "runtime"
): () => void {
  const flush = () => {
    if (!(pool.waitingCount > 0)) return;
    console.error(
      JSON.stringify({
        event: "database_pool_pressure",
        scope: "global",
        phase: "db_pool",
        pool: name,
        waiting: pool.waitingCount,
        total: pool.totalCount,
        idle: pool.idleCount
      })
    );
  };
  const timer = setInterval(flush, 15_000);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    flush();
  };
}

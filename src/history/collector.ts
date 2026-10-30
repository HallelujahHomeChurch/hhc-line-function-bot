import type { GroupHistory, HistoryScope } from "./types.js";

// A bounded queue keeps passive storage failures out of webhook reply handling.
export function createHistoryCollector(history: GroupHistory, onGap: () => void) {
  const queue: Array<{ scope: HistoryScope; event: Parameters<GroupHistory["ingest"]>[1] }> = [];
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const entry = queue.shift()!;
        try {
          await history.ingest(entry.scope, entry.event);
        } catch {
          onGap();
        }
      }
    } finally {
      running = false;
    }
  };
  return (scope: HistoryScope, event: Parameters<GroupHistory["ingest"]>[1]) => {
    if (queue.length >= 64) {
      onGap();
      return;
    }
    queue.push({ scope, event });
    void drain();
  };
}

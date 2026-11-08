// Small helpers for running network work in parallel without flooding a phone's connection.
// Browsers allow ~6 connections per server; leave room for what the user taps (opening a chat, sending media).
export const HISTORY_CONCURRENCY = 4;

// Runs `task` for every item with at most `limit` in flight; resolves when all settle (failures are skipped).
export async function forEachLimited(items, limit, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await task(item); } catch { /* one chat failing must not stop the others */ }
    }
  });
  await Promise.all(workers);
}

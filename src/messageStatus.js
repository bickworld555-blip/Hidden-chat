const STATUS_RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };

// "waiting" (held for end-to-end encryption, src/e2e/messaging.js) replaces an optimistic "sent" or "failed"; once a
// held message really goes out, whatever comes next replaces "waiting".
export function mergeMessageStatus(current, incoming) {
  if (incoming === 'waiting') return !current || current === 'sent' || current === 'failed' ? 'waiting' : current;
  if (current === 'waiting') return incoming;
  return (STATUS_RANK[current] ?? 0) > (STATUS_RANK[incoming] ?? 0) ? current : incoming;
}
const STATUS_RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };

export function mergeMessageStatus(current, incoming) {
  return (STATUS_RANK[current] ?? 0) > (STATUS_RANK[incoming] ?? 0) ? current : incoming;
}
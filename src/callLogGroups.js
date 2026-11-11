// The Calls tab merges back-to-back calls with the same person, in the same direction and with the same outcome
// (answered or not), on the same day, into one row with a count: "Panna (3)". Newest first, like the log itself.

const dayOf = (timestamp) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** Whether a log entry is an answered call (it connected and lasted). */
export const answered = (log) => log.status === 'completed' && Number(log.duration) > 0;

/** Groups call logs (newest first) into rows: { key, peerId, direction, answered, mode, timestamp, duration, count, logs }. */
export function groupCallLogs(logs = []) {
  const sorted = [...logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const rows = [];
  for (const log of sorted) {
    const last = rows.at(-1);
    const isAnswered = answered(log);
    if (last && last.peerId === log.peerId && last.direction === log.direction && last.answered === isAnswered && dayOf(last.logs.at(-1).timestamp) === dayOf(log.timestamp)) {
      last.logs.push(log);
      last.count += 1;
      continue;
    }
    rows.push({ key: log.id, peerId: log.peerId, direction: log.direction, answered: isAnswered, mode: log.mode, timestamp: log.timestamp, duration: log.duration, count: 1, logs: [log] });
  }
  return rows;
}

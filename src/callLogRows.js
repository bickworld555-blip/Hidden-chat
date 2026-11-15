// The Calls tab lists every call as its own row, newest first, like WhatsApp's call log: five missed calls from
// the same person are five rows, each with its own time, voice or video, and outcome.

/** Whether a log entry is an answered call (it connected and lasted). */
export const answered = (log) => log.status === 'completed' && Number(log.duration) > 0;

/**
 * Rows for call logs: { key, peerId, direction, answered, missed, declined, silenced, mode, timestamp, duration }.
 * `missed`: an incoming call nobody answered here (declined and silenced calls are not missed).
 */
export function callLogRows(logs = []) {
  return [...logs]
    .filter((log) => log && log.peerId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((log) => {
      const isAnswered = answered(log);
      const declined = log.status === 'declined';
      const silenced = log.status === 'silenced';
      return {
        key: log.id, peerId: log.peerId, direction: log.direction, mode: log.mode === 'video' ? 'video' : 'audio',
        timestamp: log.timestamp, duration: log.duration, answered: isAnswered, declined, silenced,
        missed: log.direction === 'incoming' && !isAnswered && !declined && !silenced,
      };
    });
}

/** "Missed voice call", "Outgoing video call", "Declined voice call"… for a row. */
export function callRowLabel(row) {
  const kind = row.mode === 'video' ? 'video call' : 'voice call';
  if (row.silenced) return `Silenced ${kind}`;
  if (row.declined) return `Declined ${kind}`;
  if (row.missed) return `Missed ${kind}`;
  if (row.direction === 'incoming') return `Incoming ${kind}`;
  return row.answered ? `Outgoing ${kind}` : `Outgoing ${kind} · No answer`;
}

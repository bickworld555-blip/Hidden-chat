// The Calls tab lists every call as its own row, newest first, like WhatsApp's call log: five missed calls from
// the same person are five rows, each with its own time, voice or video, and outcome.

/**
 * The call log status of a finished call: completed | missed | declined | cancelled | no-answer | unavailable |
 * busy | failed | answered-elsewhere. `reason`: the end reason (callEngine endReason, as the server relays it);
 * `byPeer`: the other side (or the server) ended it.
 */
export function callOutcome({ answered: wasAnswered = false, direction = 'outgoing', reason = 'ended', byPeer = false } = {}) {
  if (wasAnswered) return 'completed';
  if (reason === 'answered-elsewhere') return 'answered-elsewhere';
  if (reason === 'busy') return 'busy';
  if (reason === 'failed' || reason === 'disconnected') return 'failed';
  if (direction === 'outgoing') {
    if (reason === 'declined') return 'declined';
    if (reason === 'unavailable') return 'unavailable';
    if (reason === 'no-answer') return 'no-answer';
    return byPeer ? 'no-answer' : 'cancelled';
  }
  return !byPeer && reason === 'declined' ? 'declined' : 'missed';
}

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
      const elsewhere = log.status === 'answered-elsewhere';
      return {
        key: log.id, peerId: log.peerId, direction: log.direction, mode: log.mode === 'video' ? 'video' : 'audio',
        timestamp: log.timestamp, duration: log.duration, answered: isAnswered, declined, silenced, status: log.status,
        groupId: log.groupId ?? null, groupName: log.groupName ?? null, participants: Array.isArray(log.participants) ? log.participants : null,
        missed: log.direction === 'incoming' && !isAnswered && !declined && !silenced && !elsewhere,
      };
    });
}

// What an unanswered outgoing call came to, as WhatsApp words it.
const OUTGOING_DETAIL = { declined: 'Declined', busy: 'Busy', unavailable: 'Unavailable', cancelled: 'Cancelled', failed: 'Failed' };

/** "Missed voice call", "Outgoing video call · Busy", "Declined voice call"… for a row. */
export function callRowLabel(row) {
  const kind = row.mode === 'video' ? 'video call' : 'voice call';
  if (row.silenced) return `Silenced ${kind}`;
  if (row.status === 'answered-elsewhere') return `Incoming ${kind} · Answered on another device`;
  if (row.direction === 'incoming') {
    if (row.declined) return `Declined ${kind}`;
    if (row.missed) return `Missed ${kind}`;
    return row.status === 'busy' || row.status === 'failed' ? `Incoming ${kind} · ${OUTGOING_DETAIL[row.status]}` : `Incoming ${kind}`;
  }
  if (row.answered) return `Outgoing ${kind}`;
  return `Outgoing ${kind} · ${OUTGOING_DETAIL[row.status] ?? 'No answer'}`;
}

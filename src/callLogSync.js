// The call log follows the account across its devices, like WhatsApp's companion devices: every call a device logs
// itself goes, sealed, to this account's other devices over XMPP (src/xmpp/session.js sendControl to oneself), and an
// entry from another device is merged by its id (a call several devices saw is one entry, the best outcome kept).
// Nothing about it passes the server readable.

const PREFIX = 'sync:';
const STATUSES = new Set(['completed', 'missed', 'declined', 'cancelled', 'no-answer', 'unavailable', 'busy', 'failed', 'answered-elsewhere', 'silenced']);
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_PARTICIPANTS = 64;

/** Sealed content for one call log entry. */
export function callSyncContent(entry) {
  return PREFIX + JSON.stringify({ k: 'call', e: {
    id: entry.id, peerId: entry.peerId, mode: entry.mode, direction: entry.direction, status: entry.status,
    duration: entry.duration, timestamp: entry.timestamp,
    ...(entry.groupId ? { groupId: entry.groupId } : {}), ...(entry.groupName ? { groupName: entry.groupName } : {}),
    ...(Array.isArray(entry.participants) && entry.participants.length ? { participants: entry.participants } : {}),
    ...(entry.silenceReason ? { silenceReason: entry.silenceReason } : {}),
  } });
}

export const isCallSyncContent = (content) => typeof content === 'string' && content.startsWith(PREFIX);

/** The entry in opened sync content, checked; null for anything malformed. */
export function parseCallSync(content) {
  if (!isCallSyncContent(content)) return null;
  let value;
  try { value = JSON.parse(content.slice(PREFIX.length)); } catch { return null; }
  const e = value?.k === 'call' ? value.e : null;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !ID.test(e.id) || typeof e.peerId !== 'string' || !ID.test(e.peerId)) return null;
  if (!STATUSES.has(e.status) || (e.direction !== 'incoming' && e.direction !== 'outgoing')) return null;
  const at = new Date(e.timestamp);
  if (Number.isNaN(at.getTime())) return null;
  const participants = Array.isArray(e.participants) ? e.participants.filter((id) => typeof id === 'string' && ID.test(id)).slice(0, MAX_PARTICIPANTS) : [];
  return {
    id: e.id, peerId: e.peerId, mode: e.mode === 'video' ? 'video' : 'audio', direction: e.direction, status: e.status,
    duration: Math.max(0, Math.min(Number(e.duration) || 0, 24 * 3600)), timestamp: at.toISOString(),
    ...(typeof e.groupId === 'string' && ID.test(e.groupId) ? { groupId: e.groupId } : {}),
    ...(typeof e.groupName === 'string' && e.groupName ? { groupName: e.groupName.slice(0, 100) } : {}),
    ...(participants.length ? { participants } : {}),
    ...(e.silenceReason === 'unknown-caller' || e.silenceReason === 'dnd' ? { silenceReason: e.silenceReason } : {}),
  };
}

// When two devices logged the same call differently, the more informative outcome wins: answered beats everything
// (the phone that took the call), then a decision someone made, then the plain unanswered states.
const RANK = { completed: 5, declined: 4, cancelled: 4, busy: 3, failed: 3, unavailable: 2, 'no-answer': 2, 'answered-elsewhere': 1, silenced: 1, missed: 0 };

/** Whether `incoming` should replace `existing` (same call). */
export const betterCallOutcome = (incoming, existing) => (RANK[incoming?.status] ?? 0) > (RANK[existing?.status] ?? 0);

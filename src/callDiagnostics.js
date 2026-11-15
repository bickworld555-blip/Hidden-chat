// The last CALL_LOG_LIMIT call events of this app session (ICE states, restarts, signals, network changes), kept in
// memory only: what a support check or DevTools on a test phone (window.__hmCallLog) reads when a call misbehaves.
// Event names and states only — no addresses, SDP or candidates.
export const CALL_LOG_LIMIT = 300;
const entries = [];

const describe = (value) => {
  if (value instanceof Error) return value.message;
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return String(value);
  return '[object]';
};

export function noteCallEvent(peerId, ...parts) {
  entries.push(`${new Date().toISOString().slice(11, 23)} ${String(peerId ?? '').slice(0, 6)} ${parts.map(describe).join(' ')}`);
  if (entries.length > CALL_LOG_LIMIT) entries.splice(0, entries.length - CALL_LOG_LIMIT);
}

export const callLog = () => [...entries];

if (typeof window !== 'undefined') window.__hmCallLog = callLog;

// Large group calls through the media relay (an SFU such as LiveKit; server/sfu.mjs issues room tokens).
//
// Starting one posts a "relaycall:" message to the group. Like every group message it is end-to-end encrypted
// (Sender Keys), and it carries a fresh random call key. Everyone who joins encrypts their audio and video with
// that key before it leaves the phone (LiveKit end-to-end encryption), so the relay only forwards media it
// cannot read. Calls that fit the direct path (src/callTopology.js MESH_MAX_PARTICIPANTS) never use the relay.
import { apiFetch } from './api.js';
import { parseTopology } from './callTopology.js';

export const RELAY_CALL_PREFIX = 'relaycall:';
/** A call card stays joinable this long after it was started. */
export const RELAY_CALL_JOINABLE_MS = 6 * 60 * 60 * 1000;

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

export function newCallKey(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  return toBase64(random(new Uint8Array(32)));
}

export function relayCallContent({ mode, key, startedAt = Date.now(), callId = newCallId() }) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key ?? '')) throw new Error('A call key is 32 random bytes.');
  return `${RELAY_CALL_PREFIX}${JSON.stringify({ callId, mode: mode === 'video' ? 'video' : 'audio', key, startedAt })}`;
}

export function parseRelayCall(content) {
  if (typeof content !== 'string' || !content.startsWith(RELAY_CALL_PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(RELAY_CALL_PREFIX.length));
    if (typeof value?.callId !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.key ?? '') || !Number.isFinite(value.startedAt)) return null;
    return { callId: value.callId.slice(0, 64), mode: value.mode === 'video' ? 'video' : 'audio', key: value.key, startedAt: value.startedAt };
  } catch {
    return null;
  }
}

export const relayCallJoinable = (call, now = Date.now()) => Boolean(call) && now - call.startedAt < RELAY_CALL_JOINABLE_MS;

function newCallId() {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(12))).replace(/[+/=]/g, '');
}

let topologyCache = null;
/** What this server offers: { meshMax, sfu: { url, maxParticipants } | null } (cached for a few minutes). */
export async function fetchCallTopology(token) {
  if (topologyCache && Date.now() - topologyCache.at < 5 * 60 * 1000) return topologyCache.value;
  const response = await apiFetch('/api/v1/calls/topology', { headers: { Authorization: `Bearer ${token}` } });
  const value = parseTopology(response.ok ? await response.json() : null);
  topologyCache = { at: Date.now(), value };
  return value;
}

/** A short-lived ticket into the group's room on the relay: { url, room, identity, token }. */
export async function fetchRelayToken(token, groupId) {
  const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}/call-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not join the group call.');
  return body;
}

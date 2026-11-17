// Call telemetry: a compact summary of each call connection, sent to the server every CALL_TELEMETRY_INTERVAL_MS
// during a call and once when it ends (server/callTelemetry.mjs stores it for 30 days; admins read it in the admin
// API). Without it every call fault needed a phone on USB with DevTools; with it the server sees, per call: round
// trip, loss and jitter, the incoming picture, whether incoming voice was actually played (packets vs seconds
// played: the Android output cut seen on the S23), restarts, the network path, and how fast the other phone rang.
//
// Nothing here reveals content: numbers about the connection, the call and room ids, and the other person's id
// (which the server already knows from the call's signalling).
import { apiFetch } from './api.js';

export const CALL_TELEMETRY_INTERVAL_MS = 30_000;
export const CALL_TELEMETRY_MAX_PAIRS = 8;

const number = (value, { min = 0, max = Number.MAX_SAFE_INTEGER, digits = 0 } = {}) => {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return null;
  const clamped = Math.min(max, Math.max(min, n));
  const scale = 10 ** digits;
  return Math.round(clamped * scale) / scale;
};

/** One connection's engine.telemetry() as sent: milliseconds, fractions and counts, rounded and bounded. */
export function pairTelemetry(peerId, raw = {}) {
  const packets = number(raw.packets);
  const lost = number(raw.lost);
  return {
    peerId: typeof peerId === 'string' ? peerId.slice(0, 80) : '',
    status: typeof raw.status === 'string' ? raw.status.slice(0, 16) : '',
    rttMs: raw.rtt == null ? null : number(raw.rtt * 1000, { max: 60_000 }),
    loss: packets != null && lost != null && packets + lost > 0 ? number(lost / (packets + lost), { max: 1, digits: 4 }) : null,
    jitterMs: raw.jitter == null ? null : number(raw.jitter * 1000, { max: 10_000 }),
    fps: number(raw.fps, { max: 120 }),
    width: number(raw.width, { max: 8192 }),
    height: number(raw.height, { max: 8192 }),
    audioPackets: number(raw.audioPackets),
    audioPlayedS: number(raw.audioPlayed, { digits: 1 }),
    path: raw.path === 'relay' || raw.path === 'direct' ? raw.path : null,
    iceRestarts: number(raw.iceRestarts, { max: 1000 }),
    playoutRestarts: number(raw.playoutRestarts, { max: 1000 }),
    red: Boolean(raw.red),
    ringMs: number(raw.ringMs, { max: 120_000 }),
    connectedMs: number(raw.connectedMs, { max: 24 * 3600_000 }),
  };
}

/** The report for a call: { callId, roomId, mode, direction, final, pairs }. */
export function callTelemetry({ call, pairs, final = false }) {
  return {
    callId: String(call?.id ?? '').slice(0, 80),
    roomId: String(call?.roomId ?? call?.id ?? '').slice(0, 80),
    mode: call?.mode === 'video' ? 'video' : 'audio',
    direction: call?.direction === 'incoming' ? 'incoming' : 'outgoing',
    group: Boolean(call?.groupId),
    final: Boolean(final),
    pairs: pairs.slice(0, CALL_TELEMETRY_MAX_PAIRS).map(({ peerId, telemetry }) => pairTelemetry(peerId, telemetry)),
  };
}

/** Sends a report; never throws (telemetry must not disturb a call). `keepalive` lets the final one leave on close. */
export async function sendCallTelemetry(token, report) {
  if (!token || !report?.callId || !report.pairs?.length) return false;
  try {
    const response = await apiFetch('/api/v1/calls/telemetry', {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    return response.ok;
  } catch {
    return false;
  }
}

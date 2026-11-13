// Settings › Storage and data › Network usage (as WhatsApp): how much this device has sent and received, by kind —
// calls, media, messages, status, chat backup — since the statistics were last reset. Counted where the bytes
// move (src/realtime.js, src/upload.js, src/media.js, src/mediaVault.js, src/downloads.js, src/callEngine.js,
// src/cloudBackup.js) and kept with this device's settings. Message sizes are the encrypted frames' lengths.
import { deviceStorage } from './deviceStorage.js';

export const USAGE_KEY = 'hm:network-usage';
export const USAGE_CATEGORIES = Object.freeze(['calls', 'media', 'messages', 'status', 'backup']);
// Roaming (as WhatsApp): the part of the traffic above that moved while the phone was roaming; not added to totals.
export const ROAMING = 'roaming';
const ALL_ROWS = Object.freeze([...USAGE_CATEGORIES, ROAMING]);
const COUNTERS = Object.freeze({ calls: ['outgoing', 'incoming'], messages: ['countSent', 'countReceived'] });
const SAVE_DELAY_MS = 2000;

export function emptyUsage(now = Date.now()) {
  const usage = { since: now };
  for (const category of ALL_ROWS) {
    usage[category] = { sent: 0, received: 0 };
    for (const counter of COUNTERS[category] ?? []) usage[category][counter] = 0;
  }
  return usage;
}

/** A stored value, made whole: unknown categories dropped, missing or broken numbers as 0. */
export function normalizeUsage(raw, now = Date.now()) {
  const usage = emptyUsage(Number.isFinite(raw?.since) ? raw.since : now);
  for (const category of ALL_ROWS) {
    for (const field of Object.keys(usage[category])) {
      const value = Number(raw?.[category]?.[field]);
      if (Number.isFinite(value) && value > 0) usage[category][field] = value;
    }
  }
  return usage;
}

/** Adds a delta ({ sent, received, outgoing, … }) to one category; returns a new value. */
export function addUsage(usage, category, delta) {
  if (!ALL_ROWS.includes(category)) return usage;
  const row = { ...usage[category] };
  for (const [field, amount] of Object.entries(delta ?? {})) {
    const value = Number(amount);
    if (field in row && Number.isFinite(value) && value > 0) row[field] += value;
  }
  return { ...usage, [category]: row };
}

export function usageTotals(usage) {
  let sent = 0;
  let received = 0;
  for (const category of USAGE_CATEGORIES) {
    sent += usage[category].sent;
    received += usage[category].received;
  }
  return { sent, received };
}

/**
 * Bytes a WebRTC connection has moved so far, from getStats(): the "transport" entries, or (browsers without them)
 * the selected candidate pair.
 */
export function transportBytes(report) {
  let sent = 0;
  let received = 0;
  let transports = 0;
  const pairs = [];
  report?.forEach?.((stat) => {
    if (stat.type === 'transport') {
      transports += 1;
      sent += Number(stat.bytesSent) || 0;
      received += Number(stat.bytesReceived) || 0;
    } else if (stat.type === 'candidate-pair' && (stat.selected || stat.nominated) && stat.state === 'succeeded') pairs.push(stat);
  });
  if (!transports) {
    for (const pair of pairs) {
      sent += Number(pair.bytesSent) || 0;
      received += Number(pair.bytesReceived) || 0;
    }
  }
  return { sent, received };
}

// --- This device's counters ---

let current = null;
let saveTimer = null;
const listeners = new Set();

function load() {
  if (current) return current;
  let raw = null;
  try { raw = JSON.parse(deviceStorage.getItem(USAGE_KEY) ?? 'null'); } catch { raw = null; }
  current = normalizeUsage(raw);
  return current;
}

function save() {
  saveTimer = null;
  try { deviceStorage.setItem(USAGE_KEY, JSON.stringify(current)); } catch { /* counted again from here */ }
}

function changed() {
  for (const listener of listeners) listener(current);
}

/** Counts traffic: recordUsage('media', { received: blob.size }). Saved a moment later, in one write. */
let roamingNow = false;
/** Told by src/autoDownload.js whenever it learns the connection: bytes counted while roaming also count as Roaming. */
export function setRoaming(roaming) {
  roamingNow = Boolean(roaming);
}

export function recordUsage(category, delta) {
  if (!USAGE_CATEGORIES.includes(category)) return;
  let next = addUsage(load(), category, delta);
  if (roamingNow) next = addUsage(next, ROAMING, { sent: delta?.sent, received: delta?.received });
  if (next === current) return;
  current = next;
  if (!saveTimer) {
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
    saveTimer?.unref?.();
  }
  changed();
}

export function readUsage() {
  return load();
}

export function resetUsage(now = Date.now()) {
  current = emptyUsage(now);
  clearTimeout(saveTimer);
  save();
  changed();
}

export function subscribeUsage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Approximate size of a text frame (the relay's frames are JSON with base64 ciphertext: one byte per character). */
export const frameBytes = (data) => (typeof data === 'string' ? data.length : Number(data?.byteLength ?? data?.size) || 0);

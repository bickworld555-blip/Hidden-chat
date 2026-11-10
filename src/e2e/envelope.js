// The end-to-end message envelope, shared by the app and the server (server/e2e.mjs).
//
//   e2e2:<routing>|<json>
//
// <routing> is the only part of a message the server can read, and only what it needs to do its job:
//   text                      an editable text message
//   media:<mediaId>           an attachment (which upload it may serve, forward and delete)
//   voice:<mediaId>:<s>[:once] a voice note (duration for "voice-opened", view once rules)
//   poll:<options>:<0|1>      a poll (how many options can be voted on, single or multiple choice)
//   other                     anything else (location, contact, sticker, event, …)
// <json> carries the ciphertexts, readable only by the addressed devices:
//   direct: { v: 2, sd: senderDeviceId, d: { [userId]: { [deviceId]: { p?, h, c } } } }
//   group:  { v: 2, sd: senderDeviceId, mh: membersHash, g: { kid, n, c, s }, x?: { [userId]: { [deviceId]: { p?, h, c } } } }
// `p` is the X3DH prekey header (until the recipient has answered), `h` the Double Ratchet header, `c` ciphertext;
// `g` is the Sender Key message, `x` the sender key distributions for member devices that do not have it yet.
export const ENVELOPE_PREFIX = 'e2e2:';
export const ENVELOPE_VERSION = 2;
export const MAX_DIRECT_ENVELOPE = 60_000;
export const MAX_GROUP_ENVELOPE = 900_000;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
// Structured (not editable) message formats; plain text is everything else. Kept with src/selection.js.
export const STRUCTURED = /^(?:media|emedia|viewonce|media-opened|vnote|csticker|reaction|vote|order|order-status|voice|voice-opened|call|call-schedule|poll|location|live|contact|event|file|e2e1|e2e2|sticker|product|custom):/;
const ROUTING = /^(?:text|other|media:([A-Za-z0-9_-]{1,80})(:once)?|voice:([A-Za-z0-9_-]{1,80}):(\d{1,6}(?:\.\d{1,3})?)(:once)?|poll:(\d{1,2}):([01]))$/;
// A view once photo or video: "viewonce:" + its attachment reference (media: or emedia:).
export const VIEW_ONCE_PREFIX = 'viewonce:';

export const isEnvelope = (content) => typeof content === 'string' && content.startsWith(ENVELOPE_PREFIX);

/** The routing part for a plaintext message (what the server may know about it). */
export function routingFor(content) {
  const text = typeof content === 'string' ? content : '';
  let match = /^viewonce:e?media:([A-Za-z0-9_-]{1,80})(?::|$)/.exec(text);
  if (match) return `media:${match[1]}:once`;
  // An attachment, also as a video note ("vnote:") or a sticker made from a photo ("csticker:").
  match = /^(?:vnote:|csticker:)?(?:e?media):([A-Za-z0-9_-]{1,80})(?::|$)/.exec(text);
  if (match) return `media:${match[1]}`;
  match = /^voice:([A-Za-z0-9_-]{1,80}):(\d{1,6}(?:\.\d{1,3})?)(:once)?(?::|$)/.exec(text);
  if (match) return `voice:${match[1]}:${match[2]}${match[3] ?? ''}`;
  if (text.startsWith('poll:')) {
    try {
      const poll = JSON.parse(text.slice(5));
      if (Array.isArray(poll?.options)) return `poll:${poll.options.length}:${poll.multiple === true ? 1 : 0}`;
    } catch { /* falls through to "other" */ }
    return 'other';
  }
  return STRUCTURED.test(text) ? 'other' : 'text';
}

/** Parses the routing part: { kind, mediaId?, seconds?, once?, options?, multiple? } or null. */
export function parseRouting(routing) {
  const match = ROUTING.exec(routing ?? '');
  if (!match) return null;
  if (routing === 'text' || routing === 'other') return { kind: routing };
  if (match[1]) return { kind: 'media', mediaId: match[1], once: Boolean(match[2]) };
  if (match[3]) return { kind: 'voice', mediaId: match[3], seconds: match[4], once: Boolean(match[5]) };
  return { kind: 'poll', options: Number(match[6]), multiple: match[7] === '1' };
}

export function buildEnvelope(routing, body) {
  if (!parseRouting(routing)) throw new Error('Invalid envelope routing.');
  return `${ENVELOPE_PREFIX}${routing}|${JSON.stringify({ v: ENVELOPE_VERSION, ...body })}`;
}

/** Splits an envelope: { routing, route (parsed), body } or null when it is not a well-formed envelope. */
export function parseEnvelope(content) {
  if (!isEnvelope(content)) return null;
  const bar = content.indexOf('|');
  if (bar < 0) return null;
  const routing = content.slice(ENVELOPE_PREFIX.length, bar);
  const route = parseRouting(routing);
  if (!route) return null;
  let body;
  try {
    body = JSON.parse(content.slice(bar + 1));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || body.v !== ENVELOPE_VERSION || typeof body.sd !== 'string' || !ID.test(body.sd)) return null;
  const directOk = body.d && typeof body.d === 'object' && !body.g;
  const groupOk = body.g && typeof body.g === 'object' && typeof body.mh === 'string' && !body.d;
  if (!directOk && !groupOk) return null;
  return { routing, route, body };
}

/** The routing as it was before encryption ("voice:<id>:<s>:once", "media:<id>" …), for server-side rules. */
export function effectiveRouting(content) {
  const parsed = parseEnvelope(content);
  return parsed ? parsed.routing : null;
}

/** Device addresses in a { [userId]: { [deviceId]: … } } map, as "userId/deviceId" strings, sorted. */
export function addressesOf(map) {
  const out = [];
  for (const [userId, devices] of Object.entries(map ?? {})) {
    if (!devices || typeof devices !== 'object') continue;
    for (const deviceId of Object.keys(devices)) out.push(`${userId}/${deviceId}`);
  }
  return out.sort();
}

/** The hash of a group's device set, the same on every device and on the server. */
export async function membersHash(addresses, digest) {
  return (await digest([...addresses].sort().join('\n'))).slice(0, 32);
}

/** Replaces the attachment id in decrypted content with the one the server routed (forwards get a copy). */
export function withRoutedMedia(content, route) {
  if (!route?.mediaId || typeof content !== 'string') return content;
  return content.replace(/^((?:viewonce:|vnote:|csticker:)?e?media|voice):([A-Za-z0-9_-]{1,80})(?=:|$)/, (_match, prefix) => `${prefix}:${route.mediaId}`);
}

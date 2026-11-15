// What happens to a message after it is sent — delete for everyone, reactions, edits, "played", and the disappearing
// timer — for messages that travelled over XMPP (src/xmpp/session.js). The server never had those messages, so it
// cannot change them: the change itself travels end to end, as a sealed "control" message to every device of both
// people, and each device applies it to its own copy. Messages the server stored keep the server path unchanged.
//
// A control is ordinary sealed content ("ctl:" + JSON) inside the usual end-to-end envelope: the server sees a
// message like any other. Each device checks it before applying it:
//   delete  only the sender of the message may delete it for everyone;
//   edit    only its sender, only text, within the edit window; an older edit never replaces a newer one;
//   react   either person in the chat; per person, the latest reaction wins whatever order they arrive in;
//   played  only the person the voice note was sent to.
// A control can overtake its message (another path, an offline queue): it is held and applied when the message
// arrives (createControlBuffer), and forgotten after HOLD_MS.
//
// Group controls name their group ("g") instead of a person, are sealed with the group's Sender Keys and go through
// the same <fanout> as group messages (mod_hm checks the sender may post there). Their rules match the server's
// group endpoints (server/index.mjs DELETE, server/parity.mjs PUT):
//   delete  the message's author within DELETE_WINDOW_MS, or a group admin at any time;
//   edit    only its author, only text, within the edit window; an older edit never replaces a newer one;
//   react   any member; per member, the latest reaction wins;
//   played  anyone but the author.
// Admin status comes from this device's copy of the group details (src/groupCache.js), passed in as roleOf.

import { STRUCTURED } from './envelope.js';

export const CONTROL_PREFIX = 'ctl:';
export const CONTROL_OPS = new Set(['delete', 'edit', 'react', 'played']);
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
// Delete for everyone by the author, as the server allows for group messages (deleteForEveryoneWindowMs) and the app
// offers (src/selection.js DELETE_FOR_EVERYONE_WINDOW_MS).
export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Clocks on two phones disagree a little; an edit stamped this far past the window still counts.
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const HOLD_MS = 7 * 24 * 60 * 60 * 1000;
export const HOLD_MAX = 1000;
const MAX_EDIT_CHARS = 4000;
const MAX_EMOJI_CHARS = 32;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * The sealed content of a control: { op, t (target message id), at, e?, c? } plus, for a direct chat, p (the chat's
 * other person) or, for a group, g (the group id). Exactly one of the two.
 */
export function controlContent({ op, target, peerId = null, groupId = null, at = Date.now(), emoji = null, text = null }) {
  if (Boolean(peerId) === Boolean(groupId)) throw new Error('A control names either a person or a group.');
  return CONTROL_PREFIX + JSON.stringify({
    op, t: target, ...(groupId ? { g: groupId } : { p: peerId }), at,
    ...(op === 'react' ? { e: emoji ?? null } : {}),
    ...(op === 'edit' ? { c: text } : {}),
  });
}

export const isControlContent = (content) => typeof content === 'string' && content.startsWith(CONTROL_PREFIX);

/** The control in opened content, checked; null for anything malformed. */
export function parseControl(content) {
  if (!isControlContent(content)) return null;
  let value;
  try { value = JSON.parse(content.slice(CONTROL_PREFIX.length)); } catch { return null; }
  if (!value || typeof value !== 'object' || !CONTROL_OPS.has(value.op)) return null;
  if (typeof value.t !== 'string' || !ID.test(value.t)) return null;
  const direct = typeof value.p === 'string' && ID.test(value.p);
  const group = typeof value.g === 'string' && ID.test(value.g);
  if (direct === group || (value.p !== undefined && !direct) || (value.g !== undefined && !group)) return null;
  if (!Number.isFinite(value.at) || value.at <= 0) return null;
  const control = { op: value.op, target: value.t, at: value.at, ...(group ? { groupId: value.g } : { peerId: value.p }) };
  if (value.op === 'react') {
    if (value.e !== null && (typeof value.e !== 'string' || !value.e || value.e.length > MAX_EMOJI_CHARS)) return null;
    control.emoji = value.e;
  }
  if (value.op === 'edit') {
    if (typeof value.c !== 'string' || !value.c.trim() || value.c.length > MAX_EDIT_CHARS) return null;
    control.text = value.c;
  }
  return control;
}

const timeOf = (message) => {
  const value = message?.timestamp ?? message?.createdAt;
  return typeof value === 'number' ? value : Date.parse(value ?? '');
};
// Text, not an attachment, call record or other structured payload (the server's isEditableText rule).
const isText = (content) => typeof content === 'string' && content.length > 0 && !STRUCTURED.test(content);

/**
 * What a control does on this device. `senderId`: who sent the control (the envelope proves it). `target`: this
 * device's copy of the message, or null. `me`: this account. `reactedAt(messageId, userId)`: when that person's
 * current reaction was made (null if unknown). Answers one of
 *   { action: 'apply', event }   an app event to handle like the server's own (message:deleted, …)
 *   { action: 'hold' }           the message is not here yet
 *   { action: 'ignore', reason }
 */
export function resolveControl(control, { senderId, target, me, reactedAt = () => null, groupId = null, roleOf = () => null }) {
  if (!control || typeof senderId !== 'string') return { action: 'ignore', reason: 'malformed' };
  if (control.groupId || groupId) return resolveGroupControl(control, { senderId, target, groupId, roleOf, reactedAt });
  // The chat this control belongs to must be one of the sender's: from the other person, or from my own device.
  const chatPeer = senderId === me ? control.peerId : senderId;
  if (senderId !== me && control.peerId !== me) return { action: 'ignore', reason: 'not-this-chat' };
  if (!target) return { action: 'hold' };
  const inChat = (target.senderId === me && target.receiverId === chatPeer) || (target.senderId === chatPeer && (target.receiverId === me || !target.receiverId));
  if (!inChat) return { action: 'ignore', reason: 'not-this-chat' };
  const messageId = target.id;
  switch (control.op) {
    case 'delete':
      if (target.senderId !== senderId) return { action: 'ignore', reason: 'not-sender' };
      return { action: 'apply', event: { type: 'message:deleted', messageId, scope: 'everyone' } };
    case 'edit': {
      if (target.senderId !== senderId) return { action: 'ignore', reason: 'not-sender' };
      if (target.deleted) return { action: 'ignore', reason: 'deleted' };
      if (!isText(target.content)) return { action: 'ignore', reason: 'not-text' };
      const sent = timeOf(target);
      if (Number.isFinite(sent) && control.at - sent > EDIT_WINDOW_MS + CLOCK_SKEW_MS) return { action: 'ignore', reason: 'too-late' };
      const previous = Date.parse(target.editedAt ?? '');
      if (Number.isFinite(previous) && previous >= control.at) return { action: 'ignore', reason: 'older' };
      return { action: 'apply', event: { type: 'message:edited', messageId, senderId, content: control.text, editedAt: new Date(control.at).toISOString() } };
    }
    case 'react': {
      if (target.deleted) return { action: 'ignore', reason: 'deleted' };
      const previous = reactedAt(messageId, senderId);
      if (previous !== null && previous >= control.at) return { action: 'ignore', reason: 'older' };
      return { action: 'apply', event: { type: 'message:reaction', messageId, userId: senderId, emoji: control.emoji, at: control.at, messageSenderId: target.senderId } };
    }
    case 'played':
      if (target.senderId === senderId) return { action: 'ignore', reason: 'not-listener' };
      return { action: 'apply', event: { type: 'message:played', messageId } };
    default:
      return { action: 'ignore', reason: 'malformed' };
  }
}

/**
 * A group control (`groupId`: the group whose Sender Keys opened it, so the envelope proves both the group and the
 * sender). `roleOf(userId)`: 'admin', 'member', or null when this device's group details do not list them. Answers like
 * resolveControl, with the group events the app already knows (group:message-deleted, group:message-edited) and two
 * new ones (group:message-reaction, group:message-played).
 */
function resolveGroupControl(control, { senderId, target, groupId, roleOf, reactedAt }) {
  // Opened with this group's keys, and naming this group: a control for one group never acts in another.
  if (!control.groupId || control.groupId !== groupId) return { action: 'ignore', reason: 'not-this-chat' };
  if (!target) return { action: 'hold' };
  if (target.groupId !== groupId) return { action: 'ignore', reason: 'not-this-chat' };
  const messageId = target.id;
  const authored = target.senderId === senderId;
  switch (control.op) {
    case 'delete': {
      if (roleOf(senderId) === 'admin') return { action: 'apply', event: { type: 'group:message-deleted', groupId, messageId, reason: 'deleted', by: senderId } };
      if (!authored) return { action: 'ignore', reason: 'not-sender' };
      const sent = timeOf(target);
      if (Number.isFinite(sent) && control.at - sent > DELETE_WINDOW_MS + CLOCK_SKEW_MS) return { action: 'ignore', reason: 'too-late' };
      return { action: 'apply', event: { type: 'group:message-deleted', groupId, messageId, reason: 'deleted', by: senderId } };
    }
    case 'edit': {
      if (!authored) return { action: 'ignore', reason: 'not-sender' };
      if (target.deleted) return { action: 'ignore', reason: 'deleted' };
      if (!isText(target.content)) return { action: 'ignore', reason: 'not-text' };
      const sent = timeOf(target);
      if (Number.isFinite(sent) && control.at - sent > EDIT_WINDOW_MS + CLOCK_SKEW_MS) return { action: 'ignore', reason: 'too-late' };
      const previous = Date.parse(target.editedAt ?? '');
      if (Number.isFinite(previous) && previous >= control.at) return { action: 'ignore', reason: 'older' };
      return { action: 'apply', event: { type: 'group:message-edited', groupId, messageId, senderId, content: control.text, editedAt: new Date(control.at).toISOString() } };
    }
    case 'react': {
      if (target.deleted) return { action: 'ignore', reason: 'deleted' };
      const previous = reactedAt(messageId, senderId);
      if (previous !== null && previous >= control.at) return { action: 'ignore', reason: 'older' };
      return { action: 'apply', event: { type: 'group:message-reaction', groupId, messageId, userId: senderId, emoji: control.emoji, at: control.at, messageSenderId: target.senderId } };
    }
    case 'played':
      if (authored) return { action: 'ignore', reason: 'not-listener' };
      return { action: 'apply', event: { type: 'group:message-played', groupId, messageId, userId: senderId } };
    default:
      return { action: 'ignore', reason: 'malformed' };
  }
}

/** A member's role in this device's copy of a group's details (src/groupCache.js): 'admin', 'member' or null. */
export function roleIn(details, userId) {
  const member = Array.isArray(details?.members) ? details.members.find((item) => item?.id === userId) : null;
  return member ? (member.role === 'admin' ? 'admin' : 'member') : null;
}

/**
 * Controls waiting for their message. hold() keeps one (deduplicated, at most HOLD_MAX, each for HOLD_MS); take(id)
 * hands back and forgets those for a message that has now arrived, oldest first.
 */
export function createControlBuffer({ now = () => Date.now(), holdMs = HOLD_MS, max = HOLD_MAX } = {}) {
  const held = new Map(); // target id -> [{ control, senderId, heldAt }]
  let size = 0;
  const prune = () => {
    const cutoff = now() - holdMs;
    for (const [id, list] of held) {
      const kept = list.filter((entry) => entry.heldAt > cutoff);
      size -= list.length - kept.length;
      if (kept.length) held.set(id, kept); else held.delete(id);
    }
    while (size > max) {
      const [oldestId, list] = held.entries().next().value;
      list.shift();
      size -= 1;
      if (!list.length) held.delete(oldestId);
    }
  };
  return {
    hold(control, senderId) {
      const list = held.get(control.target) ?? [];
      if (list.some((entry) => entry.senderId === senderId && entry.control.op === control.op && entry.control.at === control.at)) return;
      list.push({ control, senderId, heldAt: now() });
      held.delete(control.target);
      held.set(control.target, list);
      size += 1;
      prune();
    },
    take(messageId) {
      prune();
      const list = held.get(messageId);
      if (!list) return [];
      held.delete(messageId);
      size -= list.length;
      return list.sort((a, b) => a.control.at - b.control.at);
    },
    get size() { prune(); return size; },
  };
}

// --- The disappearing timer --------------------------------------------------------------------------------------

// The timers the app offers (24 hours, 7 days, 90 days); anything else inside an envelope is ignored.
export const DISAPPEAR_CHOICES = new Set([24 * 3600, 7 * 24 * 3600, 90 * 24 * 3600]);
export const cleanDisappear = (value) => (Number.isInteger(value) && DISAPPEAR_CHOICES.has(value) ? value : 0);

/** When a message with this timer disappears (ms), or null. */
export function expiryOf(sentAt, seconds) {
  const sent = typeof sentAt === 'number' ? sentAt : Date.parse(sentAt ?? '');
  const timer = cleanDisappear(seconds);
  return timer && Number.isFinite(sent) ? sent + timer * 1000 : null;
}

/** Ids of the messages whose timer has run out. */
export function expiredIds(messages, now = Date.now()) {
  const out = [];
  for (const message of messages ?? []) {
    const at = typeof message?.expiresAt === 'number' ? message.expiresAt : Date.parse(message?.expiresAt ?? '');
    if (Number.isFinite(at) && at <= now) out.push(message.id);
  }
  return out;
}

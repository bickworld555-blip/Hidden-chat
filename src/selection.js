// One list of structured (not editable) formats, shared with the server (src/e2e/envelope.js).
import { STRUCTURED } from './e2e/envelope.js';
export const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A text message can be corrected for 15 minutes after sending it, as on WhatsApp (server/parity.mjs EDIT_WINDOW_MS).
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/** Whether the sender may still edit this message's text. */
export function canEditMessage(message, userId, now = Date.now()) {
  if (!message || message.senderId !== userId || message.deleted || message.status === 'failed') return false;
  if (typeof message.content !== 'string' || !message.content || STRUCTURED.test(message.content)) return false;
  const raw = message.timestamp ?? message.createdAt;
  const sentAt = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(sentAt) && now - sentAt <= EDIT_WINDOW_MS;
}

const isCall = (message) => typeof message?.content === 'string' && message.content.startsWith('call:');
// Call cards and "This message was deleted" placeholders can only be deleted for me: nothing to reply to, forward or star.
const isInert = (message) => isCall(message) || Boolean(message?.deleted);

export function toggleSelection(ids, id) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

// Selection is kept as ids and resolved against the live conversation, so edits (stars, reactions) are current,
// messages deleted elsewhere drop out, and the result is in chat order as WhatsApp forwards and deletes them.
export function resolveSelection(messages, ids) {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  return messages.filter((message) => wanted.has(message?.id));
}

export function canDeleteForEveryone(message, userId, now = Date.now()) {
  if (!message || message.senderId !== userId || isInert(message) || message.status === 'failed') return false;
  const sentAt = new Date(message.timestamp).getTime();
  return Number.isFinite(sentAt) && now - sentAt <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

export function selectionActions(selected, userId, now = Date.now()) {
  const count = selected.length;
  const single = count === 1 ? selected[0] : null;
  return {
    count,
    canReply: Boolean(single) && !isInert(single),
    canInfo: Boolean(single) && !single.deleted,
    canForward: count > 0 && !selected.some(isInert),
    canStar: count > 0 && !selected.some((message) => message.deleted),
    allStarred: count > 0 && selected.every((message) => message.starred),
    deleteForEveryone: count > 0 && selected.every((message) => canDeleteForEveryone(message, userId, now)),
    hasMedia: selected.some((message) => /^(media|voice):/.test(message.content ?? '')),
    canEdit: Boolean(single) && canEditMessage(single, userId, now),
    canPin: Boolean(single) && !isInert(single) && single.status !== 'failed',
  };
}

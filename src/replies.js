import { previewFor } from './store.js';

// The quote attached to a reply references the quoted message by id, sender and raw content.
export function replyQuoteFor(message) {
  return { id: message.id, senderId: message.senderId, content: message.content };
}

// Display text for a quote, resolved for the current viewer (the same quote reads "You" on one side only).
// Quotes saved before senders were recorded carry ready-made display text instead.
export function quoteView(replyTo, userId, peerName) {
  if (!replyTo) return null;
  // `self`: the quoted message is mine (the card takes my accent colour; theirs takes the contact's).
  if (!replyTo.senderId) return { sender: replyTo.senderName ?? '', text: replyTo.content ?? '', self: replyTo.senderName === 'You' };
  return {
    sender: replyTo.senderId === userId ? 'You' : (peerName || 'Contact'),
    text: replyTo.deleted ? '🚫 This message was deleted' : previewFor(replyTo.content),
    self: replyTo.senderId === userId,
  };
}

/**
 * The quote to show for a reply, from this device's own copy of the quoted message: replies carry only the quoted
 * message's id, inside the encryption (src/e2e/client.js), so the server never learns what replies to what. A reply
 * whose original is not on this device (deleted, or from before this device joined) says so.
 */
export function resolveQuote(replyTo, messages) {
  if (!replyTo?.id) return replyTo ?? null;
  const local = (messages ?? []).find((message) => message?.id === replyTo.id);
  if (local) return { id: local.id, senderId: local.senderId, content: local.content, ...(local.deleted ? { deleted: true } : {}) };
  // Described by the server (older apps): its content is still sealed for someone else's keys, so it is not shown.
  if (replyTo.senderId && typeof replyTo.content === 'string' && !replyTo.content.startsWith('e2e')) return replyTo;
  return { id: replyTo.id, senderName: '', content: 'Original message not on this device' };
}

const STATUS_KIND_LABEL = { image: '📷 Photo', video: '🎥 Video', file: '📄 Document' };

/**
 * A reply or reaction to a status, as its quote card and its chat-list line show it (as on WhatsApp). `mine`: I sent
 * the reply, so the status was theirs (`peerName`); otherwise they replied to my status. `content` is the reply itself
 * (the emoji, for a reaction).
 */
export function statusQuoteView(reply, { mine = false, peerName = '', content = '' } = {}) {
  if (!reply || typeof reply !== 'object') return null;
  const owner = mine ? (peerName || 'Contact') : 'You';
  const text = reply.kind === 'text' ? (reply.text || 'Status') : (STATUS_KIND_LABEL[reply.kind] ?? 'Status');
  const whose = mine ? 'their' : 'your';
  const said = String(content ?? '').trim();
  return {
    owner,
    ownerIsMe: !mine,
    title: `${owner} · Status`,
    text,
    kind: reply.kind,
    background: reply.kind === 'text' && /^#[0-9a-f]{6}$/i.test(reply.bg ?? '') ? reply.bg : null,
    reaction: reply.reaction === true,
    // The chat list's line for it: "Reacted 😍 to your status", "Replied to their status: …".
    listLabel: reply.reaction
      ? `${mine ? 'You reacted' : 'Reacted'} ${said} to ${whose} status`.replace(/\s+/g, ' ')
      : `${mine ? 'You replied' : 'Replied'} to ${whose} status`,
    listText: reply.reaction ? '' : said,
  };
}

import { previewFor } from './store.js';

// The quote attached to a reply references the quoted message by id, sender and raw content.
export function replyQuoteFor(message) {
  return { id: message.id, senderId: message.senderId, content: message.content };
}

// Display text for a quote, resolved for the current viewer (the same quote reads "You" on one side only).
// Quotes saved before senders were recorded carry ready-made display text instead.
export function quoteView(replyTo, userId, peerName) {
  if (!replyTo) return null;
  if (!replyTo.senderId) return { sender: replyTo.senderName ?? '', text: replyTo.content ?? '' };
  return {
    sender: replyTo.senderId === userId ? 'You' : (peerName || 'Contact'),
    text: replyTo.deleted ? '🚫 This message was deleted' : previewFor(replyTo.content),
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

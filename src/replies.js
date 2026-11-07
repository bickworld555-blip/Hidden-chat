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

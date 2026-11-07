export const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;

const isCall = (message) => typeof message?.content === 'string' && message.content.startsWith('call:');

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
  if (!message || message.senderId !== userId || isCall(message) || message.status === 'failed') return false;
  const sentAt = new Date(message.timestamp).getTime();
  return Number.isFinite(sentAt) && now - sentAt <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

export function selectionActions(selected, userId, now = Date.now()) {
  const count = selected.length;
  const single = count === 1 ? selected[0] : null;
  return {
    count,
    canReply: Boolean(single) && !isCall(single),
    canInfo: Boolean(single),
    canForward: count > 0 && !selected.some(isCall),
    allStarred: count > 0 && selected.every((message) => message.starred),
    deleteForEveryone: count > 0 && selected.every((message) => canDeleteForEveryone(message, userId, now)),
    hasMedia: selected.some((message) => /^(media|voice):/.test(message.content ?? '')),
  };
}

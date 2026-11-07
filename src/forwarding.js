// WhatsApp-style forward targets: up to five chats per forward, grouped the way the share sheet lists them.
export const FORWARD_LIMIT = 5;
export const FREQUENT_LIMIT = 3;

function outgoingCounts(messages, userId) {
  const counts = new Map();
  for (const [chatId, list] of Object.entries(messages ?? {})) {
    let count = 0;
    for (const message of list ?? []) {
      if (message?.senderId === userId && !String(message.content ?? '').startsWith('call:')) count += 1;
    }
    if (count > 0) counts.set(chatId, count);
  }
  return counts;
}

// `chats` is expected in store order (most recent activity first); the frequent section ranks by messages you sent.
export function forwardSections(chats, messages, userId, query = '') {
  const needle = query.trim().replace(/^@+/, '').toLowerCase();
  const candidates = chats.filter((chat) => chat?.id && chat.id !== userId
    && (!needle || `${chat.name ?? ''} ${chat.username ?? ''}`.toLowerCase().includes(needle)));
  const counts = outgoingCounts(messages, userId);
  const frequent = candidates
    .filter((chat) => counts.has(chat.id))
    .map((chat, index) => ({ chat, index }))
    .sort((left, right) => counts.get(right.chat.id) - counts.get(left.chat.id) || left.index - right.index)
    .slice(0, FREQUENT_LIMIT)
    .map(({ chat }) => chat);
  const shown = new Set(frequent.map((chat) => chat.id));
  const recent = candidates.filter((chat) => !shown.has(chat.id) && chat.lastActivityAt);
  const others = candidates.filter((chat) => !shown.has(chat.id) && !chat.lastActivityAt);
  return [
    { id: 'frequent', title: 'Frequently contacted', chats: frequent },
    { id: 'recent', title: 'Recent chats', chats: recent },
    { id: 'others', title: 'Other contacts', chats: others },
  ].filter((section) => section.chats.length > 0);
}

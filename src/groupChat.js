// Pure helpers for the group conversation UI: scheduled-call messages, sender colours, day separators
// and chat export. Kept free of store/React imports so the store's previewFor can use them too.

export const SCHEDULED_CALL_PREFIX = 'call-schedule:';
const SENDER_COLORS = ['#06cf9c', '#53bdeb', '#ff72a1', '#ffbc38', '#a5b337', '#fc9775', '#d88deb', '#25d366', '#7f66ff', '#e26ab6'];

// A scheduled call is an ordinary group message whose content is `call-schedule:{"title","at","mode"}`.
export function scheduledCallContent({ title, at, mode }) {
  const cleanTitle = String(title ?? '').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('Give the call a name.');
  if (!Number.isFinite(at)) throw new Error('Choose a valid date and time.');
  return `${SCHEDULED_CALL_PREFIX}${JSON.stringify({ title: cleanTitle, at, mode: mode === 'video' ? 'video' : 'audio' })}`;
}

export function parseScheduledCall(content) {
  if (typeof content !== 'string' || !content.startsWith(SCHEDULED_CALL_PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(SCHEDULED_CALL_PREFIX.length));
    if (typeof value?.title !== 'string' || !Number.isFinite(value.at)) return null;
    return { title: value.title.slice(0, 120), at: value.at, mode: value.mode === 'video' ? 'video' : 'audio' };
  } catch {
    return null;
  }
}

export function scheduledCallPreview(content) {
  const call = parseScheduledCall(content);
  return call ? `📅 Scheduled ${call.mode === 'video' ? 'video' : 'voice'} call: ${call.title}` : null;
}

// Stable per-member name colour, like messenger group chats.
export function senderColor(senderId = '') {
  let hash = 0;
  for (const character of String(senderId)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

export function dayLabel(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// Inserts a { kind: 'day' } marker before the first message of each calendar day.
export function withDaySeparators(messages, now = new Date()) {
  const items = [];
  let lastDay = '';
  for (const message of messages) {
    const key = new Date(message.createdAt).toDateString();
    if (key !== lastDay) {
      items.push({ kind: 'day', key: `day-${key}`, label: dayLabel(message.createdAt, now) });
      lastDay = key;
    }
    items.push({ kind: 'message', key: message.id, message });
  }
  return items;
}

// Plain-text export of the messages this member can see, one line per message.
export function exportGroupChat(group, messages, userId) {
  const names = new Map((group?.members ?? []).map((member) => [member.id, member.id === userId ? 'You' : member.name]));
  const lines = messages.map((message) => {
    const when = new Date(message.createdAt).toISOString().replace('T', ' ').slice(0, 16);
    const who = names.get(message.senderId) ?? 'Former member';
    const content = message.content.startsWith('media:')
      ? `<attachment: ${message.content.split(':').slice(2).join(':') || 'file'}>`
      : scheduledCallPreview(message.content) ?? message.content;
    return `[${when} UTC] ${who}: ${content}`;
  });
  return [`Chat export: ${group?.name ?? 'Group'}`, ...lines].join('\n') + '\n';
}

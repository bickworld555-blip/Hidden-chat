// Settings › Storage and data › Manage storage (as WhatsApp): the attachments kept on this device, by chat, largest
// first, plus everything over 5 MB for review. Sizes are the files actually stored here (src/mediaVault.js); a chat's
// messages only say which stored file belongs to which chat.
import { isMediaContent, parseMediaRef } from './media.js';
import { parseVoiceContent } from './voice.js';

export const LARGE_ITEM_BYTES = 5 * 1024 * 1024;
export const OTHER_ROW_ID = 'other';

/** The attachment a message carries: { id, name, voice }, or null. */
export function attachmentOf(content) {
  if (isMediaContent(content)) {
    const ref = parseMediaRef(content);
    return ref?.id ? { id: ref.id, name: ref.filename, voice: false } : null;
  }
  const voice = parseVoiceContent(content);
  return voice?.id ? { id: voice.id, name: 'Voice message', voice: true } : null;
}

/**
 * stored: [{ id, size, contentType, storedAt }]; chats: [{ id, name, kind, person, messages: [{ content, at }] }].
 * Returns { total, rows: [{ id, name, kind, person, bytes, items }], large }. A file in two chats counts once, in
 * the first; stored files no chat mentions (statuses, chats deleted since) form the "Other" row.
 */
export function storageBreakdown({ stored, chats }) {
  const byId = new Map(stored.map((item) => [item.id, item]));
  const claimed = new Set();
  const rows = [];
  for (const chat of chats) {
    const items = [];
    for (const message of chat.messages ?? []) {
      const attachment = attachmentOf(message?.content);
      const file = attachment && byId.get(attachment.id);
      if (!file || claimed.has(file.id)) continue;
      claimed.add(file.id);
      items.push({ ...file, name: attachment.name, voice: attachment.voice, chatId: chat.id, at: message.at ?? file.storedAt });
    }
    if (items.length) rows.push({ id: chat.id, name: chat.name, kind: chat.kind, person: chat.person, bytes: sum(items), items });
  }
  const other = stored.filter((item) => !claimed.has(item.id)).map((item) => ({ ...item, name: 'Attachment', voice: false, chatId: OTHER_ROW_ID, at: item.storedAt }));
  if (other.length) rows.push({ id: OTHER_ROW_ID, name: 'Other', kind: 'other', bytes: sum(other), items: other });
  rows.sort((left, right) => right.bytes - left.bytes);
  const large = rows.flatMap((row) => row.items).filter((item) => item.size > LARGE_ITEM_BYTES).sort((left, right) => right.size - left.size);
  return { total: sum(stored), rows, large };
}

/** A chat's items in WhatsApp's orders: largest, newest or oldest first. */
export function sortItems(items, order) {
  const copy = [...items];
  if (order === 'newest') return copy.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  if (order === 'oldest') return copy.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  return copy.sort((left, right) => right.size - left.size);
}

function sum(items) {
  return items.reduce((total, item) => total + (Number(item.size) || 0), 0);
}

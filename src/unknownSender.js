// Unknown sender: when a 1:1 chat gets the "Not in your contacts" card (src/components/UnknownSender.jsx), and which
// chats the person hid it in (kept on this device).

/** Whether a 1:1 chat is with an unknown sender: they wrote, they are not saved or named, nobody blocked. */
export function isUnknownSender({ chat, messages = [], blocked = false, userId = '' }) {
  if (!chat || chat.group || chat.deleted || chat.id === userId || blocked) return false;
  if (chat.saved === true || chat.alias) return false;
  return messages.some((message) => message?.senderId === chat.id);
}

export const UNKNOWN_DISMISSED_KEY = 'hm.unknownSenderDismissed';
export function readDismissed(storage = globalThis.localStorage) {
  try { return new Set(JSON.parse(storage?.getItem(UNKNOWN_DISMISSED_KEY) ?? '[]')); } catch { return new Set(); }
}
export function dismissUnknown(chatId, storage = globalThis.localStorage) {
  const set = readDismissed(storage);
  set.add(chatId);
  try { storage?.setItem(UNKNOWN_DISMISSED_KEY, JSON.stringify([...set].slice(-500))); } catch {}
}

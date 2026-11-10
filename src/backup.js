// Chat backups, like WhatsApp's end-to-end encrypted backup: everything in the file is encrypted on this device
// with a key derived from a password only the user knows (PBKDF2-SHA-256, 600,000 rounds → AES-256-GCM). The
// server never sees the file or the password; a lost password means the backup cannot be opened.
//
// File: a JSON header (format, version, KDF salt and rounds, IV) and the ciphertext of the backup JSON, with the
// header bound as additional authenticated data so it cannot be altered.
export const BACKUP_FORMAT = 'hidden-messenger-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_ROUNDS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function deriveKey(password, salt, rounds, subtle) {
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const headerBytes = (header) => encoder.encode(JSON.stringify(header));

/** Encrypts `data` (any JSON) with `password`; resolves the file text. */
export async function sealBackup(data, password, { subtle = globalThis.crypto.subtle, random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), rounds = BACKUP_ROUNDS } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  const salt = random(16);
  const iv = random(12);
  const header = { format: BACKUP_FORMAT, version: BACKUP_VERSION, kdf: { name: 'PBKDF2-SHA-256', rounds, salt: toBase64(salt) }, cipher: { name: 'AES-256-GCM', iv: toBase64(iv) } };
  const key = await deriveKey(password, salt, rounds, subtle);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerBytes(header) }, key, encoder.encode(JSON.stringify(data))));
  return JSON.stringify({ ...header, data: toBase64(ciphertext) });
}

/** Opens a backup file's text with `password`; throws a readable error for a wrong password or another file. */
export async function openBackup(text, password, { subtle = globalThis.crypto.subtle } = {}) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('This is not a Hidden Messenger backup file.');
  }
  if (file?.format !== BACKUP_FORMAT || typeof file.data !== 'string') throw new Error('This is not a Hidden Messenger backup file.');
  if (file.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Hidden Messenger. Update the app first.');
  const rounds = Number(file.kdf?.rounds);
  if (!Number.isInteger(rounds) || rounds < 100_000 || rounds > 10_000_000) throw new Error('This backup file is damaged.');
  const { data, ...header } = file;
  try {
    const key = await deriveKey(password, fromBase64(file.kdf.salt), rounds, subtle);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(file.cipher.iv), additionalData: headerBytes(header) }, key, fromBase64(data));
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('Wrong password, or the backup file is damaged.');
  }
}

/** What a backup holds: direct chats and their messages, contacts, call history, chat preferences and groups. */
export function buildBackupData({ user, chats, messages, callLogs, preferences, groups, createdAt = new Date().toISOString() }) {
  return {
    kind: 'chats',
    createdAt,
    account: { id: user?.id ?? null, username: user?.username ?? null, name: user?.name ?? null },
    chats: (chats ?? []).map(({ id, username, name, initials, color, saved }) => ({ id, username, name, initials, color, saved })),
    messages: messages ?? {},
    callLogs: callLogs ?? [],
    preferences: preferences ?? {},
    groups: groups ?? [],
  };
}

/** Checks a decrypted backup before restoring: the account must match and the shapes must be right. */
export function validateBackupData(data, userId) {
  if (data?.kind !== 'chats' || typeof data.messages !== 'object' || !Array.isArray(data.chats)) throw new Error('This backup file is damaged.');
  if (data.account?.id && userId && data.account.id !== userId) {
    throw new Error(`This backup belongs to @${data.account.username ?? 'another account'}. Sign in to that account to restore it.`);
  }
  for (const [chatId, list] of Object.entries(data.messages)) {
    if (!Array.isArray(list) || list.some((message) => typeof message?.id !== 'string' || typeof message.timestamp !== 'string')) throw new Error(`The backup of chat ${chatId} is damaged.`);
  }
  return data;
}

const pad = (value) => String(value).padStart(2, '0');
const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** WhatsApp-style text export of one chat: "dd/mm/yyyy, hh:mm - Name: text". `describe` turns content into text. */
export function exportChatText({ title, messages, nameFor, describe }) {
  const lines = (messages ?? []).filter((message) => message?.id && !message.deleted).map((message) => {
    const body = describe(message.content);
    return `${stamp(message.timestamp ?? new Date(message.createdAt).toISOString())} - ${nameFor(message.senderId)}: ${body}${message.editedAt ? ' <This message was edited>' : ''}`;
  });
  return [`Chat with ${title}`, `Exported from Hidden Messenger on ${stamp(new Date().toISOString())}`, '', ...lines].join('\n') + '\n';
}

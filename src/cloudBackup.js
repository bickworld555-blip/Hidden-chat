// End-to-end encrypted backup kept for the account on the server (WhatsApp-style). The whole local history is
// sealed on this device (src/backup.js) with a password or a 64-digit recovery key; only the sealed file is
// uploaded, and the server cannot open it. Since the server keeps messages only until every device has them, this
// backup is what brings chats back on a new or reset phone.
//
// The secret is kept on this device, encrypted at rest (src/secureStorage.js), so backups can run daily or weekly
// without asking again; it is never sent anywhere.
import { apiFetch } from './api.js';
import { MIN_PASSWORD_LENGTH, buildBackupData, openBackup, sealBackup, validateBackupData } from './backup.js';
import { secureDel, secureGet, secureSet } from './secureStorage.js';
import { loadAllSavedMessages, useChatStore } from './store.js';

export const FREQUENCIES = Object.freeze({ daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, off: 0 });
const SETTINGS_KEY = (userId) => `hm:cloud-backup:${userId}`;
const RESTORE_OFFERED_KEY = (userId) => `hm:restore-offered:${userId}`;

/** A 64-digit recovery key, shown as 16 groups of 4 digits. Uniform: rejection-sampled bytes. */
export function createRecoveryKey(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let digits = '';
  while (digits.length < 64) {
    for (const byte of random(64)) {
      if (byte < 250 && digits.length < 64) digits += String(byte % 10);
    }
  }
  return digits;
}

export const formatRecoveryKey = (key) => key.replace(/\D/g, '').match(/.{1,4}/g)?.join(' ') ?? '';
/** What the person typed, as the secret: a recovery key without its spaces, a password as typed. */
export function normalizeSecret(value, kind) {
  return kind === 'recovery-key' ? String(value ?? '').replace(/\D/g, '') : String(value ?? '');
}

export function validSecret(secret, kind) {
  return kind === 'recovery-key' ? /^\d{64}$/.test(secret) : typeof secret === 'string' && secret.length >= MIN_PASSWORD_LENGTH;
}

export async function backupSettings(userId) {
  return (await secureGet(SETTINGS_KEY(userId)).catch(() => null)) ?? null;
}

/** Turns account backup on (or changes its secret / frequency). */
export async function saveBackupSettings(userId, { secret, kind, frequency }) {
  if (!validSecret(secret, kind)) throw new Error(kind === 'recovery-key' ? 'The recovery key has 64 digits.' : `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  const previous = await backupSettings(userId);
  await secureSet(SETTINGS_KEY(userId), { secret, kind, frequency: frequency in FREQUENCIES ? frequency : 'daily', lastAt: previous?.lastAt ?? 0 });
}

export async function turnOffBackups(userId, token) {
  await secureDel(SETTINGS_KEY(userId));
  if (token) await apiFetch('/api/v1/backup', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

export async function backupInfo(token) {
  const response = await apiFetch('/api/v1/backup', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Could not check your backup.');
  return response.json();
}

/** Seals everything saved on this device and uploads it; returns the server's { byteSize, updatedAt }. */
export async function backUpNow(token, { onStage } = {}) {
  const state = useChatStore.getState();
  const settings = await backupSettings(state.userId);
  if (!settings) throw new Error('Turn on backups first.');
  onStage?.('Collecting your chats…');
  const data = buildBackupData({
    user: state.user,
    chats: state.chats,
    messages: await loadAllSavedMessages(state.userId),
    callLogs: state.callLogs,
    preferences: { pinnedChatIds: state.pinnedChatIds, mutedChatIds: state.mutedChatIds, favouriteChatIds: state.favouriteChatIds, chatThemes: state.chatThemes, blockedChats: state.blockedChats },
    groups: [],
  });
  onStage?.('Encrypting…');
  const text = await sealBackup(data, settings.secret);
  onStage?.('Uploading…');
  const response = await apiFetch('/api/v1/backup', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Backup-Kdf': settings.kind },
    body: new Blob([text], { type: 'application/octet-stream' }),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'The backup could not be uploaded.');
  const saved = await response.json();
  await secureSet(SETTINGS_KEY(state.userId), { ...settings, lastAt: saved.updatedAt ?? Date.now() });
  return saved;
}

/** Runs a backup when one is due (daily / weekly). Quiet: a failure waits for the next try. */
export async function runScheduledBackup(token, now = Date.now()) {
  const userId = useChatStore.getState().userId;
  if (!userId || !token) return false;
  const settings = await backupSettings(userId);
  const every = FREQUENCIES[settings?.frequency] ?? 0;
  if (!settings || !every || now - (settings.lastAt ?? 0) < every) return false;
  try {
    await backUpNow(token);
    return true;
  } catch {
    return false;
  }
}

/** Downloads the account's backup and adds what it holds to this device (nothing here is overwritten). */
export async function restoreFromAccountBackup(token, typed, kind) {
  const response = await apiFetch('/api/v1/backup/file', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(response.status === 404 ? 'No backup has been made for this account.' : 'The backup could not be downloaded.');
  const secret = normalizeSecret(typed, kind);
  const state = useChatStore.getState();
  const data = validateBackupData(await openBackup(await response.text(), secret), state.userId);
  const result = state.restoreBackup(data);
  // The same secret keeps future backups going on this device.
  await saveBackupSettings(state.userId, { secret, kind, frequency: (await backupSettings(state.userId))?.frequency ?? 'daily' });
  return { ...result, createdAt: data.createdAt };
}

/** Whether to offer "Restore from backup" now: a backup exists and this device has no chats of its own yet. */
export async function shouldOfferRestore(token, userId, localMessageCount) {
  if (!token || !userId || localMessageCount > 0) return null;
  try {
    if (localStorage.getItem(RESTORE_OFFERED_KEY(userId)) === '1') return null;
  } catch { /* private mode */ }
  const info = await backupInfo(token).catch(() => null);
  return info?.exists ? info : null;
}

export function markRestoreOffered(userId) {
  try { localStorage.setItem(RESTORE_OFFERED_KEY(userId), '1'); } catch { /* private mode */ }
}

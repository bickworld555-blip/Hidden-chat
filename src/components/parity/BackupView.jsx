// Chat backup (encrypted with a password only you know), restore, and exporting one chat as text.
import { useState } from 'react';
import { DatabaseBackup, Download, FileText, Upload } from 'lucide-react';
import { useChatStore, previewFor } from '../../store.js';
import { apiFetch } from '../../api.js';
import { MIN_PASSWORD_LENGTH, buildBackupData, exportChatText, openBackup, sealBackup, validateBackupData } from '../../backup.js';
import { saveFile } from '../../fileSave.js';
import { openGroupMessages } from '../../e2e/client.js';
import Panel, { Notice } from './Panel.jsx';

const LAST_BACKUP_KEY = 'hm:last-backup-at';

async function fetchJson(token, path) {
  const response = await apiFetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Could not load your groups for the backup.');
  return response.json();
}

// Groups live on the server; the backup keeps a copy of their recent history (up to 500 messages each).
async function groupSnapshots(token) {
  const groups = await fetchJson(token, '/api/v1/groups');
  const snapshots = [];
  for (const group of groups) {
    const sealed = await fetchJson(token, `/api/v1/groups/${encodeURIComponent(group.id)}/messages`).catch(() => []);
    // The backup holds what this device can read (it is itself encrypted with the backup password).
    const messages = await openGroupMessages(group.id, sealed);
    snapshots.push({ id: group.id, name: group.name, messages });
  }
  return snapshots;
}

export default function BackupView({ token, onClose }) {
  const [mode, setMode] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastBackup, setLastBackup] = useState(() => Number(localStorage.getItem(LAST_BACKUP_KEY) || 0));
  const chats = useChatStore((state) => state.chats);
  const userId = useChatStore((state) => state.userId);

  const reset = () => { setMode(null); setPassword(''); setConfirm(''); setFile(null); setError(''); };

  async function backUp(event) {
    event.preventDefault();
    if (password !== confirm) { setError('The passwords don’t match.'); return; }
    setBusy(true);
    setError('');
    try {
      const state = useChatStore.getState();
      const data = buildBackupData({
        user: state.user,
        chats: state.chats,
        messages: state.messages,
        callLogs: state.callLogs,
        preferences: { pinnedChatIds: state.pinnedChatIds, mutedChatIds: state.mutedChatIds, favouriteChatIds: state.favouriteChatIds, chatThemes: state.chatThemes, blockedChats: state.blockedChats },
        groups: await groupSnapshots(token),
      });
      const text = await sealBackup(data, password);
      const date = new Date().toISOString().slice(0, 10);
      const saved = await saveFile(new Blob([text], { type: 'application/json' }), `hidden-messenger-backup-${state.user?.username ?? 'account'}-${date}.hmbackup`, 'application/octet-stream');
      const at = Date.now();
      localStorage.setItem(LAST_BACKUP_KEY, String(at));
      setLastBackup(at);
      reset();
      setNotice(saved.path ? `Backup saved to ${saved.path}. Keep your password: without it the backup can’t be opened.` : 'Backup downloaded. Keep your password: without it the backup can’t be opened.');
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = validateBackupData(await openBackup(await file.text(), password), userId);
      const { addedChats, addedMessages } = useChatStore.getState().restoreBackup(data);
      reset();
      setNotice(`Restored ${addedMessages} message${addedMessages === 1 ? '' : 's'}${addedChats ? ` and ${addedChats} chat${addedChats === 1 ? '' : 's'}` : ''} from ${new Date(data.createdAt).toLocaleString()}.`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function exportChat(chat) {
    const state = useChatStore.getState();
    const names = { [state.userId]: 'You', [chat.id]: chat.name ?? chat.username ?? 'Contact' };
    const text = exportChatText({ title: chat.name ?? chat.username, messages: state.messages[chat.id] ?? [], nameFor: (id) => names[id] ?? 'Unknown', describe: previewFor });
    try {
      const saved = await saveFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), `Hidden Messenger chat with ${chat.name ?? chat.username}.txt`, 'text/plain');
      setNotice(saved.path ? `Chat exported to ${saved.path}.` : 'Chat exported.');
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <Panel title={mode === 'backup' ? 'Back up chats' : mode === 'restore' ? 'Restore chats' : mode === 'export' ? 'Export chat' : 'Chat backup'} onClose={onClose} onBack={mode ? reset : undefined}>
      <Notice error={error} notice={notice} />
      {!mode && (
        <>
          <div className="hm-backup-summary">
            <DatabaseBackup size={40} aria-hidden="true" />
            <p>Back up your chats, call history and chat settings to an encrypted file. Only your password can open it — Hidden Messenger can’t, and can’t recover it.</p>
            <small>{lastBackup ? `Last backup: ${new Date(lastBackup).toLocaleString()}` : 'No backup made on this device yet.'}</small>
          </div>
          <ul className="hm-menu-list">
            <li><button type="button" onClick={() => setMode('backup')}><Download size={22} aria-hidden="true" /><span><strong>Back up now</strong><small>Make an end-to-end encrypted backup file</small></span></button></li>
            <li><button type="button" onClick={() => setMode('restore')}><Upload size={22} aria-hidden="true" /><span><strong>Restore from a backup</strong><small>Adds missing messages; nothing on this device is overwritten</small></span></button></li>
            <li><button type="button" onClick={() => setMode('export')}><FileText size={22} aria-hidden="true" /><span><strong>Export a chat</strong><small>A readable .txt copy of one conversation</small></span></button></li>
          </ul>
        </>
      )}
      {mode === 'backup' && (
        <form className="hm-form" onSubmit={backUp}>
          <label>Backup password<input type="password" autoComplete="new-password" value={password} minLength={MIN_PASSWORD_LENGTH} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
          <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label>
          <p className="hm-muted">At least {MIN_PASSWORD_LENGTH} characters. Group chats are included as a copy of their recent history; they stay on the server and aren’t changed by a restore.</p>
          <button type="submit" className="groups-primary" disabled={busy || password.length < MIN_PASSWORD_LENGTH || !confirm}>{busy ? 'Encrypting…' : 'Create backup'}</button>
        </form>
      )}
      {mode === 'restore' && (
        <form className="hm-form" onSubmit={restore}>
          <label>Backup file<input type="file" accept=".hmbackup,application/json,application/octet-stream" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label>
          <label>Backup password<input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <button type="submit" className="groups-primary" disabled={busy || !file || !password}>{busy ? 'Restoring…' : 'Restore'}</button>
        </form>
      )}
      {mode === 'export' && (
        <ul className="hm-catalog-list">
          {chats.filter((chat) => chat.id !== userId).map((chat) => (
            <li key={chat.id}>
              <span><strong>{chat.name ?? chat.username}</strong><small>{(useChatStore.getState().messages[chat.id] ?? []).length} messages</small></span>
              <button type="button" onClick={() => exportChat(chat)} aria-label={`Export chat with ${chat.name ?? chat.username}`}><FileText size={16} /> Export</button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

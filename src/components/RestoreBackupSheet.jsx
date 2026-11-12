// Shown once on a device with no chats of its own when the account has a backup (a new or reset phone): restore
// first, like WhatsApp. Skipping says plainly that earlier chats then stay off this phone.
import { useState } from 'react';
import { DatabaseBackup } from 'lucide-react';
import { markRestoreOffered, restoreFromAccountBackup } from '../cloudBackup.js';

export default function RestoreBackupSheet({ token, userId, info, onDone }) {
  const [kind, setKind] = useState(info?.kdf === 'password' ? 'password' : 'recovery-key');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skipping, setSkipping] = useState(false);

  const finish = (result) => { markRestoreOffered(userId); onDone?.(result); };

  async function restore(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      finish(await restoreFromAccountBackup(token, secret, kind));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="permissions-overlay" role="dialog" aria-modal="true" aria-labelledby="restore-title">
      <form className="permissions-sheet" onSubmit={restore}>
        <DatabaseBackup size={40} className="permissions-hero" aria-hidden="true" />
        <h2 id="restore-title">Restore your chats</h2>
        <p className="permissions-copy">
          A backup of this account was made {info?.updatedAt ? new Date(info.updatedAt).toLocaleString() : 'earlier'}. Restore it now to bring your chats to this device.
        </p>
        <div className="hm-seg" role="radiogroup" aria-label="The backup is protected with">
          <button type="button" role="radio" aria-checked={kind === 'recovery-key'} className={kind === 'recovery-key' ? 'is-active' : ''} onClick={() => setKind('recovery-key')}>64-digit key</button>
          <button type="button" role="radio" aria-checked={kind === 'password'} className={kind === 'password' ? 'is-active' : ''} onClick={() => setKind('password')}>Password</button>
        </div>
        <label className="restore-field">{kind === 'recovery-key' ? '64-digit key' : 'Backup password'}
          <input type={kind === 'password' ? 'password' : 'text'} inputMode={kind === 'recovery-key' ? 'numeric' : undefined} autoComplete="off"
            value={secret} onChange={(event) => setSecret(event.target.value)} required autoFocus />
        </label>
        {error && <p className="hm-error" role="alert">{error}</p>}
        {skipping && <p className="hm-error" role="alert">Without restoring, your earlier chats can’t be brought back to this device later from here. You can still restore from Tools › Chat backup.</p>}
        <div className="permissions-actions">
          <button type="button" className="permissions-secondary" disabled={busy} onClick={() => (skipping ? finish(null) : setSkipping(true))}>{skipping ? 'Skip anyway' : 'Skip'}</button>
          <button type="submit" className="permissions-primary" disabled={busy || !secret}>{busy ? 'Restoring…' : 'Restore'}</button>
        </div>
      </form>
    </div>
  );
}

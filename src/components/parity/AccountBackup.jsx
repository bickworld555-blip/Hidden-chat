// "Back up to your account": the whole local history, end-to-end encrypted on this device with a password or a
// 64-digit recovery key, uploaded daily or weekly (src/cloudBackup.js). The server keeps messages only until every
// device has them, so without a backup a lost phone means lost chats; this screen says so plainly.
import { useEffect, useState } from 'react';
import { Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useChatStore } from '../../store.js';
import { MIN_PASSWORD_LENGTH } from '../../backup.js';
import { backUpNow, backupInfo, backupSettings, createRecoveryKey, formatRecoveryKey, saveBackupSettings, turnOffBackups } from '../../cloudBackup.js';

const sizeLabel = (bytes) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function AccountBackup({ token }) {
  const userId = useChatStore((state) => state.userId);
  const [settings, setSettings] = useState(undefined);
  const [info, setInfo] = useState(null);
  const [setup, setSetup] = useState(false);
  const [kind, setKind] = useState('recovery-key');
  const [password, setPassword] = useState('');
  const [key] = useState(() => createRecoveryKey());
  const [keySaved, setKeySaved] = useState(false);
  const [frequency, setFrequency] = useState('daily');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    backupSettings(userId).then((value) => { if (live) { setSettings(value); if (value?.frequency) setFrequency(value.frequency); } });
    backupInfo(token).then((value) => { if (live) setInfo(value); }).catch(() => {});
    return () => { live = false; };
  }, [userId, token]);

  async function run(label, action) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  }

  const turnOn = (event) => {
    event.preventDefault();
    run('Backing up…', async () => {
      await saveBackupSettings(userId, { secret: kind === 'recovery-key' ? key : password, kind, frequency });
      setSettings(await backupSettings(userId));
      const saved = await backUpNow(token, { onStage: setBusy });
      setInfo({ exists: true, ...saved });
      setSetup(false);
      setPassword('');
      setNotice('Backup turned on and your chats are backed up.');
    });
  };

  const changeFrequency = (value) => run('Saving…', async () => {
    setFrequency(value);
    await saveBackupSettings(userId, { ...settings, frequency: value });
    setSettings(await backupSettings(userId));
  });

  return (
    <section className="hm-account-backup" aria-label="Back up to your account">
      <div className="hm-backup-warning" role="note">
        <ShieldAlert size={22} aria-hidden="true" />
        <p><strong>Your chats are kept only on your devices.</strong> The server deletes each message once your devices have it. If you lose this phone without a backup, your chats can’t be brought back.</p>
      </div>
      {error && <p className="hm-error" role="alert">{error}</p>}
      {notice && <p className="hm-notice" role="status">{notice}</p>}
      {settings && !setup ? (
        <>
          <p className="hm-muted">
            Account backup is on ({settings.kind === 'recovery-key' ? '64-digit key' : 'password'}).
            {info?.exists ? ` Last backup ${new Date(info.updatedAt).toLocaleString()}, ${sizeLabel(info.byteSize)}.` : ' No backup uploaded yet.'}
          </p>
          <label className="hm-inline-field">Back up
            <select value={frequency} onChange={(event) => changeFrequency(event.target.value)} disabled={Boolean(busy)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="off">Only when I tap Back up</option>
            </select>
          </label>
          <div className="hm-actions-row">
            <button type="button" className="groups-primary" disabled={Boolean(busy)} onClick={() => run('Backing up…', async () => { const saved = await backUpNow(token, { onStage: setBusy }); setInfo({ exists: true, ...saved }); setNotice('Backed up.'); })}>{busy || 'Back up now'}</button>
            <button type="button" className="groups-secondary" disabled={Boolean(busy)} onClick={() => run('Turning off…', async () => { await turnOffBackups(userId, token); setSettings(null); setInfo({ exists: false }); setNotice('Account backup is off and the backup was deleted.'); })}>Turn off</button>
          </div>
        </>
      ) : !setup ? (
        <button type="button" className="groups-primary" onClick={() => setSetup(true)}>Turn on account backup</button>
      ) : (
        <form className="hm-form" onSubmit={turnOn}>
          <div className="hm-seg" role="radiogroup" aria-label="Protect the backup with">
            <button type="button" role="radio" aria-checked={kind === 'recovery-key'} className={kind === 'recovery-key' ? 'is-active' : ''} onClick={() => setKind('recovery-key')}>64-digit key</button>
            <button type="button" role="radio" aria-checked={kind === 'password'} className={kind === 'password' ? 'is-active' : ''} onClick={() => setKind('password')}>Password</button>
          </div>
          {kind === 'recovery-key' ? (
            <>
              <p className="hm-muted">Write this key down or keep it in a password manager. Hidden Messenger can’t see it or recover it.</p>
              <code className="hm-recovery-key" aria-label="Your recovery key">{formatRecoveryKey(key)}</code>
              <button type="button" className="groups-secondary" onClick={() => navigator.clipboard?.writeText(formatRecoveryKey(key)).catch(() => {})}><Copy size={16} aria-hidden="true" /> Copy key</button>
              <label className="hm-check"><input type="checkbox" checked={keySaved} onChange={(event) => setKeySaved(event.target.checked)} /> I saved my 64-digit key</label>
            </>
          ) : (
            <label>Backup password<input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          )}
          <label className="hm-inline-field">Back up
            <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="off">Only when I tap Back up</option>
            </select>
          </label>
          <button type="submit" className="groups-primary" disabled={Boolean(busy) || (kind === 'recovery-key' ? !keySaved : password.length < MIN_PASSWORD_LENGTH)}>
            <KeyRound size={16} aria-hidden="true" /> {busy || 'Turn on and back up'}
          </button>
        </form>
      )}
    </section>
  );
}

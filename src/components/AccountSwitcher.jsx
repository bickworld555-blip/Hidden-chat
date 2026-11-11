import { useEffect } from 'react';
import { Check, LogOut, Plus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { MAX_ACCOUNTS, useAccounts } from '../accounts.js';

// Bottom sheet listing every signed-in account on this device (opened from the profile row in Settings): tap to
// switch, sign one out, or add another. Each account keeps its own chats and settings.
export default function AccountSwitcher({ onSwitch, onRemove, onAdd, onClose, busyId = null }) {
  const { accounts, activeId } = useAccounts();

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="profile-photo-backdrop" onClick={onClose} role="presentation">
      <div className="profile-photo-sheet account-sheet" role="dialog" aria-modal="true" aria-label="Accounts" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="account-sheet-handle" onClick={onClose} aria-label="Close accounts"><span /></button>
        <p className="account-sheet-intro">Switch between the accounts on this phone. Each one keeps its own chats, contacts and settings.</p>
        <ul className="account-list">
          {accounts.map((account) => {
            const active = account.id === activeId;
            return (
              <li key={account.id} className={active ? 'is-active' : ''}>
                <button type="button" className="account-row" onClick={() => !active && onSwitch(account.id)} disabled={busyId === account.id} aria-current={active ? 'true' : undefined}>
                  <Avatar {...account.user} size="small" />
                  <span className="account-row-text">
                    <strong>{account.user?.name || `@${account.user?.username}`}</strong>
                    <small>{account.user?.name && account.user.name !== `@${account.user?.username}` ? `@${account.user?.username}` : (active ? 'Active' : 'Tap to switch')}{account.user?.name && account.user.name !== `@${account.user?.username}` && active ? ' · Active' : ''}{busyId === account.id ? ' · Switching…' : ''}</small>
                  </span>
                  <span className={`account-radio${active ? ' is-on' : ''}`} aria-label={active ? 'Active account' : undefined}>{active && <Check size={13} strokeWidth={3} />}</span>
                </button>
                <button type="button" className="icon-button account-remove" onClick={() => onRemove(account.id)} aria-label={`Sign out ${account.user?.username}`} title={active ? 'Log out' : 'Remove from this device'}><LogOut size={16} /></button>
              </li>
            );
          })}
        </ul>
        {accounts.length < MAX_ACCOUNTS
          ? <button type="button" className="account-add" onClick={onAdd}><Plus size={18} /> Add account</button>
          : <p className="profile-photo-status">Up to {MAX_ACCOUNTS} accounts can be signed in on this device.</p>}
      </div>
    </div>
  );
}

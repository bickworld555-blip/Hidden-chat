import { useEffect } from 'react';
import { Check, LogOut, Plus, X } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { MAX_ACCOUNTS, useAccounts } from '../accounts.js';

// Sheet listing every signed-in account on this device; tap to switch, remove, or add another.
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
        <header>
          <strong>Accounts</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <ul className="account-list">
          {accounts.map((account) => {
            const active = account.id === activeId;
            return (
              <li key={account.id} className={active ? 'is-active' : ''}>
                <button type="button" className="account-row" onClick={() => !active && onSwitch(account.id)} disabled={busyId === account.id} aria-current={active ? 'true' : undefined}>
                  <Avatar {...account.user} size="small" />
                  <span className="account-row-text">
                    <strong>{account.user?.name ?? account.user?.username}</strong>
                    <small>@{account.user?.username}{active ? ' · Active' : ''}{busyId === account.id ? ' · Switching…' : ''}</small>
                  </span>
                  {active && <Check size={18} className="account-check" aria-label="Active account" />}
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

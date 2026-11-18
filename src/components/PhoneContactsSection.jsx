import { useEffect, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { nativeInviteSms, nativeShell } from '../native.js';
import { shareText } from '../share.js';
import { useChatStore } from '../store.js';
import { inviteText, syncDeviceContacts } from '../deviceContacts.js';
import Avatar from './Avatar.jsx';

// The phone's contacts in the contact picker (src/deviceContacts.js). Android app only. Nothing is read until the person
// taps Sync once; after that the list refreshes when the picker opens (at most every SYNC_REFRESH_MS). Only Hidden
// Messenger IDs found in the phonebook are sent to the server.
//
// The picker owns the people: matches who are on Hidden Messenger join its one contact list (contactBook.js
// unifiedContacts), so nobody is listed twice; this module keeps the sync, its button, and the invite list.
const SYNC_REFRESH_MS = 10 * 60 * 1000;
let lastSync = null; // { at, result }: kept while the app runs, so reopening the picker is instant

/** { available, granted, registered, invite, status, error, sync(ask) } for the picker. */
export function usePhoneContacts() {
  const sessionToken = useChatStore((state) => state.sessionToken);
  const [result, setResult] = useState(() => lastSync?.result ?? null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const sync = async (ask) => {
    setStatus('syncing');
    setError('');
    try {
      const next = await syncDeviceContacts({ sessionToken, ask });
      if (next.permission === 'granted') lastSync = { at: Date.now(), result: next };
      setResult(next);
      setStatus('done');
    } catch (failure) {
      setError(failure.message || 'Could not sync your contacts.');
      setStatus('idle');
    }
  };

  useEffect(() => {
    if (!nativeShell() || !sessionToken) return;
    if (lastSync && Date.now() - lastSync.at < SYNC_REFRESH_MS) return;
    sync(false);
  }, [sessionToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = nativeShell() && result?.supported !== false;
  const granted = available && result?.permission === 'granted';
  return {
    available,
    granted,
    permission: result?.permission ?? null,
    registered: granted ? result?.registered ?? [] : [],
    invite: granted ? result?.invite ?? [] : [],
    status,
    error,
    sync,
  };
}

/** Before the first sync: the button that asks for the contacts permission. Errors show here too. */
export function PhoneSyncRow({ phone }) {
  if (!phone.available) return null;
  return (
    <section className="wa-sc-phone" aria-label="Phone contacts">
      {!phone.granted && (
        <button type="button" className="wa-sc-action-row" onClick={() => phone.sync(true)} disabled={phone.status === 'syncing'}>
          <div className="wa-sc-action-icon green"><RefreshCw size={22} /></div>
          <div className="wa-sc-action-label">
            <strong>{phone.status === 'syncing' ? 'Syncing…' : 'Sync phone contacts'}</strong>
            <small>{phone.permission === 'denied' ? 'Contacts permission is off. Allow it in Settings › Apps.' : 'Find friends who saved their Hidden Messenger ID in your contacts. Only IDs are checked; names and numbers stay on this phone.'}</small>
          </div>
        </button>
      )}
      {phone.error && <div className="wa-sc-error-msg" role="alert">{phone.error}</div>}
    </section>
  );
}

/** Phone contacts who are not on Hidden Messenger, at the bottom of the picker, each with Invite. */
export function PhoneInviteSection({ phone, query = '' }) {
  const myNumber = useChatStore((state) => state.user?.number ?? '');
  const needle = query.trim().toLowerCase();
  const invite = phone.invite.filter((item) => !needle || `${item.name} ${item.phone}`.toLowerCase().includes(needle));
  if (!invite.length) return null;

  const invitePerson = async (item) => {
    const text = inviteText({ number: myNumber });
    if (await nativeInviteSms(item.phone, text)) return;
    try { await shareText({ text }); } catch { /* nothing to share with here */ }
  };

  return (
    <section className="wa-sc-phone" aria-label="Invite to Hidden Messenger">
      <div className="wa-sc-section-heading"><span>Invite to Hidden Messenger</span></div>
      <div className="wa-sc-contacts-list">
        {invite.map((item) => (
          <div key={item.key} className="wa-sc-contact-item wa-sc-phone-row">
            <Avatar name={item.name} initials={item.name.slice(0, 2).toUpperCase()} color="gray" />
            <div className="wa-sc-contact-info">
              <strong className="wa-sc-contact-name">{item.name}</strong>
              {item.phone !== item.name && <span className="wa-sc-contact-status">{item.phone}</span>}
            </div>
            <button type="button" className="wa-sc-invite-btn" onClick={() => invitePerson(item)}><Send size={14} /> Invite</button>
          </div>
        ))}
      </div>
    </section>
  );
}

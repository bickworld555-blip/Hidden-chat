import { useEffect, useState } from 'react';
import { MessageCircle, Phone, RefreshCw, Send, Video } from 'lucide-react';
import { nativeInviteSms, nativeShell } from '../native.js';
import { useChatStore } from '../store.js';
import { useContactNames } from '../useContactNames.js';
import { findPerson } from '../contactNames.js';
import { inviteText, syncDeviceContacts } from '../deviceContacts.js';
import Avatar from './Avatar.jsx';

// "Contacts on Hidden Messenger" from the phone's contacts, then "Invite to Hidden Messenger" (src/deviceContacts.js).
// Android app only. Nothing is read until the person taps Sync once; after that the list refreshes when the picker
// opens (at most every SYNC_REFRESH_MS). Only Hidden Messenger IDs found in the phonebook are sent to the server.
const SYNC_REFRESH_MS = 10 * 60 * 1000;
let lastSync = null; // { at, result }: kept while the app runs, so reopening the picker is instant

export default function PhoneContactsSection({ query = '', busyId = '', onChat, onCall }) {
  const sessionToken = useChatStore((state) => state.sessionToken);
  const myNumber = useChatStore((state) => state.user?.number ?? '');
  useContactNames(); // re-render when a saved name changes
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

  if (!nativeShell() || result?.supported === false) return null;
  const needle = query.trim().toLowerCase();
  const matches = (name, extra = '') => !needle || `${name} ${extra}`.toLowerCase().includes(needle);
  const registered = (result?.registered ?? []).filter((item) => matches(item.name, item.user.username));
  const invite = (result?.invite ?? []).filter((item) => matches(item.name, item.phone));
  const granted = result?.permission === 'granted';

  const invitePerson = async (item) => {
    const text = inviteText({ number: myNumber });
    if (await nativeInviteSms(item.phone, text)) return;
    try { await navigator.share?.({ text }); } catch {}
  };

  return (
    <section className="wa-sc-phone" aria-label="Phone contacts">
      {!granted && (
        <button type="button" className="wa-sc-action-row" onClick={() => sync(true)} disabled={status === 'syncing'}>
          <div className="wa-sc-action-icon green"><RefreshCw size={22} /></div>
          <div className="wa-sc-action-label">
            <strong>{status === 'syncing' ? 'Syncing…' : 'Sync phone contacts'}</strong>
            <small>{result?.permission === 'denied' ? 'Contacts permission is off. Allow it in Settings › Apps.' : 'Find friends who saved their Hidden Messenger ID in your contacts. Only IDs are checked; names and numbers stay on this phone.'}</small>
          </div>
        </button>
      )}
      {error && <div className="wa-sc-error-msg" role="alert">{error}</div>}
      {granted && (
        <>
          <div className="wa-sc-section-heading">
            <span>From your phone · on Hidden Messenger</span>
            <button type="button" className="wa-sc-icon-btn" onClick={() => sync(false)} disabled={status === 'syncing'} aria-label="Sync phone contacts again"><RefreshCw size={16} /></button>
          </div>
          <div className="wa-sc-contacts-list">
            {registered.map(({ key, name, user }) => {
              // A name saved in the app wins; otherwise the phonebook name (src/contactNames.js).
              const saved = findPerson(user.id, useChatStore.getState())?.alias;
              const shown = saved || name;
              const person = { ...user, phonebookName: name };
              return (
                <div key={key} className="wa-sc-contact-item wa-sc-phone-row">
                  <Avatar name={shown} initials={user.initials ?? shown.slice(0, 2).toUpperCase()} color={user.color} image={user.avatar} />
                  <div className="wa-sc-contact-info">
                    <strong className="wa-sc-contact-name">{shown}</strong>
                    <span className="wa-sc-contact-status">{user.username ? `@${user.username}` : ''}</span>
                  </div>
                  <button type="button" className="wa-sc-icon-btn" onClick={() => onChat(person)} disabled={busyId === user.id} aria-label={`Message ${shown}`}><MessageCircle size={20} /></button>
                  {onCall && <button type="button" className="wa-sc-icon-btn" onClick={() => onCall(person, 'audio')} disabled={busyId === user.id} aria-label={`Voice call ${shown}`}><Phone size={20} /></button>}
                  {onCall && <button type="button" className="wa-sc-icon-btn" onClick={() => onCall(person, 'video')} disabled={busyId === user.id} aria-label={`Video call ${shown}`}><Video size={20} /></button>}
                </div>
              );
            })}
            {registered.length === 0 && status !== 'syncing' && (
              <div className="wa-sc-empty-state"><p>{needle ? 'No phone contacts match.' : 'None of your phone contacts has a Hidden Messenger ID saved yet. Invite them below, or share your ID.'}</p></div>
            )}
          </div>
          {invite.length > 0 && (
            <>
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
            </>
          )}
        </>
      )}
    </section>
  );
}

// Invite a friend: on the phone, pick someone from the address book (read on the device, never uploaded) and
// text them an invite; anywhere else, share or copy the invite. Native side: android Invites.java.
import { useEffect, useMemo, useState } from 'react';
import { Copy, MessageSquare, Search, Share2, UserPlus } from 'lucide-react';
import { nativeListContacts, nativeOpenSmsComposer, nativeRequestInvitePermissions, nativeSendInviteSms, nativeShell } from '../../native.js';
import Panel, { Notice } from './Panel.jsx';

export const INVITE_URL = 'https://hiddenmessenger.com/download';
export const inviteText = (username) =>
  `Join me on Hidden Messenger, a private messenger with no phone number or email needed.${username ? ` Find me as @${username}.` : ''} Get it here: ${INVITE_URL}`;

export default function InviteFriend({ username, onClose }) {
  const native = nativeShell();
  const text = inviteText(username);
  const [contacts, setContacts] = useState(null);
  const [allowed, setAllowed] = useState(true);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const result = await nativeListContacts();
    setAllowed(Boolean(result?.allowed));
    setContacts(result?.contacts ?? []);
  };
  useEffect(() => { if (native) load(); }, [native]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (contacts ?? []).filter((person) => !needle || person.name.toLowerCase().includes(needle) || person.numbers.some((number) => number.includes(needle)));
  }, [contacts, query]);

  async function share() {
    setError('');
    try {
      if (navigator.share) await navigator.share({ title: 'Hidden Messenger', text });
      else { await navigator.clipboard.writeText(text); setNotice('Invite copied. Paste it into any chat or email.'); }
    } catch (caught) {
      if (caught?.name !== 'AbortError') setError('Sharing isn’t available here. Copy the invite instead.');
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice('Invite copied.'); } catch { setError('Copying isn’t allowed here.'); }
  }
  async function send(number) {
    setBusy(true);
    setError('');
    const sent = await nativeSendInviteSms(number, text);
    setBusy(false);
    if (sent?.sent) { setNotice(`Invite sent to ${picked.name}.`); setPicked(null); return; }
    // Without the SMS permission (Android keeps it from apps installed outside the Play Store), the phone's
    // messages app opens with the number and the invite filled in; the person taps send there.
    const opened = await nativeOpenSmsComposer(number, text);
    if (opened?.opened) setNotice(`Your messages app opened with the invite for ${picked.name}. Tap send there.`);
    else window.location.href = `sms:${encodeURIComponent(number)}?body=${encodeURIComponent(text)}`;
    setPicked(null);
  }

  return (
    <Panel title="Invite a friend" onClose={onClose} onBack={picked ? () => setPicked(null) : undefined}>
      <Notice error={error} notice={notice} />
      {picked ? (
        <div className="invite-confirm">
          <h3>Invite {picked.name}</h3>
          <p className="invite-preview">{text}</p>
          <p className="hm-muted">Sent as a regular text message from your phone (your carrier may charge for it). If Android doesn’t allow this app to send texts, your messages app opens with the invite ready to send.</p>
          {picked.numbers.map((number) => (
            <button key={number} type="button" className="invite-button" disabled={busy} onClick={() => send(number)}>
              <MessageSquare size={16} /> Text {number}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="invite-actions">
            <button type="button" className="tool-item" onClick={share}><Share2 size={20} /><div className="tool-item-info"><strong>Share link</strong><small>Send the invite in any app</small></div></button>
            <button type="button" className="tool-item" onClick={copy}><Copy size={20} /><div className="tool-item-info"><strong>Copy invite</strong><small>{INVITE_URL}</small></div></button>
          </div>
          {native && (
            <>
              <h3 className="hm-section">From your contacts</h3>
              {!allowed ? (
                <div className="invite-empty">
                  <UserPlus size={28} aria-hidden="true" />
                  <p>Allow access to your contacts to pick someone to invite. Your contacts stay on this phone.</p>
                  <button type="button" className="invite-button" onClick={async () => { await nativeRequestInvitePermissions(); load(); }}>Allow contacts</button>
                </div>
              ) : (
                <>
                  <label className="invite-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contacts" aria-label="Search contacts" /></label>
                  {contacts === null && <p className="hm-muted">Loading contacts…</p>}
                  {contacts?.length === 0 && <p className="hm-muted">No contacts with a phone number on this phone.</p>}
                  <ul className="invite-list">
                    {shown.slice(0, 300).map((person) => (
                      <li key={person.id}>
                        <button type="button" onClick={() => { setNotice(''); setPicked(person); }}>
                          <span className="invite-avatar" aria-hidden="true">{person.name.slice(0, 1).toUpperCase()}</span>
                          <span><strong>{person.name}</strong><small>{person.numbers[0]}</small></span>
                          <span className="invite-cta">Invite</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

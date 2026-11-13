// Invite a friend: a private invite link shared through the Android share sheet (or copied). No contacts are read
// (the app has no contacts permission). The link is https://<site>/c#<token>: the token is 128 random bits, kept on
// the server only as a hash, after "#" so web servers never see it; it works for 1 person or up to 10, for 7 days,
// and can be revoked here. Opening it links both people as contacts (server: /api/v1/connect/*).
import { useEffect, useState } from 'react';
import { Copy, Link2, Share2, Trash2 } from 'lucide-react';
import { publicOrigin } from '../../api.js';
import { createInviteLink, listInviteLinks, revokeInviteLink } from '../../contactsApi.js';
import Panel, { Notice } from './Panel.jsx';

export const DOWNLOAD_URL = 'https://hiddenmessenger.com/download';
export const inviteLinkUrl = (token) => `${publicOrigin()}/c#${token}`;
export const inviteText = (url) =>
  `Chat with me on Hidden Messenger, a private messenger with no phone number or email. Open my invite: ${url}`;

const expiresIn = (at) => {
  const days = Math.max(0, Math.round((at - Date.now()) / 86_400_000));
  return days >= 1 ? `expires in ${days} day${days === 1 ? '' : 's'}` : 'expires today';
};

export default function InviteFriend({ sessionToken, onClose }) {
  const [uses, setUses] = useState(1);
  const [links, setLinks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = () => listInviteLinks(sessionToken).then(setLinks).catch(() => {});
  useEffect(() => { refresh(); }, [sessionToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new link for each invite, so every one can be revoked on its own.
  async function makeLink() {
    const link = await createInviteLink(sessionToken, { uses });
    refresh();
    return inviteLinkUrl(link.token);
  }

  async function share() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const url = await makeLink();
      const text = inviteText(url);
      if (navigator.share) {
        try { await navigator.share({ title: 'Hidden Messenger', text }); } catch (caught) { if (caught?.name !== 'AbortError') throw caught; }
      } else {
        await navigator.clipboard.writeText(text);
        setNotice('Invite link copied. Paste it into any chat or app.');
      }
    } catch (caught) {
      setError(caught?.message || 'Sharing isn’t available here. Copy the link instead.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setBusy(true);
    setError('');
    try {
      await navigator.clipboard.writeText(inviteText(await makeLink()));
      setNotice('Invite link copied.');
    } catch (caught) {
      setError(caught?.message || 'Copying isn’t allowed here.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    setError('');
    try { await revokeInviteLink(sessionToken, id); setNotice('Link revoked. It no longer works.'); refresh(); } catch (caught) { setError(caught.message); }
  }

  return (
    <Panel title="Invite a friend" onClose={onClose}>
      <Notice error={error} notice={notice} />
      <p className="invite-preview">Share a private invite link. When your friend opens it in Hidden Messenger, you become contacts. No phone number, no email, and the app never reads your contacts.</p>
      <fieldset className="invite-uses">
        <legend>Who can use the link</legend>
        <label><input type="radio" name="invite-uses" checked={uses === 1} onChange={() => setUses(1)} /> One person</label>
        <label><input type="radio" name="invite-uses" checked={uses === 10} onChange={() => setUses(10)} /> Up to 10 people (for a group chat)</label>
      </fieldset>
      <div className="invite-actions">
        <button type="button" className="tool-item" onClick={share} disabled={busy}><Share2 size={20} /><div className="tool-item-info"><strong>Share invite link</strong><small>Send it in any app</small></div></button>
        <button type="button" className="tool-item" onClick={copy} disabled={busy}><Copy size={20} /><div className="tool-item-info"><strong>Copy invite link</strong><small>Works for 7 days</small></div></button>
      </div>
      <p className="hm-muted">Friends without the app can get it at {DOWNLOAD_URL.replace('https://', '')}, sign up, then open your link.</p>
      {links.length > 0 && (
        <>
          <h3 className="hm-section">Active invite links</h3>
          <ul className="invite-links">
            {links.map((link) => (
              <li key={link.id}>
                <Link2 size={18} aria-hidden="true" />
                <span><strong>{link.usesLeft === 1 ? '1 use left' : `${link.usesLeft} uses left`}</strong><small>{expiresIn(link.expiresAt)}</small></span>
                <button type="button" className="icon-button" onClick={() => revoke(link.id)} aria-label="Revoke this invite link"><Trash2 size={18} /></button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

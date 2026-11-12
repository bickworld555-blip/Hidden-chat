// Settings › Privacy › Blocked contacts: everyone this account blocked (the list the server keeps and enforces), with
// Unblock on each, and "Block a contact" to pick someone from the chats.
import { useEffect, useMemo, useState } from 'react';
import { Ban, UserPlus } from 'lucide-react';
import { fetchBlocks } from '../blocksApi.js';
import { useChatStore } from '../store.js';
import Avatar from './Avatar.jsx';

export default function BlockedContacts({ token }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [picking, setPicking] = useState(false);
  const [busyId, setBusyId] = useState('');
  const chats = useChatStore((state) => state.chats);
  const blockChat = useChatStore((state) => state.blockChat);
  const unblockChat = useChatStore((state) => state.unblockChat);

  const load = () => fetchBlocks(token).then((items) => { setList(items); setError(''); }).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const blockedIds = useMemo(() => new Set((list ?? []).map((user) => user.id)), [list]);
  const candidates = chats.filter((chat) => !chat.deleted && !blockedIds.has(chat.id));

  async function change(user, blocked) {
    setBusyId(user.id);
    setError('');
    try {
      await (blocked ? blockChat(user.id) : unblockChat(user.id));
      setNotice(`${user.name || `@${user.username}`} ${blocked ? 'blocked' : 'unblocked'}`);
      setPicking(false);
      await load();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="blocked-contacts">
      <p className="account-hint account-hint-padded">
        Blocked contacts can no longer call you or send you messages, and they won&apos;t see your online status, last seen,
        profile photo or status updates. They are not told.
      </p>
      <button type="button" className="blocked-add" onClick={() => setPicking((open) => !open)} aria-expanded={picking}>
        <UserPlus size={18} aria-hidden="true" /> Block a contact
      </button>
      {picking && (
        <ul className="blocked-list" aria-label="Choose a contact to block">
          {candidates.length === 0 && <li className="blocked-empty">No other chats to choose from.</li>}
          {candidates.map((chat) => (
            <li key={chat.id}>
              <Avatar name={chat.name} initials={chat.initials} color={chat.color} image={chat.avatar} />
              <span className="blocked-name"><strong>{chat.name || `@${chat.username}`}</strong><small>@{chat.username}</small></span>
              <button type="button" className="blocked-action is-block" disabled={busyId === chat.id} onClick={() => change(chat, true)}>Block</button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="account-notice" role="status">{notice}</p>}
      {error && <p className="notif-error account-hint-padded" role="alert">{error}</p>}
      {list === null && !error && <p className="account-hint account-hint-padded">Loading…</p>}
      {list?.length === 0 && (
        <p className="blocked-empty"><Ban size={18} aria-hidden="true" /> You haven&apos;t blocked anyone.</p>
      )}
      {list?.length > 0 && (
        <ul className="blocked-list" aria-label="Blocked contacts">
          {list.map((user) => (
            <li key={user.id}>
              <Avatar name={user.name} initials={user.initials} color={user.color} image={user.avatar} />
              <span className="blocked-name"><strong>{user.name || `@${user.username}`}</strong><small>{user.deleted ? 'Deleted account' : `@${user.username}`}</small></span>
              <button type="button" className="blocked-action" disabled={busyId === user.id} onClick={() => change(user, false)}>Unblock</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

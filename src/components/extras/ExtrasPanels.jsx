// Panels for broadcast lists, channels, scheduled messages, call links and status privacy (server/extras.mjs).
import { useEffect, useMemo, useState } from 'react';
import { Copy, Link2, Lock, Megaphone, Plus, Send, SmilePlus, Trash2, Users } from 'lucide-react';
import Panel, { Notice } from '../parity/Panel.jsx';
import { request } from '../../parityApi.js';
import { useChatStore } from '../../store.js';
import { useWallpaper } from '../../wallpaper.js';
import FormattedText from '../FormattedText.jsx';
import { openContent, sealDirect } from '../../e2e/client.js';
import { publicOrigin } from '../../api.js';
import VerifiedBadge from '../VerifiedBadge.jsx';
import { deviceStorage } from '../../deviceStorage.js';

const CHANNEL_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const directContacts = (chats) => chats.filter((chat) => chat.kind !== 'group' && chat.id && chat.username);

function ContactChecklist({ chats, selected, onChange }) {
  const [query, setQuery] = useState('');
  const shown = chats.filter((chat) => `${chat.name} ${chat.username}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="hm-checklist">
      <input className="hm-input" placeholder="Search contacts" value={query} onChange={(event) => setQuery(event.target.value)} />
      {shown.map((chat) => (
        <label key={chat.id} className="hm-check-row">
          <input type="checkbox" checked={selected.includes(chat.id)} onChange={(event) => onChange(event.target.checked ? [...selected, chat.id] : selected.filter((id) => id !== chat.id))} />
          <span><strong>{chat.name}</strong><small>@{chat.username}</small></span>
        </label>
      ))}
      {!shown.length && <p className="hm-muted">No contacts match.</p>}
    </div>
  );
}

// --- Broadcast lists ---------------------------------------------------------------------------------------
export function BroadcastLists({ token, onClose }) {
  const chats = useChatStore((state) => state.chats);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const contacts = useMemo(() => directContacts(chats), [chats]);
  const [lists, setLists] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => request(token, '/api/v1/broadcasts').then(setLists).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token]);

  async function save() {
    setError('');
    try {
      const body = { name: editing.name, memberIds: editing.memberIds };
      if (editing.id) await request(token, `/api/v1/broadcasts/${editing.id}`, { method: 'PUT', body });
      else await request(token, '/api/v1/broadcasts', { method: 'POST', body });
      setEditing(null);
      await load();
    } catch (caught) { setError(caught.message); }
  }

  // Each recipient gets the message as an ordinary chat message from you, sealed for their devices.
  function broadcast() {
    const message = text.trim();
    if (!message || !open) return;
    const recipients = open.members.filter((member) => member.canReceive);
    for (const member of recipients) sendMessage(member.id, message);
    setText('');
    setNotice(`Sent to ${recipients.length} of ${open.members.length}. ${open.members.length - recipients.length ? 'People who haven’t saved you as a contact don’t receive broadcasts.' : ''}`);
  }

  if (editing) {
    return (
      <Panel title={editing.id ? 'Edit broadcast list' : 'New broadcast list'} onBack={() => setEditing(null)} onClose={onClose}>
        <Notice error={error} />
        <label className="hm-field">List name<input className="hm-input" value={editing.name} maxLength={60} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
        <ContactChecklist chats={contacts} selected={editing.memberIds} onChange={(memberIds) => setEditing({ ...editing, memberIds })} />
        <button type="button" className="hm-primary" disabled={!editing.name.trim() || !editing.memberIds.length} onClick={save}>Save · {editing.memberIds.length} recipients</button>
      </Panel>
    );
  }
  if (open) {
    return (
      <Panel title={open.name} subtitle={`${open.members.length} recipients`} onBack={() => { setOpen(null); setNotice(''); }} onClose={onClose}
        actions={<button type="button" className="icon-button" aria-label="Edit list" onClick={() => setEditing({ id: open.id, name: open.name, memberIds: open.members.map((member) => member.id) })}><Users size={18} /></button>}>
        <Notice error={error} notice={notice} />
        <p className="hm-muted">Recipients get your message as a normal chat from you. Only people who saved you as a contact receive it.</p>
        <ul className="hm-list">
          {open.members.map((member) => <li key={member.id}><strong>{member.name}</strong> <small>@{member.username}{member.canReceive ? '' : ' · hasn’t saved you'}</small></li>)}
        </ul>
        <form className="hm-compose" onSubmit={(event) => { event.preventDefault(); broadcast(); }}>
          <input className="hm-input" value={text} maxLength={4000} placeholder="Broadcast message" onChange={(event) => setText(event.target.value)} />
          <button type="submit" className="icon-button" aria-label="Send broadcast" disabled={!text.trim()}><Send size={18} /></button>
        </form>
      </Panel>
    );
  }
  return (
    <Panel title="Broadcast lists" onClose={onClose}>
      <Notice error={error} />
      <button type="button" className="hm-row-button" onClick={() => setEditing({ name: '', memberIds: [] })}><Plus size={18} /> New broadcast list</button>
      {lists.map((list) => (
        <div key={list.id} className="hm-row">
          <button type="button" className="hm-row-main" onClick={() => setOpen(list)}><Megaphone size={18} /><span><strong>{list.name}</strong><small>{list.members.map((member) => member.name).join(', ')}</small></span></button>
          <button type="button" className="icon-button" aria-label={`Delete ${list.name}`} onClick={() => request(token, `/api/v1/broadcasts/${list.id}`, { method: 'DELETE' }).then(load).catch((caught) => setError(caught.message))}><Trash2 size={16} /></button>
        </div>
      ))}
      {!lists.length && <p className="hm-muted">Send one message to many people at once. Each gets it in their own chat with you.</p>}
    </Panel>
  );
}

// --- Channels ------------------------------------------------------------------------------------------------
/** "1 follower", "950 followers", "1.2K followers", "3.4M followers". */
export function followerCount(count = 0) {
  const n = Number(count) || 0;
  const short = n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/.0$/, '')}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/.0$/, '')}K` : String(n);
  return `${short} follower${n === 1 ? '' : 's'}`;
}

export const CHANNEL_CATEGORY_LABELS = { business: 'Business', news: 'News', entertainment: 'Entertainment', sports: 'Sports', lifestyle: 'Lifestyle', education: 'Education', technology: 'Technology', community: 'Community', other: 'Other' };

// Owner: add admins by @username, remove them. Admin: step down. Admins post and delete updates.
function ChannelAdmins({ token, channel, onBack, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => request(token, `/api/v1/channels/${channel.id}/admins`).then(setData).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [channel.id]);
  async function run(task, done) {
    setError(''); setNotice('');
    try { await task(); setNotice(done); await load(); onChanged?.(); } catch (caught) { setError(caught.message); }
  }
  return (
    <Panel title="Channel admins" subtitle={channel.name} onBack={onBack} onClose={onClose}>
      <Notice error={error} notice={notice} />
      <p className="hm-muted">Admins can post and delete updates. Only the owner can add or remove admins, edit the channel or delete it.</p>
      {data && (
        <ul className="hm-channel-admins">
          <li><span className="hm-channel-avatar" aria-hidden="true">{(data.owner?.name || data.owner?.username || '?').slice(0, 1).toUpperCase()}</span><span><strong>{data.owner?.name || data.owner?.username}</strong><small>@{data.owner?.username} · Owner</small></span></li>
          {data.admins.map((admin) => (
            <li key={admin.id}>
              <span className="hm-channel-avatar" aria-hidden="true">{(admin.name || admin.username).slice(0, 1).toUpperCase()}</span>
              <span><strong>{admin.name || admin.username}</strong><small>@{admin.username} · Admin</small></span>
              {channel.mine && <button type="button" className="groups-secondary" onClick={() => run(() => request(token, `/api/v1/channels/${channel.id}/admins/${admin.id}`, { method: 'DELETE' }), `@${admin.username} is no longer an admin.`)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {channel.mine && (
        <form className="hm-form chat-list-new" onSubmit={(event) => { event.preventDefault(); run(async () => { await request(token, `/api/v1/channels/${channel.id}/admins`, { method: 'POST', body: { username } }); setUsername(''); }, `@${username.replace(/^@/, '')} is now an admin.`); }}>
          <label>Add admin<input value={username} maxLength={40} onChange={(event) => setUsername(event.target.value)} placeholder="@username" autoCapitalize="none" /></label>
          <button type="submit" className="groups-primary" disabled={!username.trim()}>Add</button>
        </form>
      )}
      {channel.role === 'admin' && (
        <button type="button" className="groups-secondary" onClick={() => run(() => request(token, `/api/v1/channels/${channel.id}/admins/${channel.viewerId}`, { method: 'DELETE' }), 'You are no longer an admin.')}>Step down as admin</button>
      )}
    </Panel>
  );
}

// The owner asks for the channel's verified badge (reviewed in the admin console; server/verification.mjs).
function ChannelVerification({ token, channelId }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const path = `/api/v1/channels/${channelId}/verification`;
  useEffect(() => { request(token, path).then(setState).catch(() => setState(null)); }, [token, channelId]);
  const ask = () => request(token, path, { method: 'POST', body: {} }).then(setState).catch((caught) => setError(caught.message));
  if (!state) return null;
  return (
    <div className="hm-channel-verify">
      {state.status === 'pending'
        ? <small>Verification requested · {state.requestId}</small>
        : <button type="button" className="hm-channel-follow is-following" onClick={ask}>{state.status === 'rejected' ? 'Ask for verification again' : 'Request verification'}</button>}
      {state.status === 'rejected' && state.decisionNote && <small>{state.decisionNote}</small>}
      {error && <small className="hm-channel-verify-error">{error}</small>}
    </div>
  );
}

export function Channels({ token, onClose, initialChannelId = '' }) {
  const viewerId = useChatStore((state) => state.userId);
  const [category, setCategory] = useState('');
  const [managingAdmins, setManagingAdmins] = useState(false);
  const wallpaper = useWallpaper();
  const [mine, setMine] = useState([]);
  const [found, setFound] = useState([]);
  const [query, setQuery] = useState('');
  // ':create' opens straight on the new-channel form (Updates › Create channel).
  const [openId, setOpenId] = useState(initialChannelId === ':create' ? '' : initialChannelId);
  const [channel, setChannel] = useState(null);
  const [creating, setCreating] = useState(initialChannelId === ':create' ? { name: '', description: '', category: 'other' } : null);
  const [post, setPost] = useState('');
  // The post whose reaction picker is open (one at a time).
  const [picking, setPicking] = useState(null);
  const [error, setError] = useState('');

  const loadMine = () => request(token, '/api/v1/channels').then(setMine).catch((caught) => setError(caught.message));
  useEffect(() => { loadMine(); }, [token]);
  useEffect(() => {
    const timer = setTimeout(() => request(token, `/api/v1/channels/discover?q=${encodeURIComponent(query)}${category ? `&category=${category}` : ''}`).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [token, query, category]);
  const loadChannel = (id) => request(token, `/api/v1/channels/${id}`).then(setChannel).catch((caught) => setError(caught.message));
  useEffect(() => { if (openId) loadChannel(openId); else setChannel(null); }, [openId, token]);

  async function act(task) {
    setError('');
    try { await task(); } catch (caught) { setError(caught.message); }
  }

  if (creating) {
    return (
      <Panel title="New channel" onBack={() => setCreating(null)} onClose={onClose}>
        <Notice error={error} />
        <p className="hm-muted">Channels are one-way broadcasts anyone can follow. Unlike chats, channel posts are public and not end-to-end encrypted.</p>
        <label className="hm-field">Name<input className="hm-input" maxLength={80} value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} /></label>
        <label className="hm-field">Description<textarea className="hm-input" maxLength={500} value={creating.description} onChange={(event) => setCreating({ ...creating, description: event.target.value })} /></label>
        <label className="hm-field">Category<select className="hm-input" value={creating.category ?? 'other'} onChange={(event) => setCreating({ ...creating, category: event.target.value })}>
          {Object.entries(CHANNEL_CATEGORY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <button type="button" className="hm-primary" disabled={!creating.name.trim()} onClick={() => act(async () => {
          const made = await request(token, '/api/v1/channels', { method: 'POST', body: creating });
          setCreating(null);
          await loadMine();
          setOpenId(made.id);
        })}>Create channel</button>
      </Panel>
    );
  }
  if (openId && channel && managingAdmins) {
    return <ChannelAdmins token={token} channel={{ ...channel, viewerId }} onBack={() => setManagingAdmins(false)} onClose={onClose} onChanged={() => { loadChannel(channel.id); loadMine(); }} />;
  }
  if (openId && channel) {
    const toggleFollow = () => act(async () => {
      await request(token, `/api/v1/channels/${channel.id}/follow`, { method: channel.following ? 'DELETE' : 'POST' });
      await loadChannel(channel.id);
      await loadMine();
    });
    let lastDay = '';
    return (
      <Panel title={channel.name} subtitle={`Channel · ${followerCount(channel.followers)}`} onBack={() => setOpenId('')} onClose={onClose}>
        <Notice error={error} />
        <div className="hm-channel-feed message-scroll" data-chat-theme="default" data-wallpaper={wallpaper}>
          <section className="hm-channel-info" aria-label="About this channel">
            <span className="hm-channel-avatar is-large" aria-hidden="true">{channel.name.slice(0, 1).toUpperCase()}</span>
            <h2>{channel.name}{channel.verified && <VerifiedBadge size={22} />}</h2>
            <p className="hm-channel-meta">Channel · {followerCount(channel.followers)}</p>
            <p className="hm-channel-tags"><span>{CHANNEL_CATEGORY_LABELS[channel.category] ?? 'Other'}</span>{channel.role && <span>{channel.role === 'owner' ? 'Owner' : 'Admin'}</span>}</p>
            {channel.description && <p className="hm-channel-description">{channel.description}</p>}
            {!channel.mine && <button type="button" className={`hm-channel-follow${channel.following ? ' is-following' : ''}`} onClick={toggleFollow}>{channel.following ? 'Following' : 'Follow'}</button>}
            {channel.canPost && <button type="button" className="hm-channel-follow is-following" onClick={() => setManagingAdmins(true)}>Admins</button>}
            {channel.mine && !channel.verified && <ChannelVerification token={token} channelId={channel.id} />}
          </section>
          {channel.posts.map((item) => {
            const day = new Date(item.createdAt).toDateString();
            const showDay = day !== lastDay;
            lastDay = day;
            const counts = Object.entries(item.reactions ?? {}).filter(([, count]) => count > 0);
            return (
              <div key={item.id} className="hm-channel-item">
                {showDay && <div className="day-divider"><span>{new Date(item.createdAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>}
                <article className="hm-channel-bubble">
                  <p><FormattedText text={item.content} /></p>
                  <footer>
                    <time>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                    {channel.canPost && <button type="button" className="hm-channel-delete" aria-label="Delete post" onClick={() => act(async () => { await request(token, `/api/v1/channels/${channel.id}/posts/${item.id}`, { method: 'DELETE' }); await loadChannel(channel.id); })}><Trash2 size={13} /></button>}
                  </footer>
                </article>
                {/* A reaction summary under each update; the picker opens on tap, one post at a time. */}
                <div className="hm-channel-reactions" aria-label="Reactions">
                  {counts.length > 0 && <span className="hm-channel-reaction-total">{counts.map(([emoji]) => emoji).join('')} {counts.reduce((sum, [, count]) => sum + count, 0)}</span>}
                  <button type="button" className={`hm-channel-react${picking === item.id ? ' is-open' : ''}`} aria-label={item.myReaction ? `Your reaction: ${item.myReaction}. Change` : 'React'} aria-expanded={picking === item.id} onClick={() => setPicking(picking === item.id ? null : item.id)}>
                    {item.myReaction ? <span aria-hidden="true">{item.myReaction}</span> : <SmilePlus size={15} aria-hidden="true" />}
                  </button>
                  {picking === item.id && (
                    <span className="hm-channel-picker" role="group" aria-label="Choose a reaction">
                      {CHANNEL_REACTIONS.map((emoji) => (
                        <button key={emoji} type="button" className={item.myReaction === emoji ? 'is-on' : ''} aria-label={item.myReaction === emoji ? `Remove ${emoji}` : `React ${emoji}`} aria-pressed={item.myReaction === emoji} onClick={() => { setPicking(null); act(async () => {
                          await request(token, `/api/v1/channels/${channel.id}/posts/${item.id}/reaction`, { method: 'PUT', body: { emoji: item.myReaction === emoji ? null : emoji } });
                          await loadChannel(channel.id);
                        }); }}>{emoji}</button>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!channel.posts.length && <p className="hm-channel-empty">No updates yet.</p>}
        </div>
        {channel.canPost ? (
          <form className="hm-compose" onSubmit={(event) => { event.preventDefault(); act(async () => { await request(token, `/api/v1/channels/${channel.id}/posts`, { method: 'POST', body: { content: post } }); setPost(''); await loadChannel(channel.id); }); }}>
            <input className="hm-input" value={post} maxLength={4000} placeholder="Post an update" onChange={(event) => setPost(event.target.value)} />
            <button type="submit" className="icon-button" aria-label="Post" disabled={!post.trim()}><Send size={18} /></button>
          </form>
        ) : !channel.following && (
          <div className="hm-channel-follow-foot">
            <button type="button" className="hm-channel-follow-bar" onClick={toggleFollow}>Follow</button>
            <p><Lock size={12} aria-hidden="true" /> Channel updates are public. The channel and other followers can’t see who follows it.</p>
          </div>
        )}
      </Panel>
    );
  }
  return (
    <Panel title="Channels" onClose={onClose}>
      <Notice error={error} />
      <button type="button" className="hm-row-button" onClick={() => setCreating({ name: '', description: '', category: 'other' })}><Plus size={18} /> Create channel</button>
      {mine.length > 0 && <h3 className="hm-section">Your channels</h3>}
      {mine.map((item) => <button key={item.id} type="button" className="hm-row-main hm-channel-row" onClick={() => setOpenId(item.id)}><span className="hm-channel-avatar" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span><strong>{item.name}{item.verified && <VerifiedBadge size={14} />}</strong><small>{item.mine ? 'Your channel' : item.role === 'admin' ? 'Admin' : 'Following'} · {followerCount(item.followers)}</small></span></button>)}
      <h3 className="hm-section">Find channels</h3>
      <div className="wa-chips hm-channel-categories" role="tablist" aria-label="Categories">
        <button type="button" role="tab" aria-selected={!category} className={!category ? 'active' : ''} onClick={() => setCategory('')}>All</button>
        {Object.entries(CHANNEL_CATEGORY_LABELS).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={category === id} className={category === id ? 'active' : ''} onClick={() => setCategory(category === id ? '' : id)}>{label}</button>
        ))}
      </div>
      <input className="hm-input" placeholder="Search channels" value={query} onChange={(event) => setQuery(event.target.value)} />
      {found.filter((item) => !mine.some((own) => own.id === item.id)).map((item) => (
        <button key={item.id} type="button" className="hm-row-main hm-channel-row" onClick={() => setOpenId(item.id)}><span className="hm-channel-avatar" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span><strong>{item.name}{item.verified && <VerifiedBadge size={14} />}</strong><small>{CHANNEL_CATEGORY_LABELS[item.category] ?? 'Other'} · {followerCount(item.followers)}</small></span></button>
      ))}
    </Panel>
  );
}

// --- Scheduled messages ------------------------------------------------------------------------------------
const localInputValue = (time) => new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function ScheduledMessages({ token, userId, onClose, initialPeerId = '' }) {
  const chats = useChatStore((state) => state.chats);
  const contacts = useMemo(() => directContacts(chats), [chats]);
  const [items, setItems] = useState([]);
  const [peerId, setPeerId] = useState(initialPeerId || contacts[0]?.id || '');
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => localInputValue(Date.now() + 60 * 60 * 1000));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The server holds the sealed message; this device shows it from its own memory of what it sealed.
  async function load() {
    const rows = await request(token, '/api/v1/scheduled').catch((caught) => { setError(caught.message); return []; });
    const shown = [];
    for (const row of rows) shown.push({ ...row, text: (await openContent(row.content, { senderId: userId })).content || '🔒 Message' });
    setItems(shown);
  }
  useEffect(() => { load(); }, [token]);

  async function schedule() {
    setError('');
    const sendAt = new Date(when).getTime();
    try {
      // Sealed now, for the contact's devices as they are now (a device added later can't read it).
      const content = await sealDirect(peerId, text.trim());
      await request(token, '/api/v1/scheduled', { method: 'POST', body: { receiverId: peerId, content, sendAt } });
      setText('');
      setNotice(`Scheduled for ${new Date(sendAt).toLocaleString()}.`);
      await load();
    } catch (caught) { setError(caught.message); }
  }

  return (
    <Panel title="Scheduled messages" onClose={onClose}>
      <Notice error={error} notice={notice} />
      <label className="hm-field">To<select className="hm-input" value={peerId} onChange={(event) => setPeerId(event.target.value)}>
        {contacts.map((chat) => <option key={chat.id} value={chat.id}>{chat.name} (@{chat.username})</option>)}
      </select></label>
      <label className="hm-field">Message<textarea className="hm-input" maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label className="hm-field">Send at<input className="hm-input" type="datetime-local" value={when} min={localInputValue(Date.now() + 60_000)} onChange={(event) => setWhen(event.target.value)} /></label>
      <button type="button" className="hm-primary" disabled={!peerId || !text.trim()} onClick={schedule}>Schedule</button>
      {items.length > 0 && <h3 className="hm-section">Waiting to send</h3>}
      {items.map((item) => (
        <div key={item.id} className="hm-row">
          <span className="hm-row-main"><span><strong>{contacts.find((chat) => chat.id === item.receiverId)?.name ?? 'Contact'} · {new Date(item.sendAt).toLocaleString()}</strong><small>{item.text}</small></span></span>
          <button type="button" className="icon-button" aria-label="Cancel scheduled message" onClick={() => request(token, `/api/v1/scheduled/${item.id}`, { method: 'DELETE' }).then(load).catch((caught) => setError(caught.message))}><Trash2 size={16} /></button>
        </div>
      ))}
    </Panel>
  );
}

// --- Call links ---------------------------------------------------------------------------------------------
export const callLinkUrl = (code) => `${publicOrigin()}/call/${code}`;
export const callLinkCodeFrom = (text) => /(?:\/call\/|^)([A-Za-z0-9_-]{16})\/?$/.exec(String(text ?? '').trim())?.[1] ?? null;

export function CallLinks({ token, onClose }) {
  const [links, setLinks] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => request(token, '/api/v1/call-links').then(setLinks).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token]);
  const copy = (code) => navigator.clipboard?.writeText(callLinkUrl(code)).then(() => setNotice('Link copied.')).catch(() => setNotice(callLinkUrl(code)));
  return (
    <Panel title="Call links" onClose={onClose}>
      <Notice error={error} notice={notice} />
      <p className="hm-muted">Anyone with a link can call you, even if they aren’t a contact. Revoke a link to stop it working.</p>
      <span className="hm-row-actions">
        {['audio', 'video'].map((mode) => (
          <button key={mode} type="button" className="hm-row-button" onClick={() => request(token, '/api/v1/call-links', { method: 'POST', body: { mode } }).then((link) => { copy(link.code); return load(); }).catch((caught) => setError(caught.message))}>
            <Link2 size={18} /> New {mode === 'video' ? 'video' : 'voice'} call link
          </button>
        ))}
      </span>
      {links.map((link) => (
        <div key={link.code} className="hm-row">
          <span className="hm-row-main"><Link2 size={18} /><span><strong>{link.mode === 'video' ? 'Video' : 'Voice'} call link</strong><small>{callLinkUrl(link.code)}</small></span></span>
          <button type="button" className="icon-button" aria-label="Copy link" onClick={() => copy(link.code)}><Copy size={16} /></button>
          <button type="button" className="icon-button" aria-label="Revoke link" onClick={() => request(token, `/api/v1/call-links/${link.code}`, { method: 'DELETE' }).then(load).catch((caught) => setError(caught.message))}><Trash2 size={16} /></button>
        </div>
      ))}
    </Panel>
  );
}

/** Opening someone's call link: shows whose it is, then connects and calls them. */
export function JoinCallLink({ token, code, onClose, onCall }) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { request(token, `/api/v1/call-links/${code}`).then(setLink).catch((caught) => setError(caught.message)); }, [token, code]);
  return (
    <Panel title="Call link" onClose={onClose}>
      <Notice error={error} />
      {link && (link.mine ? <p className="hm-muted">This is your own call link.</p> : (
        <>
          <p>Call <strong>{link.owner.name}</strong> (@{link.owner.username}) — {link.mode === 'video' ? 'video' : 'voice'} call.</p>
          <button type="button" className="hm-primary" onClick={() => request(token, `/api/v1/call-links/${code}/join`, { method: 'POST' })
            .then((joined) => onCall(joined.owner, joined.mode)).catch((caught) => setError(caught.message))}>Start call</button>
        </>
      ))}
    </Panel>
  );
}

// --- Status privacy and muted statuses -------------------------------------------------------------------------
export const MUTED_STATUS_KEY = 'hm:muted-statuses';
export function mutedStatusUsers() {
  try { return JSON.parse(deviceStorage.getItem(MUTED_STATUS_KEY) ?? '[]'); } catch { return []; }
}
export function setStatusMuted(userId, muted) {
  const next = new Set(mutedStatusUsers());
  if (muted) next.add(userId); else next.delete(userId);
  try { deviceStorage.setItem(MUTED_STATUS_KEY, JSON.stringify([...next])); } catch { /* still applies this session */ }
  return [...next];
}

export function StatusPrivacy({ token, onClose }) {
  const chats = useChatStore((state) => state.chats);
  const contacts = useMemo(() => directContacts(chats), [chats]);
  const [state, setState] = useState(null);
  const [muted, setMuted] = useState(mutedStatusUsers);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { request(token, '/api/v1/me/status-privacy').then(setState).catch((caught) => setError(caught.message)); }, [token]);
  const save = (next) => request(token, '/api/v1/me/status-privacy', { method: 'PUT', body: next })
    .then((saved) => { setState(saved); setNotice('Saved. Applies to your current and future status updates.'); })
    .catch((caught) => setError(caught.message));
  if (!state) return <Panel title="Status privacy" onClose={onClose}><Notice error={error} /></Panel>;
  return (
    <Panel title="Status privacy" onClose={onClose}>
      <Notice error={error} notice={notice} />
      <h3 className="hm-section">Who can see my status updates</h3>
      {[['contacts', 'My contacts'], ['except', 'My contacts except…'], ['only', 'Only share with…']].map(([value, label]) => (
        <label key={value} className="hm-check-row"><input type="radio" name="status-audience" checked={state.audience === value} onChange={() => save({ audience: value, userIds: value === 'contacts' ? [] : state.userIds })} /><span>{label}</span></label>
      ))}
      {state.audience !== 'contacts' && <ContactChecklist chats={contacts} selected={state.userIds} onChange={(userIds) => save({ audience: state.audience, userIds })} />}
      <h3 className="hm-section">Muted status updates</h3>
      <p className="hm-muted">Muted people’s updates move to the bottom of Updates and don’t show a ring.</p>
      {contacts.filter((chat) => muted.includes(chat.id)).map((chat) => (
        <div key={chat.id} className="hm-row"><span className="hm-row-main"><span><strong>{chat.name}</strong></span></span><button type="button" className="hm-chip" onClick={() => setMuted(setStatusMuted(chat.id, false))}>Unmute</button></div>
      ))}
      {!muted.length && <p className="hm-muted">No one is muted.</p>}
    </Panel>
  );
}

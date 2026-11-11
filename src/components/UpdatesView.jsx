import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ChevronLeft, Eye, Pencil, Plus, Send, Trash2, Type, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { apiFetch } from '../api.js';
import Avatar from './Avatar.jsx';
import TabMenu from './TabMenu.jsx';
import { loadMediaBlob } from '../media.js';
import { presentName } from '../profile.js';
import { useBackHandler } from '../backStack.js';
import { followerCount, mutedStatusUsers, setStatusMuted } from './extras/ExtrasPanels.jsx';
import VerifiedBadge from './VerifiedBadge.jsx';
const HIDDEN_SUGGESTIONS_KEY = 'hm:hidden-channel-suggestions';
import {
  STATUS_BACKGROUNDS, deleteStatus, fetchStatuses, markStatusSeen, postMediaStatus, postTextStatus, statusKind, statusTime, statusViewers,
} from '../statusApi.js';

const IMAGE_SECONDS = 5;

// The Updates tab: a row of status cards (yours first: Add status; then new, viewed and muted updates),
// channels below, and buttons for a text or camera status.
export default function UpdatesView({ onOpenChannels, onSheet, onSettings }) {
  const token = useChatStore((state) => state.sessionToken);
  const userId = useChatStore((state) => state.userId);
  const me = useChatStore((state) => state.user);
  const revision = useChatStore((state) => state.statusRevision ?? 0);
  const [feed, setFeed] = useState({ mine: [], others: [] });
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [posting, setPosting] = useState('');
  const fileRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const next = await fetchStatuses(token, userId);
      setFeed(next);
      useChatStore.getState().setStatusRings(next);
      setError('');
    } catch (caught) {
      setError(caught.message);
    }
  }, [token, userId]);
  useEffect(() => { refresh(); }, [refresh, revision]);
  useBackHandler(adding, () => setAdding(false));

  async function postFile(file) {
    if (!file) return;
    setAdding(false);
    setPosting('Posting…');
    try {
      await postMediaStatus(token, userId, file, { onProgress: (sent, total) => setPosting(`Posting… ${Math.round((sent / Math.max(1, total)) * 100)}%`) });
      await refresh();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPosting('');
    }
  }

  // Muted people (Status privacy) move to their own section at the bottom and never count as new.
  const [muted, setMuted] = useState(mutedStatusUsers);
  const unmuted = feed.others.filter((entry) => !muted.includes(entry.user.id));
  const mutedEntries = feed.others.filter((entry) => muted.includes(entry.user.id));
  const recent = unmuted.filter((entry) => !entry.allSeen);
  const viewed = unmuted.filter((entry) => entry.allSeen);
  const mine = feed.mine;
  const myLast = mine.at(-1);
  // Channels I follow or own, below the statuses.
  const [channels, setChannels] = useState([]);
  useEffect(() => {
    if (!token) return;
    apiFetch('/api/v1/channels', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : [])).then(setChannels).catch(() => {});
  }, [token, revision]);
  // Suggested channels to follow (the directory, minus channels already followed and ones hidden here).
  const [suggested, setSuggested] = useState([]);
  const [hiddenSuggestions, setHiddenSuggestions] = useState(() => { try { return JSON.parse(localStorage.getItem(HIDDEN_SUGGESTIONS_KEY) ?? '[]'); } catch { return []; } });
  const [channelsRevision, setChannelsRevision] = useState(0);
  useEffect(() => {
    if (!token) return;
    apiFetch('/api/v1/channels/discover?q=', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : [])).then(setSuggested).catch(() => {});
  }, [token, revision, channelsRevision]);
  const suggestions = suggested.filter((item) => !channels.some((own) => own.id === item.id) && !hiddenSuggestions.includes(item.id)).slice(0, 5);
  const hideSuggestion = (id) => setHiddenSuggestions((current) => {
    const next = [...current, id];
    try { localStorage.setItem(HIDDEN_SUGGESTIONS_KEY, JSON.stringify(next)); } catch { /* hidden for this session */ }
    return next;
  });
  async function follow(id) {
    const response = await apiFetch(`/api/v1/channels/${id}/follow`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!response?.ok) return;
    const followed = suggested.find((item) => item.id === id);
    if (followed) setChannels((current) => [...current, { ...followed, followers: (followed.followers ?? 0) + 1 }]);
    setChannelsRevision((value) => value + 1);
  }

  return (
    <div className="updates-view-container">
      <div className="updates-header">
        <h2>Updates</h2>
        <TabMenu items={[
          { label: 'Create channel', onClick: () => onOpenChannels?.(':create') },
          { label: 'Status privacy', onClick: () => onSheet?.('statusprivacy') },
          { label: 'Starred messages', onClick: () => onSheet?.('starred') },
          { label: 'Settings', onClick: () => onSettings?.() },
        ]} />
      </div>
      <div className="updates-content">
        <h3 className="status-title">Status</h3>
        {/* One row of tall cards: yours first, then new updates, viewed ones, and muted ones (dimmed). */}
        <div className="status-cards" role="list" aria-label="Status updates">
          <div className="status-card-wrap" role="listitem">
            <button type="button" className={`status-card is-mine${mine.length ? '' : ' is-add'}`} onClick={() => (mine.length ? setViewing({ owner: 'me', index: 0 }) : setAdding(true))}
              aria-label={mine.length ? 'View my status' : 'Add status'}>
              {myLast ? <StatusCardPreview token={token} status={myLast} /> : <span className="status-card-add-bg" aria-hidden="true"><Avatar name={me?.name ?? 'You'} initials={me?.initials ?? 'ME'} color={me?.color} image={me?.avatar} size="large" /></span>}
              <span className="status-card-name">{posting || (mine.length ? 'My status' : 'Add status')}</span>
            </button>
            <button type="button" className="status-card-plus" onClick={() => setAdding(true)} aria-label="Add status"><Plus size={16} strokeWidth={3} /></button>
          </div>
          {recent.map((entry) => (
            <StatusCard key={entry.user.id} token={token} entry={entry} onOpen={() => setViewing({ owner: entry.user.id, index: Math.max(0, entry.statuses.findIndex((status) => !status.seen)) })} />
          ))}
          {viewed.map((entry) => <StatusCard key={entry.user.id} token={token} entry={entry} seen onOpen={() => setViewing({ owner: entry.user.id, index: 0 })} />)}
          {mutedEntries.map((entry) => <StatusCard key={entry.user.id} token={token} entry={entry} seen muted onOpen={() => setViewing({ owner: entry.user.id, index: 0 })} />)}
        </div>

        {/* Belongs to Status: shown under the cards until a contact posts. */}
        {feed.others.length === 0 && !error && <p className="status-empty-hint">Status updates from your contacts appear here for 24 hours.</p>}
        {error && <p className="status-error" role="alert">{error}</p>}
        <section className="updates-channels" aria-label="Channels">
          <header><h3 className="status-title">Channels</h3></header>
          {channels.map((channel) => (
            <button key={channel.id} type="button" className="status-row-main updates-channel" onClick={() => onOpenChannels?.(channel.id)}>
              <span className="updates-channel-icon" aria-hidden="true">{channel.name.slice(0, 1).toUpperCase()}</span>
              <span className="status-row-text"><strong>{channel.name}{channel.verified && <VerifiedBadge size={14} />}</strong><small>{channel.mine ? 'Your channel' : followerCount(channel.followers)}</small></span>
            </button>
          ))}
          {!channels.length && <p className="updates-channels-empty">Stay up to date on topics that matter to you. Find channels to follow below.</p>}
          {suggestions.length > 0 && (
            <>
              <h4 className="updates-suggest-title">Find channels to follow</h4>
              {suggestions.map((channel) => (
                <div key={channel.id} className="updates-suggest-row">
                  <button type="button" className="status-row-main updates-channel" onClick={() => onOpenChannels?.(channel.id)}>
                    <span className="updates-channel-icon" aria-hidden="true">{channel.name.slice(0, 1).toUpperCase()}</span>
                    <span className="status-row-text"><strong>{channel.name}{channel.verified && <VerifiedBadge size={14} />}</strong><small>{followerCount(channel.followers)}</small></span>
                  </button>
                  <button type="button" className="updates-follow" onClick={() => follow(channel.id)}>Follow</button>
                  <button type="button" className="updates-suggest-hide" onClick={() => hideSuggestion(channel.id)} aria-label={`Hide ${channel.name}`}><X size={16} /></button>
                </div>
              ))}
            </>
          )}
          <button type="button" className="updates-channels-find updates-channels-button" onClick={() => onOpenChannels?.()}>Explore more</button>
          <button type="button" className="updates-channels-button is-quiet" onClick={() => onOpenChannels?.(':create')}>Create channel</button>
        </section>
      </div>

      <div className="status-fabs">
        <button type="button" className="status-fab small" onClick={() => setComposing(true)} aria-label="Write a text status"><Pencil size={20} /></button>
        <button type="button" className="status-fab" onClick={() => fileRef.current?.click()} aria-label="Post a photo or video status"><Camera size={24} /></button>
      </div>
      <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(event) => { postFile(event.target.files?.[0]); event.target.value = ''; }} />

      {adding && (
        <div className="modal-overlay" onClick={() => setAdding(false)}>
          <div className="status-add-sheet" role="dialog" aria-label="Add status" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => { setAdding(false); fileRef.current?.click(); }}><Camera size={22} /><span>Photo or video</span></button>
            <button type="button" onClick={() => { setAdding(false); setComposing(true); }}><Type size={22} /><span>Text</span></button>
          </div>
        </div>
      )}
      {/* Full screen over everything, the tab bar included (inside the Updates panel they were clipped to it). */}
      {composing && createPortal(<TextStatusComposer onClose={() => setComposing(false)} onPost={async (text, background) => { await postTextStatus(token, text, background); setComposing(false); refresh(); }} />, document.body)}
      {viewing && createPortal(
        <StatusViewer
          token={token}
          owner={viewing.owner === 'me' ? { user: me ?? { name: 'You' }, statuses: mine, mine: true } : feed.others.find((entry) => entry.user.id === viewing.owner)}
          startIndex={viewing.index}
          onClose={() => { setViewing(null); refresh(); }}
          onDeleted={refresh}
          muted={viewing.owner !== 'me' && muted.includes(viewing.owner)}
          onToggleMute={() => setMuted(setStatusMuted(viewing.owner, !muted.includes(viewing.owner)))}
        />,
        document.body,
      )}
    </div>
  );
}

// A reply goes to the author's chat, end-to-end encrypted, quoting the status (src/e2e/client.js statusReply).
// One tap sends a reaction to the author's chat (quoting the status, end-to-end encrypted, like a reply).
export const STATUS_REACTIONS = ['😍', '😂', '😮', '😢', '👏', '🙏', '🔥', '❤️'];

function StatusReply({ status, authorId, onFocus, onBlur, onSent }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const sendMessage = useChatStore((state) => state.sendMessage);
  const quote = statusKind(status.content);
  const statusReply = (extra = {}) => ({ statusReply: { kind: quote.kind, text: quote.kind === 'text' ? quote.text.slice(0, 200) : '', ...extra } });
  function send(event) {
    event.preventDefault();
    if (!text.trim() || !authorId) return;
    sendMessage(authorId, text.trim(), statusReply());
    setText('');
    onSent?.();
  }
  function react(emoji) {
    if (!authorId) return;
    sendMessage(authorId, emoji, statusReply({ reaction: true }));
    setSent(emoji);
  }
  useEffect(() => { setSent(''); }, [status.id]);
  return (
    <form className="status-reply" onSubmit={send} onPointerDown={(event) => event.stopPropagation()}>
      <div className="status-reactions" role="group" aria-label="Quick reactions">
        {STATUS_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" className={sent === emoji ? 'is-sent' : ''} onClick={() => react(emoji)} aria-label={`React ${emoji}`} aria-pressed={sent === emoji}>{emoji}</button>
        ))}
      </div>
      {sent && <p className="status-reaction-sent" role="status">Reaction sent</p>}
      <input value={text} maxLength={4000} placeholder="Reply" onFocus={onFocus} onBlur={onBlur} onChange={(event) => setText(event.target.value)} aria-label="Reply to this status" />
      <button type="submit" disabled={!text.trim()} aria-label="Send reply"><Send size={18} /></button>
    </form>
  );
}

// A tall card: the person's latest status as the picture, their photo in a ring (new or seen), name below.
function StatusCard({ token, entry, seen = false, muted = false, onOpen }) {
  const { user, statuses } = entry;
  const latest = statuses.at(-1);
  return (
    <div className="status-card-wrap" role="listitem">
      <button type="button" className={`status-card${seen ? ' is-seen' : ' is-new'}${muted ? ' is-muted' : ''}`} onClick={onOpen}
        aria-label={`${presentName(user)}, ${statuses.length} update${statuses.length === 1 ? '' : 's'}, ${statusTime(entry.lastAt)}${seen ? '' : ', new'}`}>
        {latest && <StatusCardPreview token={token} status={latest} />}
        <span className={`status-card-ring ${seen ? 'is-seen' : 'is-new'}`}>
          <Avatar name={user.name} initials={user.initials ?? user.username?.slice(0, 2)?.toUpperCase() ?? '?'} color={user.color} image={user.avatar} size="small" />
        </span>
        <span className="status-card-name">{presentName(user)}</span>
      </button>
    </div>
  );
}

// The picture on a card: a text status on its colour, or the photo / first frame of the video.
function StatusCardPreview({ token, status }) {
  const { kind, mediaId, text } = statusKind(status.content);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!mediaId || kind === 'file') return undefined;
    let cancelled = false;
    let objectUrl = '';
    loadMediaBlob(mediaId, token).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [mediaId, kind, token]);
  if (kind === 'text') return <span className="status-card-text" style={{ background: status.background ?? '#005ad1' }}><span>{text}</span></span>;
  if (!url) return <span className="status-card-media is-loading" aria-hidden="true" />;
  if (kind === 'video') return <video className="status-card-media" src={`${url}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />;
  return <img className="status-card-media" src={url} alt="" />;
}

function TextStatusComposer({ onClose, onPost }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackHandler(true, onClose);
  async function post() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onPost(text.trim(), STATUS_BACKGROUNDS[color]);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }
  return (
    <div className="status-compose" style={{ background: STATUS_BACKGROUNDS[color] }} role="dialog" aria-label="Text status">
      <header>
        <button type="button" onClick={onClose} aria-label="Close"><X size={24} /></button>
        <button type="button" onClick={() => setColor((color + 1) % STATUS_BACKGROUNDS.length)} aria-label="Change background colour"><span className="status-color-dot" /></button>
      </header>
      <textarea autoFocus maxLength={700} placeholder="Type a status" value={text} onChange={(event) => setText(event.target.value)} />
      {error && <p className="status-error">{error}</p>}
      <button type="button" className="status-fab status-compose-send" onClick={post} disabled={!text.trim() || busy} aria-label="Post status"><Send size={22} /></button>
    </div>
  );
}

function StatusMedia({ status, token, onReady, videoRef }) {
  const { kind, mediaId } = statusKind(status.content);
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!mediaId) return undefined;
    let cancelled = false;
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    loadMediaBlob(mediaId, token).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (!cancelled) { setFailed(true); onReady?.(IMAGE_SECONDS); } });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [mediaId, token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (kind === 'text') {
    return <div className="status-text-slide" style={{ background: status.background ?? '#005ad1' }}><p>{statusKind(status.content).text}</p></div>;
  }
  if (failed) return <div className="status-text-slide"><p>This status is no longer available.</p></div>;
  if (!url) return <div className="status-loading" />;
  if (kind === 'video') return <video ref={videoRef} className="status-media" src={url} autoPlay playsInline onLoadedMetadata={(event) => onReady?.(event.currentTarget.duration || IMAGE_SECONDS)} />;
  return <img className="status-media" src={url} alt="" onLoad={() => onReady?.(IMAGE_SECONDS)} />;
}

// Full-screen viewer with a progress bar per status: tap right for next, left for previous; marks each seen.
function StatusViewer({ token, owner, startIndex = 0, onClose, onDeleted, muted = false, onToggleMute }) {
  const [index, setIndex] = useState(startIndex);
  const [duration, setDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState(null);
  const videoRef = useRef(null);
  const statuses = owner?.statuses ?? [];
  const status = statuses[index];
  useBackHandler(true, () => (viewers ? setViewers(null) : onClose()));

  useEffect(() => {
    setElapsed(0);
    setDuration(statusKind(status?.content).kind === 'text' ? IMAGE_SECONDS : 0);
    if (status && !owner.mine && !status.seen) markStatusSeen(token, status.id).then(() => { status.seen = true; }).catch(() => {});
  }, [status?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!duration || paused || viewers) return undefined;
    const started = Date.now() - elapsed * 1000;
    const timer = setInterval(() => {
      const next = (Date.now() - started) / 1000;
      if (next >= duration) {
        clearInterval(timer);
        if (index + 1 < statuses.length) setIndex(index + 1);
        else onClose();
      } else setElapsed(next);
    }, 100);
    return () => clearInterval(timer);
  }, [duration, paused, viewers, index]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!status) return null;
  const go = (step) => {
    const next = index + step;
    if (next < 0) setElapsed(0);
    else if (next >= statuses.length) onClose();
    else setIndex(next);
  };
  async function remove() {
    await deleteStatus(token, status.id).catch(() => {});
    onDeleted?.();
    onClose();
  }
  async function showViewers() {
    setPaused(true);
    videoRef.current?.pause();
    setViewers(await statusViewers(token, status.id).catch(() => []));
  }

  return (
    <div className="status-viewer" role="dialog" aria-label={`Status from ${owner.mine ? 'you' : presentName(owner.user)}`}>
      <div className="status-bars">
        {statuses.map((item, position) => (
          <span key={item.id}><i style={{ width: `${position < index ? 100 : position > index ? 0 : Math.min(100, (elapsed / Math.max(duration, 0.1)) * 100)}%` }} /></span>
        ))}
      </div>
      <header className="status-viewer-head">
        <button type="button" onClick={onClose} aria-label="Close"><ChevronLeft size={26} /></button>
        <Avatar name={owner.user?.name} initials={owner.user?.initials ?? 'ME'} color={owner.user?.color} image={owner.user?.avatar} />
        <span className="status-viewer-title"><strong>{owner.mine ? 'My status' : presentName(owner.user)}</strong><small>{statusTime(status.createdAt)}</small></span>
        {owner.mine && <button type="button" onClick={remove} aria-label="Delete this status"><Trash2 size={20} /></button>}
        {!owner.mine && <button type="button" className="status-mute" onClick={onToggleMute} aria-label={muted ? 'Unmute status updates' : 'Mute status updates'}>{muted ? 'Unmute' : 'Mute'}</button>}
      </header>
      <div
        className="status-stage"
        onPointerDown={() => { setPaused(true); videoRef.current?.pause(); }}
        onPointerUp={(event) => {
          setPaused(false);
          videoRef.current?.play().catch(() => {});
          const rect = event.currentTarget.getBoundingClientRect();
          go(event.clientX - rect.left < rect.width / 3 ? -1 : 1);
        }}
      >
        <StatusMedia status={status} token={token} videoRef={videoRef} onReady={(seconds) => setDuration(Math.min(30, seconds))} />
      </div>
      {owner.mine && (
        <button type="button" className="status-views" onClick={showViewers}><Eye size={18} /> {status.views ?? 0}</button>
      )}
      {!owner.mine && (
        <StatusReply status={status} authorId={owner.user?.id} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} onSent={onClose} />
      )}
      {viewers && (
        <div className="status-viewers" onClick={() => { setViewers(null); setPaused(false); }}>
          <div onClick={(event) => event.stopPropagation()}>
            <h4>Viewed by {viewers.length}</h4>
            {viewers.length === 0 && <p>No views yet</p>}
            {viewers.map((item) => (
              <div key={item.user.id} className="status-viewer-row">
                <Avatar name={item.user.name} initials={item.user.initials} color={item.user.color} image={item.user.avatar} />
                <span><strong>{presentName(item.user)}</strong><small>{statusTime(item.viewedAt)}</small></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

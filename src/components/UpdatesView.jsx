import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ChevronLeft, Eye, Pencil, Plus, Send, Trash2, Type, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import Avatar from './Avatar.jsx';
import { loadMediaBlob } from '../media.js';
import { presentName } from '../profile.js';
import { useBackHandler } from '../backStack.js';
import {
  STATUS_BACKGROUNDS, deleteStatus, fetchStatuses, markStatusSeen, postMediaStatus, postTextStatus, statusKind, statusTime, statusViewers,
} from '../statusApi.js';

const IMAGE_SECONDS = 5;

// The Updates tab: your status ("Add status · Disappears after 24 hours"), then your contacts' statuses
// ("Recent updates" with a green ring until you have seen them all, then "Viewed updates").
export default function UpdatesView() {
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
      setFeed(await fetchStatuses(token));
      setError('');
    } catch (caught) {
      setError(caught.message);
    }
  }, [token]);
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

  const recent = feed.others.filter((entry) => !entry.allSeen);
  const viewed = feed.others.filter((entry) => entry.allSeen);
  const mine = feed.mine;
  const myLast = mine.at(-1);

  return (
    <div className="updates-view-container">
      <div className="updates-header">
        <h2>Updates</h2>
      </div>
      <div className="updates-content">
        <h3 className="status-title">Status</h3>
        <div className="status-row status-mine">
          <button type="button" className="status-row-main" onClick={() => (mine.length ? setViewing({ owner: 'me', index: 0 }) : setAdding(true))}>
            <span className={`status-ring ${mine.length ? 'is-mine' : 'is-empty'}`}>
              <Avatar name={me?.name ?? 'You'} initials={me?.initials ?? 'ME'} color={me?.color} image={me?.avatar} />
            </span>
            <span className="status-row-text">
              <strong>{mine.length ? 'My status' : 'Add status'}</strong>
              <small>{posting || (myLast ? `${mine.length} update${mine.length === 1 ? '' : 's'} · ${statusTime(myLast.createdAt)}` : 'Disappears after 24 hours')}</small>
            </span>
          </button>
          <button type="button" className="status-add-badge" onClick={() => setAdding(true)} aria-label="Add status"><Plus size={16} strokeWidth={3} /></button>
        </div>

        {error && <p className="status-error" role="alert">{error}</p>}

        {recent.length > 0 && <h4 className="status-section">Recent updates</h4>}
        {recent.map((entry) => (
          <StatusPerson key={entry.user.id} entry={entry} onOpen={() => setViewing({ owner: entry.user.id, index: Math.max(0, entry.statuses.findIndex((status) => !status.seen)) })} />
        ))}
        {viewed.length > 0 && <h4 className="status-section">Viewed updates</h4>}
        {viewed.map((entry) => <StatusPerson key={entry.user.id} entry={entry} seen onOpen={() => setViewing({ owner: entry.user.id, index: 0 })} />)}
        {feed.others.length === 0 && !error && (
          <div className="status-empty">
            <Eye size={40} strokeWidth={1.5} />
            <p>Status updates from your contacts appear here for 24 hours.</p>
          </div>
        )}
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
      {composing && <TextStatusComposer onClose={() => setComposing(false)} onPost={async (text, background) => { await postTextStatus(token, text, background); setComposing(false); refresh(); }} />}
      {viewing && (
        <StatusViewer
          token={token}
          owner={viewing.owner === 'me' ? { user: me ?? { name: 'You' }, statuses: mine, mine: true } : feed.others.find((entry) => entry.user.id === viewing.owner)}
          startIndex={viewing.index}
          onClose={() => { setViewing(null); refresh(); }}
          onDeleted={refresh}
        />
      )}
    </div>
  );
}

function StatusPerson({ entry, seen = false, onOpen }) {
  const { user, statuses } = entry;
  return (
    <button type="button" className="status-row-main status-person" onClick={onOpen}>
      <span className={`status-ring ${seen ? 'is-seen' : 'is-new'}`} style={{ '--segments': statuses.length }}>
        <Avatar name={user.name} initials={user.initials ?? user.username?.slice(0, 2)?.toUpperCase() ?? '?'} color={user.color} image={user.avatar} />
      </span>
      <span className="status-row-text">
        <strong>{presentName(user)}</strong>
        <small>{statusTime(entry.lastAt)}</small>
      </span>
    </button>
  );
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
    return <div className="status-text-slide" style={{ background: status.background ?? '#00a884' }}><p>{statusKind(status.content).text}</p></div>;
  }
  if (failed) return <div className="status-text-slide"><p>This status is no longer available.</p></div>;
  if (!url) return <div className="status-loading" />;
  if (kind === 'video') return <video ref={videoRef} className="status-media" src={url} autoPlay playsInline onLoadedMetadata={(event) => onReady?.(event.currentTarget.duration || IMAGE_SECONDS)} />;
  return <img className="status-media" src={url} alt="" onLoad={() => onReady?.(IMAGE_SECONDS)} />;
}

// Full-screen viewer with a progress bar per status: tap right for next, left for previous; marks each seen.
function StatusViewer({ token, owner, startIndex = 0, onClose, onDeleted }) {
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
        <span><strong>{owner.mine ? 'My status' : presentName(owner.user)}</strong><small>{statusTime(status.createdAt)}</small></span>
        {owner.mine && <button type="button" onClick={remove} aria-label="Delete this status"><Trash2 size={20} /></button>}
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

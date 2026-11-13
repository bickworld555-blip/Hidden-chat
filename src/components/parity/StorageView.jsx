// Settings › Storage and data, laid out like WhatsApp's: Manage storage (what is kept on this device, by chat, with
// review and delete), Network usage (what this device sent and received, by kind), photo upload quality, and the
// media auto-download rules for mobile data, Wi-Fi and roaming.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowUpDown, Check, ChevronRight, CloudUpload, FileText, Folder, Globe, HardDrive, Image, Images, MessageSquare, Mic, Phone, Search, Shield, Trash2, Users, Video } from 'lucide-react';
import { localStoreStatus, useChatStore } from '../../store.js';
import { clearMediaCache, formatFileSize, mediaCacheStats } from '../../media.js';
import { forgetMedia, listStoredMedia } from '../../mediaVault.js';
import { SETTINGS, appSettings, optionLabel, useSetting } from '../../settings.js';
import { AUTO_DOWNLOAD_KEYS, autoDownloadKind } from '../../autoDownload.js';
import { LARGE_ITEM_BYTES, sortItems, storageBreakdown } from '../../storageUsage.js';
import { readUsage, resetUsage, subscribeUsage, usageTotals } from '../../networkUsage.js';
import { cachedGroups } from '../../groupCache.js';
import { fetchGroupMessages } from '../../groupHistory.js';
import Avatar from '../Avatar.jsx';
import { nativeGetProxy, nativeSetProxy, nativeShell } from '../../native.js';
import Panel, { Notice } from './Panel.jsx';

const KIND_ICON = { photos: Image, videos: Video, audio: Mic, documents: FileText };
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value ?? '') || 0);

// "Photos, Audio" / "All media" / "No media", as WhatsApp words a rule.
export function ruleSummary(kinds) {
  if (!kinds?.length) return 'No media';
  if (kinds.length === SETTINGS['media.autoDownload.wifi'].options.length) return 'All media';
  return kinds.map((id) => optionLabel('media.autoDownload.wifi', id)).join(', ');
}

function useNetworkUsage() {
  return useSyncExternalStore(subscribeUsage, readUsage, readUsage);
}

function Row({ icon: Icon, title, detail, onClick, chevron = true }) {
  return (
    <button type="button" className="hm-sd-row" onClick={onClick}>
      {Icon && <Icon size={22} aria-hidden="true" />}
      <span className="hm-sd-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
      {chevron && <ChevronRight size={18} aria-hidden="true" className="hm-sd-chevron" />}
    </button>
  );
}

// --- Manage storage ---

/** Stored files and which chat each belongs to (one-to-one chats from this device, groups from the server). */
function useStorageBreakdown(refreshKey) {
  const chats = useChatStore((state) => state.chats);
  const messages = useChatStore((state) => state.messages);
  const userId = useChatStore((state) => state.userId);
  const token = useChatStore((state) => state.sessionToken);
  const [stored, setStored] = useState(null);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listStoredMedia().then((list) => { if (!cancelled) setStored(list); }).catch(() => { if (!cancelled) setStored([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    if (!userId || !token) { setGroupsLoading(false); return undefined; }
    let cancelled = false;
    (async () => {
      const list = (await cachedGroups(userId).catch(() => null)) ?? [];
      const found = [];
      // Two at a time: a phone in many groups still answers quickly, and the list fills in as they arrive.
      const queue = [...list];
      await Promise.all([0, 1].map(async () => {
        while (queue.length && !cancelled) {
          const group = queue.shift();
          try {
            const history = await fetchGroupMessages(token, group.id);
            found.push({ id: `group:${group.id}`, name: group.name, kind: 'group', messages: (history ?? []).map((message) => ({ content: message.content, at: toMs(message.createdAt) })) });
            if (!cancelled) setGroups([...found]);
          } catch { /* offline or no longer a member: its files show under Other */ }
        }
      }));
      if (!cancelled) setGroupsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId, token, refreshKey]);

  const breakdown = useMemo(() => {
    if (!stored) return null;
    const direct = chats.filter((chat) => chat.id !== userId).map((chat) => ({
      id: chat.id, name: chat.name || (chat.username ? `@${chat.username}` : 'Chat'), kind: 'chat', person: chat,
      messages: (messages[chat.id] ?? []).map((message) => ({ content: message.content, at: toMs(message.timestamp) })),
    }));
    return storageBreakdown({ stored, chats: [...direct, ...groups] });
  }, [stored, chats, messages, groups, userId]);
  return { breakdown, groupsLoading };
}

function ItemList({ items, selected, onToggle }) {
  return (
    <ul className="hm-sd-items">
      {items.map((item) => {
        const Icon = item.voice ? Mic : KIND_ICON[autoDownloadKind(item.contentType)];
        const on = selected.has(item.id);
        return (
          <li key={item.id}>
            <button type="button" className={`hm-sd-item${on ? ' is-on' : ''}`} onClick={() => onToggle(item.id)} aria-pressed={on}>
              <span className="hm-sd-item-icon">{on ? <Check size={18} /> : <Icon size={18} />}</span>
              <span><strong>{item.name}</strong><small>{formatFileSize(item.size)}{item.at ? ` · ${new Date(item.at).toLocaleDateString()}` : ''}</small></span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One chat's files (or every file over 5 MB): sort, select, delete from this device. */
function ItemsView({ title, items, onBack, onDeleted }) {
  const [order, setOrder] = useState('largest');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sorted = useMemo(() => sortItems(items, order), [items, order]);
  const chosen = items.filter((item) => selected.has(item.id));
  const chosenBytes = chosen.reduce((total, item) => total + item.size, 0);
  const toggle = (id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function remove() {
    setBusy(true);
    for (const item of chosen) await forgetMedia(item.id).catch(() => {});
    clearMediaCache();
    setBusy(false);
    setConfirming(false);
    setSelected(new Set());
    onDeleted(chosen.length, chosenBytes);
  }

  return (
    <Panel title={title} subtitle={`${formatFileSize(items.reduce((total, item) => total + item.size, 0))} · ${items.length} ${items.length === 1 ? 'item' : 'items'}`} onBack={onBack} onClose={onBack}
      actions={<button type="button" className="icon-button" onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}>{selected.size === items.length ? 'None' : 'All'}</button>}>
      <div className="hm-sd-sort" role="radiogroup" aria-label="Sort">
        {[['largest', 'Largest'], ['newest', 'Newest'], ['oldest', 'Oldest']].map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={order === id} className={order === id ? 'is-on' : ''} onClick={() => setOrder(id)}>{label}</button>
        ))}
      </div>
      {items.length === 0 ? <p className="hm-muted">Nothing kept on this device.</p> : <ItemList items={sorted} selected={selected} onToggle={toggle} />}
      {chosen.length > 0 && (
        <div className="hm-sd-delete-bar">
          {confirming ? (
            <>
              <span>Delete {chosen.length} {chosen.length === 1 ? 'item' : 'items'} ({formatFileSize(chosenBytes)}) from this device? While the server still holds a file it can be downloaded again; after that it’s gone.</span>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="is-danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
            </>
          ) : (
            <><span>{chosen.length} selected · {formatFileSize(chosenBytes)}</span><button type="button" className="is-danger" onClick={() => setConfirming(true)}><Trash2 size={16} /> Delete</button></>
          )}
        </div>
      )}
    </Panel>
  );
}

function ManageStorage({ onBack }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { breakdown, groupsLoading } = useStorageBreakdown(refreshKey);
  const [open, setOpen] = useState(null); // a row id, or 'large'
  const [query, setQuery] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [notice, setNotice] = useState('');
  const [local, setLocal] = useState(null);
  const [cache, setCache] = useState(() => mediaCacheStats());
  const ownerId = useChatStore((state) => state.userId);
  useEffect(() => { navigator.storage?.estimate?.().then(setEstimate).catch(() => {}); }, [refreshKey]);
  useEffect(() => { if (ownerId) localStoreStatus(ownerId).then(setLocal).catch(() => {}); }, [ownerId, refreshKey]);

  const deleted = (count, bytes) => { setNotice(`Deleted ${count} ${count === 1 ? 'item' : 'items'} · ${formatFileSize(bytes)} freed.`); setRefreshKey((key) => key + 1); };
  if (open && breakdown) {
    const items = open === 'large' ? breakdown.large : breakdown.rows.find((row) => row.id === open)?.items ?? [];
    const title = open === 'large' ? 'Larger than 5 MB' : breakdown.rows.find((row) => row.id === open)?.name ?? 'Chat';
    return <ItemsView title={title} items={items} onBack={() => setOpen(null)} onDeleted={deleted} />;
  }

  const used = breakdown?.total ?? 0;
  const free = estimate ? Math.max(0, Number(estimate.quota) - Number(estimate.usage)) : null;
  const rows = (breakdown?.rows ?? []).filter((row) => !query || row.name?.toLowerCase().includes(query.toLowerCase()));
  return (
    <Panel title="Manage storage" onBack={onBack} onClose={onBack}>
      <Notice notice={notice} />
      <section className="hm-sd-summary" aria-label="Storage used">
        <div className="hm-sd-summary-figures">
          <span><strong>{breakdown ? formatFileSize(used) : '…'}</strong><small>Used by media</small></span>
          {free !== null && <span className="is-free"><strong>{formatFileSize(free)}</strong><small>Free</small></span>}
        </div>
        {free !== null && (
          <div className="hm-sd-bar" role="meter" aria-label="Media share of the space available" aria-valuemin={0} aria-valuemax={used + free} aria-valuenow={used}>
            <span style={{ width: `${Math.max(used ? 1 : 0, Math.min(100, (used / Math.max(1, used + free)) * 100))}%` }} />
          </div>
        )}
        <small className="hm-muted">Photos, videos, voice messages and documents kept on this device. Messages themselves take very little space.</small>
      </section>

      <h4 className="hm-sd-heading">Review and delete items</h4>
      <button type="button" className="hm-sd-review" onClick={() => setOpen('large')} disabled={!breakdown}>
        <Images size={22} aria-hidden="true" />
        <span><strong>Larger than {formatFileSize(LARGE_ITEM_BYTES)}</strong><small>{breakdown ? `${breakdown.large.length} ${breakdown.large.length === 1 ? 'item' : 'items'} · ${formatFileSize(breakdown.large.reduce((total, item) => total + item.size, 0))}` : 'Counting…'}</small></span>
        <ChevronRight size={18} aria-hidden="true" className="hm-sd-chevron" />
      </button>

      <h4 className="hm-sd-heading">Chats</h4>
      <label className="hm-sd-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search chats" /></label>
      {!breakdown ? <p className="hm-muted">Counting…</p> : (
        <ul className="hm-sd-chats">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="hm-sd-row" onClick={() => setOpen(row.id)}>
                {row.kind === 'chat' ? <Avatar {...row.person} size="small" /> : <span className="hm-sd-chat-icon">{row.kind === 'group' ? <Users size={18} /> : <Folder size={18} />}</span>}
                <span className="hm-sd-text"><strong>{row.name}</strong><small>{row.items.length} {row.items.length === 1 ? 'item' : 'items'}</small></span>
                <span className="hm-sd-size">{formatFileSize(row.bytes)}</span>
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="hm-muted">{query ? 'No chats match.' : 'No media kept on this device yet.'}</li>}
          {groupsLoading && <li className="hm-muted">Adding groups…</li>}
        </ul>
      )}

      <details className="hm-sd-details">
        <summary>On this device</summary>
        {local && (
          <p className="hm-muted hm-local-store" data-store={local.kind}>
            Chat history: {local.kind === 'sqlite' ? 'encrypted SQLite (SQLCipher)' : 'encrypted browser storage'} · {local.messages.toLocaleString()} messages
            {local.kind === 'sqlite' && typeof local.fts === 'boolean' && <> · search {local.fts ? 'full-text index' : 'scan'} · {local.mediaFiles ?? 0} attachment files ({formatFileSize(local.mediaBytes)})</>}
            {local.error ? ` · ${local.error}` : ''}
          </p>
        )}
        <p className="hm-muted">Media cache: {cache.files} {cache.files === 1 ? 'file' : 'files'} · {formatFileSize(cache.bytes)} held for quick viewing this session.</p>
        <button type="button" disabled={!cache.files} onClick={() => { clearMediaCache(); setCache(mediaCacheStats()); setNotice('Media cache cleared.'); }}><Trash2 size={16} /> Clear media cache</button>
      </details>
    </Panel>
  );
}

// --- Network usage ---

// WhatsApp's rows in its order. "Backup storage" stands where WhatsApp has Google storage: Hidden Messenger's
// encrypted chat backup goes to its own server, not to Google Drive. Roaming is the part of the rest that moved
// while roaming (not added to the total).
const USAGE_ROWS = [
  { id: 'calls', icon: Phone, title: 'Calls' },
  { id: 'media', icon: Image, title: 'Media' },
  { id: 'backup', icon: HardDrive, title: 'Backup storage', note: 'Encrypted chat backup' },
  { id: 'messages', icon: MessageSquare, title: 'Messages' },
  { id: 'status', icon: CloudUpload, title: 'Status' },
  { id: 'roaming', icon: Globe, title: 'Roaming', note: 'Included above' },
];

function NetworkUsage({ onBack }) {
  const usage = useNetworkUsage();
  const [confirming, setConfirming] = useState(false);
  const totals = usageTotals(usage);
  const detail = (id) => {
    const row = usage[id];
    if (id === 'calls') return `${row.outgoing} outgoing · ${row.incoming} incoming`;
    if (id === 'messages') return `${row.countSent.toLocaleString()} sent · ${row.countReceived.toLocaleString()} received`;
    return USAGE_ROWS.find((item) => item.id === id)?.note ?? null;
  };
  return (
    <Panel title="Network usage" onBack={onBack} onClose={onBack}>
      <section className="hm-sd-usage-total" aria-label="Total usage">
        <small>Usage</small>
        <strong>{formatFileSize(totals.sent + totals.received) || '0 B'}</strong>
        <span><ArrowUpDown size={14} aria-hidden="true" /> {formatFileSize(totals.sent) || '0 B'} sent · {formatFileSize(totals.received) || '0 B'} received</span>
      </section>
      <ul className="hm-sd-usage">
        {USAGE_ROWS.map(({ id, icon: Icon, title }) => (
          <li key={id}>
            <Icon size={22} aria-hidden="true" />
            <span><strong>{title}</strong>{detail(id) && <small>{detail(id)}</small>}</span>
            <span className="hm-sd-usage-bytes"><small>↑ {formatFileSize(usage[id].sent) || '0 B'}</small><small>↓ {formatFileSize(usage[id].received) || '0 B'}</small></span>
          </li>
        ))}
      </ul>
      <p className="hm-muted">Counted on this device since {new Date(usage.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}. Group calls through the call server aren’t counted yet.</p>
      {confirming ? (
        <div className="hm-sd-reset">
          <span>Reset network usage statistics?</span>
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="is-danger" onClick={() => { resetUsage(); setConfirming(false); }}>Reset</button>
        </div>
      ) : <button type="button" className="hm-sd-reset-button" onClick={() => setConfirming(true)}>Reset statistics</button>}
    </Panel>
  );
}

// --- Auto-download rule dialog ---

function RuleDialog({ settingKey, onClose }) {
  const definition = SETTINGS[settingKey];
  const current = useSetting(settingKey);
  const [draft, setDraft] = useState(() => new Set(current));
  const toggle = (id) => setDraft((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <>
      <div className="hm-sd-scrim" onClick={onClose} aria-hidden="true" />
      <div className="hm-sd-dialog" role="dialog" aria-modal="true" aria-label={definition.label}>
        <h3>{definition.label}</h3>
        {definition.options.map((option) => (
          <label key={option.id}><input type="checkbox" checked={draft.has(option.id)} onChange={() => toggle(option.id)} /> {option.label}</label>
        ))}
        <div className="hm-sd-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={() => { appSettings().set(settingKey, definition.options.map((option) => option.id).filter((id) => draft.has(id))); onClose(); }}>OK</button>
        </div>
      </div>
    </>
  );
}

function QualityDialog({ onClose }) {
  const quality = useSetting('media.uploadQuality');
  return (
    <>
      <div className="hm-sd-scrim" onClick={onClose} aria-hidden="true" />
      <div className="hm-sd-dialog" role="dialog" aria-modal="true" aria-label="Media upload quality">
        <h3>Media upload quality</h3>
        {SETTINGS['media.uploadQuality'].options.map((option) => (
          <label key={option.id}><input type="radio" name="upload-quality" checked={quality === option.id} onChange={() => { appSettings().set('media.uploadQuality', option.id); onClose(); }} /> {option.label}</label>
        ))}
        <p className="hm-muted">{SETTINGS['media.uploadQuality'].hint}</p>
      </div>
    </>
  );
}

// Proxy (WhatsApp: Storage and data › Proxy): an HTTP proxy for when Hidden Messenger can't connect directly.
function ProxyDialog({ current, onClose, onSaved }) {
  const [host, setHost] = useState(current?.host ?? '');
  const [port, setPort] = useState(current?.port ? String(current.port) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(clear = false) {
    setBusy(true);
    setError('');
    try {
      const saved = await nativeSetProxy(clear ? '' : host.trim(), clear ? 0 : port);
      onSaved(saved);
      onClose();
    } catch (caught) {
      setError(caught?.message || 'The proxy could not be saved.');
      setBusy(false);
    }
  }
  return (
    <>
      <div className="hm-sd-scrim" onClick={onClose} aria-hidden="true" />
      <form className="hm-sd-dialog" role="dialog" aria-modal="true" aria-label="Proxy" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <h3>Set proxy</h3>
        <p className="hm-muted">Use a proxy only if Hidden Messenger can't connect on this network. Your messages stay end-to-end encrypted; the proxy sees only that you use Hidden Messenger.</p>
        <label className="hm-sd-field">Proxy host<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="proxy.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        <label className="hm-sd-field">Port<input value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))} inputMode="numeric" placeholder="8080" /></label>
        {error && <p className="hm-error" role="alert">{error}</p>}
        <div className="hm-sd-dialog-actions">
          {current?.host && <button type="button" onClick={() => save(true)} disabled={busy}>Remove</button>}
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !host.trim() || !port}>Save</button>
        </div>
      </form>
    </>
  );
}

// --- Storage and data ---

export default function StorageView({ onClose }) {
  const [view, setView] = useState('main');
  const [dialog, setDialog] = useState('');
  const quality = useSetting('media.uploadQuality');
  const mobile = useSetting(AUTO_DOWNLOAD_KEYS.mobile);
  const wifi = useSetting(AUTO_DOWNLOAD_KEYS.wifi);
  const roaming = useSetting(AUTO_DOWNLOAD_KEYS.roaming);
  const usage = useNetworkUsage();
  const [proxy, setProxy] = useState(null);
  useEffect(() => { if (nativeShell()) nativeGetProxy().then(setProxy).catch(() => {}); }, []);
  const [storedBytes, setStoredBytes] = useState(null);
  useEffect(() => { listStoredMedia().then((list) => setStoredBytes(list.reduce((total, item) => total + item.size, 0))).catch(() => {}); }, [view]);

  if (view === 'manage') return <ManageStorage onBack={() => setView('main')} />;
  if (view === 'network') return <NetworkUsage onBack={() => setView('main')} />;
  const totals = usageTotals(usage);
  return (
    <Panel title="Storage and data" onClose={onClose}>
      <div className="hm-sd-list">
        <Row icon={Folder} title="Manage storage" detail={storedBytes === null ? 'Counting…' : `${formatFileSize(storedBytes) || '0 B'} used`} onClick={() => setView('manage')} />
        <Row icon={ArrowUpDown} title="Network usage" detail={`${formatFileSize(totals.sent) || '0 B'} sent · ${formatFileSize(totals.received) || '0 B'} received`} onClick={() => setView('network')} />
      </div>
      <div className="hm-sd-list">
        <Row icon={Shield} title="Proxy" detail={!nativeShell() ? 'In the Android app' : proxy?.host ? `On · ${proxy.host}:${proxy.port}` : 'Off'} onClick={() => { if (nativeShell()) setDialog('proxy'); }} />
      </div>
      <div className="hm-sd-list">
        <Row icon={Image} title="Media upload quality" detail={optionLabel('media.uploadQuality', quality)} onClick={() => setDialog('quality')} />
      </div>
      <h4 className="hm-sd-heading">Media auto-download</h4>
      <p className="hm-muted hm-sd-note">Voice messages are always automatically downloaded. Media left off waits for a tap, and the server keeps it for 30 days.</p>
      <div className="hm-sd-list">
        <Row title="When using mobile data" detail={ruleSummary(mobile)} onClick={() => setDialog(AUTO_DOWNLOAD_KEYS.mobile)} chevron={false} />
        <Row title="When connected on Wi-Fi" detail={ruleSummary(wifi)} onClick={() => setDialog(AUTO_DOWNLOAD_KEYS.wifi)} chevron={false} />
        <Row title="When roaming" detail={ruleSummary(roaming)} onClick={() => setDialog(AUTO_DOWNLOAD_KEYS.roaming)} chevron={false} />
      </div>
      {dialog === 'quality' && <QualityDialog onClose={() => setDialog('')} />}
      {dialog === 'proxy' && <ProxyDialog current={proxy} onClose={() => setDialog('')} onSaved={setProxy} />}
      {dialog && dialog !== 'quality' && dialog !== 'proxy' && <RuleDialog settingKey={dialog} onClose={() => setDialog('')} />}
    </Panel>
  );
}


// Storage and data: what Hidden Messenger keeps on this device, media per chat (sizes from the server), clearing
// the media cache, and the photo upload quality.
import { useEffect, useState } from 'react';
import { HardDrive, Image, Mic, RefreshCw, Trash2 } from 'lucide-react';
import { useChatStore } from '../../store.js';
import { clearMediaCache, formatFileSize, isMediaContent, loadMediaInfo, mediaCacheStats, parseMediaRef } from '../../media.js';
import { parseVoiceContent } from '../../voice.js';
import { SETTINGS, appSettings, useSetting } from '../../settings.js';
import Panel, { Notice } from './Panel.jsx';

const MAX_SIZED = 300;

function chatBreakdown(messages) {
  let media = 0;
  let voice = 0;
  let textBytes = 0;
  const mediaIds = [];
  for (const message of messages) {
    const content = message?.content ?? '';
    if (isMediaContent(content)) {
      media += 1;
      const ref = parseMediaRef(content);
      if (ref?.id) mediaIds.push(ref.id);
    } else if (content.startsWith('voice:')) {
      voice += 1;
      const parsed = parseVoiceContent(content);
      if (parsed?.id) mediaIds.push(parsed.id);
    } else textBytes += content.length;
  }
  return { count: messages.length, media, voice, textBytes, mediaIds };
}

/** Sizes of the given uploads from the server (4 at a time, at most MAX_SIZED). */
async function sumSizes(ids, sessionToken, onProgress) {
  let total = 0;
  let done = 0;
  const queue = ids.slice(0, MAX_SIZED);
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        total += Number((await loadMediaInfo(id, sessionToken))?.size) || 0;
      } catch { /* deleted or expired upload */ }
      done += 1;
      onProgress(done);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return total;
}

export default function StorageView({ onClose }) {
  const messages = useChatStore((state) => state.messages);
  const chats = useChatStore((state) => state.chats);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const userId = useChatStore((state) => state.userId);
  const quality = useSetting('media.uploadQuality');
  const [estimate, setEstimate] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const [cache, setCache] = useState(() => mediaCacheStats());
  const [sizes, setSizes] = useState({});
  const [notice, setNotice] = useState('');

  useEffect(() => {
    navigator.storage?.estimate?.().then(setEstimate).catch(() => {});
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  }, []);

  const rows = chats.filter((chat) => chat.id !== userId)
    .map((chat) => ({ chat, ...chatBreakdown(messages[chat.id] ?? []) }))
    .sort((left, right) => (sizes[right.chat.id]?.bytes ?? 0) - (sizes[left.chat.id]?.bytes ?? 0) || (right.media + right.voice) - (left.media + left.voice));

  async function measure(row) {
    setSizes((current) => ({ ...current, [row.chat.id]: { measuring: true, done: 0, total: Math.min(row.mediaIds.length, MAX_SIZED) } }));
    const bytes = await sumSizes(row.mediaIds, sessionToken, (done) => setSizes((current) => ({ ...current, [row.chat.id]: { ...current[row.chat.id], done } })));
    setSizes((current) => ({ ...current, [row.chat.id]: { bytes, partial: row.mediaIds.length > MAX_SIZED } }));
  }

  const usage = estimate?.usage ?? null;
  const quota = estimate?.quota ?? null;
  return (
    <Panel title="Storage and data" onClose={onClose}>
      <Notice notice={notice} />
      <section className="hm-storage-summary" aria-label="Storage on this device">
        <HardDrive size={28} aria-hidden="true" />
        <div>
          <strong>{usage === null ? 'Storage use unavailable' : `${formatFileSize(usage)} used on this device`}</strong>
          {quota !== null && <div className="hm-storage-bar" role="meter" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={usage ?? 0} aria-label="Storage used"><span style={{ width: `${Math.min(100, ((usage ?? 0) / quota) * 100)}%` }} /></div>}
          <small>{quota !== null ? `${formatFileSize(Math.max(0, quota - (usage ?? 0)))} available to Hidden Messenger. ` : ''}Messages, contacts and settings are stored here encrypted; photos and files stay on the server until you open them.</small>
          {persisted === false && (
            <button type="button" onClick={() => navigator.storage.persist().then((granted) => { setPersisted(granted); setNotice(granted ? 'Your chats will be kept even when the device is low on storage.' : 'The browser didn’t allow it.'); })}>Keep my chats when storage is low</button>
          )}
        </div>
      </section>

      <section className="hm-storage-section" aria-label="Media cache">
        <h4>Media cache</h4>
        <p className="hm-muted">{cache.files} {cache.files === 1 ? 'file' : 'files'} · {formatFileSize(cache.bytes)} held for quick viewing this session.</p>
        <button type="button" disabled={!cache.files} onClick={() => { clearMediaCache(); setCache(mediaCacheStats()); setNotice('Media cache cleared.'); }}><Trash2 size={16} /> Clear media cache</button>
      </section>

      <section className="hm-storage-section" aria-label="Media upload quality">
        <h4>{SETTINGS['media.uploadQuality'].label}</h4>
        <p className="hm-muted">{SETTINGS['media.uploadQuality'].hint}</p>
        <div className="hm-radio-list" role="radiogroup" aria-label="Photo upload quality">
          {SETTINGS['media.uploadQuality'].options.map((option) => (
            <label key={option.id}><input type="radio" name="upload-quality" checked={quality === option.id} onChange={() => appSettings().set('media.uploadQuality', option.id)} /> {option.label}</label>
          ))}
        </div>
      </section>

      <section className="hm-storage-section" aria-label="Chats">
        <h4>Chats</h4>
        <ul className="hm-catalog-list">
          {rows.map((row) => {
            const size = sizes[row.chat.id];
            return (
              <li key={row.chat.id}>
                <span>
                  <strong>{row.chat.name ?? row.chat.username}</strong>
                  <small className="hm-storage-counts">
                    {row.count} messages · <Image size={12} aria-hidden="true" /> {row.media} · <Mic size={12} aria-hidden="true" /> {row.voice}
                    {size?.bytes !== undefined && ` · ${formatFileSize(size.bytes)}${size.partial ? '+' : ''} of media`}
                    {size?.measuring && ` · measuring ${size.done}/${size.total}…`}
                  </small>
                </span>
                {row.mediaIds.length > 0 && !size?.measuring && size?.bytes === undefined && (
                  <button type="button" onClick={() => measure(row)} aria-label={`Measure media in chat with ${row.chat.name}`}><RefreshCw size={14} /> Size</button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Panel>
  );
}

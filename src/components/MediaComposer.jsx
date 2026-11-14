// The send preview for photos, videos and documents, as on WhatsApp: pick from the gallery (or a document), then see
// it full screen before it goes. Inspected on WhatsApp Business: a large preview, a strip of the picked items with
// "+" to add more and × to drop one, "Add a caption…" with the view once ① toggle (one photo or video), HD for photos
// and videos, the chat's name as the recipient chip, and a round send button counting the items. Each item keeps its
// own caption; photos and videos sent together become one album in the chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Plus, Send, X } from 'lucide-react';
import { formatFileSize } from '../media.js';
import { useBackHandler } from '../backStack.js';

const kindOf = (file) => (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file');
let nextKey = 0;
// Documents (Attach › Document) are sent exactly as picked, photos included, so they are shown as files.
const itemOf = (file, asDocument) => ({ key: `m${(nextKey += 1)}`, file, kind: asDocument ? 'file' : kindOf(file), caption: '' });

// Preview URLs for the items' photos and videos, made and released by one effect (safe when React runs it twice).
function useObjectUrls(items) {
  const [urls, setUrls] = useState({});
  useEffect(() => {
    const made = {};
    for (const item of items) if (item.kind !== 'file') made[item.key] = URL.createObjectURL(item.file);
    setUrls(made);
    return () => Object.values(made).forEach((url) => URL.revokeObjectURL(url));
  }, [items]);
  return urls;
}

// `added`: { version, files } from the parent's picker after "+" (onAddMore); each new version joins the strip.
export default function MediaComposer({ files, added = null, recipient, quality = 'standard', allowViewOnce = true, initialViewOnce = false, asDocuments = false, onAddMore, onClose, onSend }) {
  const [items, setItems] = useState(() => files.map((file) => itemOf(file, asDocuments)));
  const [current, setCurrent] = useState(0);
  const [hd, setHd] = useState(quality === 'hd');
  const [viewOnce, setViewOnce] = useState(initialViewOnce);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useBackHandler(true, onClose);
  // Only the files matter for previews: a caption edit keeps the same URLs.
  const fileList = useMemo(() => items.map(({ key, file, kind }) => ({ key, file, kind })), [items.map((entry) => entry.key).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const urls = useObjectUrls(fileList);

  const item = items[Math.min(current, items.length - 1)];
  const visual = items.some((entry) => entry.kind !== 'file');
  const canViewOnce = allowViewOnce && items.length === 1 && item?.kind !== 'file';
  const count = items.length;

  useEffect(() => {
    if (!added?.files?.length) return;
    setCurrent(itemsRef.current.length);
    setItems((list) => [...list, ...added.files.map((file) => itemOf(file, asDocuments))]);
  }, [added?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCaption = (value) => setItems((list) => list.map((entry, index) => (index === current ? { ...entry, caption: value } : entry)));
  function remove(index) {
    const rest = items.filter((_, at) => at !== index);
    if (rest.length === 0) { onClose(); return; }
    setItems(rest);
    setCurrent(Math.max(0, Math.min(current, rest.length - 1)));
  }
  function send() {
    onSend(items.map(({ file, kind, caption }) => ({ file, kind, caption: caption.trim() })), { hd, viewOnce: canViewOnce && viewOnce });
  }

  const stage = useMemo(() => {
    if (!item) return null;
    if (item.kind === 'image') return urls[item.key] ? <img className="mc-preview" src={urls[item.key]} alt="" /> : null;
    if (item.kind === 'video') return urls[item.key] ? <video className="mc-preview" src={urls[item.key]} controls playsInline /> : null;
    return (
      <div className="mc-document">
        <FileText size={56} aria-hidden="true" />
        <strong title={item.file.name}>{item.file.name}</strong>
        <span>{formatFileSize(item.file.size)} · {(item.file.name.split('.').pop() || 'file').toUpperCase()}</span>
      </div>
    );
  }, [item, urls]);

  if (!item) return null;
  return (
    <div className="media-composer" role="dialog" aria-modal="true" aria-label={`Send ${count === 1 ? (item.kind === 'file' ? 'document' : item.kind === 'video' ? 'video' : 'photo') : `${count} items`} to ${recipient}`}>
      <header className="mc-top">
        <button type="button" className="mc-icon" onClick={onClose} aria-label="Discard"><X size={26} /></button>
        <span className="mc-title">{item.kind === 'file' ? item.file.name : ''}</span>
        {visual && (
          <button type="button" className={`mc-hd${hd ? ' is-on' : ''}`} onClick={() => setHd((on) => !on)} aria-pressed={hd}
            aria-label={`HD media upload quality, currently ${hd ? 'HD' : 'Standard'}`}>HD</button>
        )}
      </header>
      <div className="mc-stage">{stage}</div>
      {(count > 1 || onAddMore) && (
        <div className="mc-strip" role="listbox" aria-label="Picked items">
          {items.map((entry, index) => (
            <span key={entry.key} className={`mc-thumb${index === current ? ' is-current' : ''}`}>
              <button type="button" role="option" aria-selected={index === current} onClick={() => setCurrent(index)} aria-label={`Item ${index + 1}: ${entry.file.name}`}>
                {entry.kind === 'image' ? <img src={urls[entry.key]} alt="" /> : entry.kind === 'video' ? <video src={urls[entry.key]} muted playsInline preload="metadata" /> : <FileText size={24} />}
              </button>
              {index === current && count > 1 && <button type="button" className="mc-remove" onClick={() => remove(index)} aria-label={`Remove item ${index + 1}`}><X size={14} /></button>}
            </span>
          ))}
          {onAddMore && <button type="button" className="mc-add" onClick={onAddMore} aria-label="Add more"><Plus size={24} /></button>}
        </div>
      )}
      <div className="mc-caption">
        <input value={item.caption} onChange={(event) => setCaption(event.target.value)} placeholder="Add a caption…" aria-label="Caption" maxLength={1024}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); send(); } }} />
        {canViewOnce && (
          <button type="button" className={`mc-once${viewOnce ? ' is-on' : ''}`} onClick={() => setViewOnce((on) => !on)} aria-pressed={viewOnce}
            aria-label={viewOnce ? 'Turn off view once' : 'Turn on view once'}>1</button>
        )}
      </div>
      <footer className="mc-footer">
        <span className="mc-recipient">{recipient}</span>
        <button type="button" className="mc-send" onClick={send} aria-label={`Send ${count} ${count === 1 ? 'item' : 'items'}`}>
          <Send size={24} />
          {count > 1 && <span className="mc-count">{count}</span>}
        </button>
      </footer>
    </div>
  );
}

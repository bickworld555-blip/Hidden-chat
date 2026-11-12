import { memo, useEffect, useState } from 'react';
import { Clock, Search } from 'lucide-react';
import { STICKER_PACKS, loadRecentStickers, parseSticker, rememberSticker, stickerByKey } from '../../stickers.js';
import { gifFile, gifSearchEnabled, loadGif, searchGifs } from '../../gifs.js';

/** One sticker, drawn as a die-cut badge: big emoji and an outlined caption. */
export const StickerArt = memo(function StickerArt({ sticker, size = 140 }) {
  if (!sticker) return null;
  return (
    <svg className="hm-sticker-art" width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={sticker.caption || 'Sticker'}>
      <circle cx="100" cy="96" r="78" fill={sticker.tint} stroke="#ffffff" strokeWidth="10" />
      <text x="100" y={sticker.caption ? 108 : 122} textAnchor="middle" fontSize={sticker.caption ? 86 : 104} dominantBaseline="middle">{sticker.emoji}</text>
      {sticker.caption && (
        <text x="100" y="178" textAnchor="middle" fontSize={sticker.caption.length > 10 ? 24 : 30} fontWeight="800"
          fontFamily="system-ui, sans-serif" fill="#1f2937" stroke="#ffffff" strokeWidth="7" paintOrder="stroke" strokeLinejoin="round">
          {sticker.caption}
        </text>
      )}
    </svg>
  );
});

/** A sticker message (no bubble, like WhatsApp). */
export function StickerMessage({ content, children }) {
  const sticker = parseSticker(content);
  return (
    <div className="hm-sticker-message">
      {sticker?.unknown ? <span className="hm-sticker-unknown">🏷️ Sticker</span> : <StickerArt sticker={sticker} />}
      {children}
    </div>
  );
}

/** A GIF preview, loaded through our server (an <img> cannot send the session, so the bytes become a blob URL). */
function GifThumb({ token, gif, onPick, disabled }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    loadGif(token, gif.preview, { signal: controller.signal }).then((blob) => { url = URL.createObjectURL(blob); setSrc(url); }).catch(() => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [token, gif.preview]);
  return (
    <button type="button" className="hm-gif-thumb" disabled={disabled} aria-label={`Send GIF ${gif.title || ''}`.trim()} onClick={() => onPick(gif)}
      style={{ aspectRatio: `${gif.width} / ${gif.height}` }}>
      {src ? <img src={src} alt="" /> : <span className="hm-gif-loading" aria-hidden="true" />}
    </button>
  );
}

/** GIF search (GIPHY through our server): trending first, then what is typed; a pick is sent as an attachment. */
function GifPanel({ token, onGif }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [next, setNext] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      searchGifs(token, query, 0, { signal: controller.signal })
        .then((body) => { setGifs(body.gifs ?? []); setNext(body.next ?? null); })
        .catch((caught) => { if (caught.name !== 'AbortError') setError(caught.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 350 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [token, query]);
  async function more() {
    if (next === null || loading) return;
    setLoading(true);
    try {
      const body = await searchGifs(token, query, next);
      setGifs((current) => [...current, ...(body.gifs ?? []).filter((gif) => !current.some((item) => item.id === gif.id))]);
      setNext(body.next ?? null);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }
  async function pick(gif) {
    setSending(gif.id);
    setError('');
    try {
      await onGif(await gifFile(token, gif));
    } catch (caught) {
      setError(caught.message || 'That GIF could not be sent.');
    } finally {
      setSending('');
    }
  }
  return (
    <div className="hm-gif-panel">
      <label className="hm-gif-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search GIFs" aria-label="Search GIFs" maxLength={50} />
      </label>
      {error && <p className="hm-sticker-empty" role="alert">{error}</p>}
      <div className="hm-gif-grid" aria-busy={loading}>
        {gifs.map((gif) => <GifThumb key={gif.id} token={token} gif={gif} onPick={pick} disabled={Boolean(sending)} />)}
        {!loading && !error && gifs.length === 0 && <p className="hm-sticker-empty">No GIFs found.</p>}
      </div>
      <div className="hm-gif-footer">
        {next !== null && gifs.length > 0 && <button type="button" className="hm-gif-more" onClick={more} disabled={loading}>{loading ? 'Loading…' : 'More GIFs'}</button>}
        <span className="hm-gif-attribution">{sending ? 'Sending GIF…' : 'Powered by GIPHY'}</span>
      </div>
    </div>
  );
}

/** Sticker picker: recents plus the built-in packs, and GIF search when the server offers it (`onGif` + `token`). */
export function StickerPalette({ onPick, onGif, token }) {
  const [recents, setRecents] = useState(() => loadRecentStickers());
  const [tab, setTab] = useState(recents.length ? 'recent' : STICKER_PACKS[0].id);
  const [gifsOn, setGifsOn] = useState(false);
  useEffect(() => {
    let active = true;
    if (onGif && token) gifSearchEnabled(token).then((enabled) => { if (active) setGifsOn(enabled); });
    return () => { active = false; };
  }, [onGif, token]);
  const list = tab === 'recent' ? recents.map(stickerByKey).filter(Boolean) : STICKER_PACKS.find((pack) => pack.id === tab)?.stickers.map((item) => stickerByKey(`${tab}/${item.id}`)) ?? [];
  return (
    <div className="hm-sticker-palette" role="dialog" aria-label="Stickers and GIFs">
      <div className="hm-sticker-tabs" role="tablist">
        {gifsOn && <button type="button" role="tab" className="hm-gif-tab" aria-selected={tab === 'gif'} aria-label="GIFs" onClick={() => setTab('gif')}>GIF</button>}
        <button type="button" role="tab" aria-selected={tab === 'recent'} aria-label="Recent stickers" onClick={() => setTab('recent')}><Clock size={18} /></button>
        {STICKER_PACKS.map((pack) => (
          <button type="button" role="tab" key={pack.id} aria-selected={tab === pack.id} aria-label={pack.name} title={pack.name} onClick={() => setTab(pack.id)}>
            {pack.stickers[0].emoji}
          </button>
        ))}
      </div>
      {tab === 'gif' && gifsOn ? <GifPanel token={token} onGif={onGif} /> : (
      <div className="hm-sticker-grid">
        {tab === 'recent' && list.length === 0 && <p className="hm-sticker-empty">Stickers you send appear here.</p>}
        {list.map((item) => (
          <button type="button" key={item.key} aria-label={`Send sticker ${item.caption || item.emoji}`} onClick={() => { setRecents(rememberSticker(item.key)); onPick(item.key); }}>
            <StickerArt sticker={item} size={72} />
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

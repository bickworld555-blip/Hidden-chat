import { memo, useState } from 'react';
import { Clock } from 'lucide-react';
import { STICKER_PACKS, loadRecentStickers, parseSticker, rememberSticker, stickerByKey } from '../../stickers.js';

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

/** Sticker picker: recents plus the built-in packs. */
export function StickerPalette({ onPick }) {
  const [recents, setRecents] = useState(() => loadRecentStickers());
  const [tab, setTab] = useState(recents.length ? 'recent' : STICKER_PACKS[0].id);
  const list = tab === 'recent' ? recents.map(stickerByKey).filter(Boolean) : STICKER_PACKS.find((pack) => pack.id === tab)?.stickers.map((item) => stickerByKey(`${tab}/${item.id}`)) ?? [];
  return (
    <div className="hm-sticker-palette" role="dialog" aria-label="Stickers">
      <div className="hm-sticker-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'recent'} aria-label="Recent stickers" onClick={() => setTab('recent')}><Clock size={18} /></button>
        {STICKER_PACKS.map((pack) => (
          <button type="button" role="tab" key={pack.id} aria-selected={tab === pack.id} aria-label={pack.name} title={pack.name} onClick={() => setTab(pack.id)}>
            {pack.stickers[0].emoji}
          </button>
        ))}
      </div>
      <div className="hm-sticker-grid">
        {tab === 'recent' && list.length === 0 && <p className="hm-sticker-empty">Stickers you send appear here.</p>}
        {list.map((item) => (
          <button type="button" key={item.key} aria-label={`Send sticker ${item.caption || item.emoji}`} onClick={() => { setRecents(rememberSticker(item.key)); onPick(item.key); }}>
            <StickerArt sticker={item} size={72} />
          </button>
        ))}
      </div>
    </div>
  );
}

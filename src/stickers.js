// Sticker packs that ship with Hidden Messenger (original artwork: a die-cut emoji with a caption, drawn as SVG at
// render time, so they cost nothing to download). A sticker message is "sticker:<pack>/<id>".
export const STICKER_PREFIX = 'sticker:';
const RECENTS_KEY = 'hm:sticker-recents';
const MAX_RECENTS = 16;

const sticker = (id, emoji, caption = '', tint = '#ffffff') => ({ id, emoji, caption, tint });

export const STICKER_PACKS = Object.freeze([
  {
    id: 'moods',
    name: 'Moods',
    stickers: [
      sticker('yay', '😄', 'Yay!', '#fff3c4'), sticker('love', '😍', 'Love it', '#ffd9e2'), sticker('lol', '😂', 'LOL', '#fff3c4'),
      sticker('aww', '🥺', 'Aww', '#e2ecff'), sticker('grr', '😤', 'Grr', '#ffe0d6'), sticker('cool', '😎', 'Cool', '#dff7ea'),
      sticker('hmm', '🤔', 'Hmm…', '#efe6ff'), sticker('zzz', '😴', 'Zzz', '#e2ecff'), sticker('party', '🥳', 'Party!', '#ffe9c7'),
      sticker('omg', '😱', 'OMG', '#ffe0d6'), sticker('wink', '😉', 'Wink', '#fff3c4'), sticker('cry', '😭', 'Sob', '#e2ecff'),
    ],
  },
  {
    id: 'replies',
    name: 'Quick replies',
    stickers: [
      sticker('ok', '👍', 'OK!', '#dff7ea'), sticker('thanks', '🙏', 'Thank you', '#fff3c4'), sticker('hi', '👋', 'Hi!', '#e2ecff'),
      sticker('omw', '🏃', 'On my way', '#ffe9c7'), sticker('late', '⏰', 'Running late', '#ffe0d6'), sticker('done', '✅', 'Done', '#dff7ea'),
      sticker('miss', '🤗', 'Miss you', '#ffd9e2'), sticker('congrats', '🎉', 'Congrats!', '#ffe9c7'), sticker('coffee', '☕', 'Coffee?', '#f3e6d8'),
      sticker('night', '🌙', 'Good night', '#e6e9ff'), sticker('morning', '☀️', 'Good morning', '#fff3c4'), sticker('call', '📞', 'Call me', '#e2ecff'),
    ],
  },
  {
    id: 'hearts',
    name: 'Hearts',
    stickers: [
      sticker('red', '❤️'), sticker('sparkle', '💖'), sticker('fire', '❤️‍🔥'), sticker('two', '💕'), sticker('gift', '💝'),
      sticker('mend', '❤️‍🩹'), sticker('green', '💚'), sticker('blue', '💙'), sticker('purple', '💜'), sticker('yellow', '💛'),
      sticker('hands', '🫶'), sticker('kiss', '😘'),
    ],
  },
]);

const BY_KEY = new Map(STICKER_PACKS.flatMap((pack) => pack.stickers.map((item) => [`${pack.id}/${item.id}`, { ...item, pack: pack.id, key: `${pack.id}/${item.id}` }])));

export const stickerContent = (key) => `${STICKER_PREFIX}${key}`;
export const isStickerContent = (content) => typeof content === 'string' && content.startsWith(STICKER_PREFIX);

/** The sticker a message shows, or { unknown: true } for one from a newer app version. */
export function parseSticker(content) {
  if (!isStickerContent(content)) return null;
  const key = content.slice(STICKER_PREFIX.length);
  return BY_KEY.get(key) ?? { unknown: true, key };
}

export function stickerPreview(content) {
  const found = parseSticker(content);
  return found && !found.unknown ? `${found.emoji} Sticker` : '🏷️ Sticker';
}

export function loadRecentStickers(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((key) => BY_KEY.has(key)).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export function rememberSticker(key, storage = globalThis.localStorage) {
  const next = [key, ...loadRecentStickers(storage).filter((item) => item !== key)].slice(0, MAX_RECENTS);
  try { storage?.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

export const stickerByKey = (key) => BY_KEY.get(key) ?? null;

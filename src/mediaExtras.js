// Message formats for view once photos/videos, video notes and stickers made from photos (MediaExtras.jsx draws them).
import { parseMediaRef } from './media.js';

export const VIEW_ONCE_PREFIX = 'viewonce:';
export const VIDEO_NOTE_PREFIX = 'vnote:';
export const CUSTOM_STICKER_PREFIX = 'csticker:';
export const VIDEO_NOTE_SECONDS = 60;

export const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|3gp|mkv)$/i;
export const refOf = (content, prefix) => (typeof content === 'string' && content.startsWith(prefix) ? content.slice(prefix.length) : null);
export const isViewOnceMedia = (content) => Boolean(refOf(content, VIEW_ONCE_PREFIX));
export const isMediaOpened = (content) => content === 'media-opened:';
export const isVideoNote = (content) => Boolean(refOf(content, VIDEO_NOTE_PREFIX));
export const isCustomSticker = (content) => Boolean(refOf(content, CUSTOM_STICKER_PREFIX));

/** Chat-list wording for the new formats (null for anything else). */
export function extrasPreview(content) {
  const once = refOf(content, VIEW_ONCE_PREFIX);
  if (once) return VIDEO_EXTENSIONS.test(parseMediaRef(once)?.filename ?? '') ? '① Video' : '① Photo';
  if (isMediaOpened(content)) return '① Opened';
  if (isVideoNote(content)) return '📹 Video note';
  if (isCustomSticker(content)) return '🎨 Sticker';
  return null;
}


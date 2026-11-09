// Content another Android app shared to Hidden Messenger (a YouTube or Facebook link, text, photos, files), as the
// native shell reports it: { text, subject, files: [{ index, name, mimeType, size }] }.
import { firstLink } from './links.js';

export const SHARE_TARGET_LIMIT = 5;

// Normalises the native payload; null when there is nothing to send.
export function parseShare(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').trim();
  const subject = String(raw.subject ?? '').trim();
  // Apps put the link in the text and often a title in the subject; send the title too unless the text has it.
  const message = text && subject && !text.includes(subject) && firstLink(text) === text ? `${subject}\n${text}` : (text || subject);
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .filter((file) => Number.isInteger(file?.index) && file.index >= 0)
    .map((file) => ({
      index: file.index,
      name: String(file.name || 'shared-file'),
      mimeType: String(file.mimeType || 'application/octet-stream'),
      size: Number(file.size) >= 0 ? Number(file.size) : -1,
    }));
  if (!message && files.length === 0) return null;
  return { text: message.slice(0, 4000), files };
}

function kindOf(mimeType) {
  if (mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

// One line for the share sheet: "🔗 youtube.com/…", "📷 3 photos", "2 files".
export function shareSummary(share) {
  if (!share) return '';
  const { files, text } = share;
  if (files.length === 0) {
    const link = firstLink(text);
    return link && link.length >= text.length - 1 ? `🔗 ${link.replace(/^https?:\/\//i, '')}` : text;
  }
  const kinds = new Set(files.map((file) => kindOf(file.mimeType)));
  const only = kinds.size === 1 ? [...kinds][0] : 'file';
  const icon = { photo: '📷', video: '🎥', audio: '🎵', file: '📄' }[only];
  const noun = files.length === 1 ? (only === 'file' ? files[0].name : { photo: 'Photo', video: 'Video', audio: 'Audio' }[only]) : `${files.length} ${only === 'photo' ? 'photos' : `${only}s`}`;
  return `${icon} ${noun}`;
}

// What gets sent to each chosen chat, in order: every file, then the text (or the caption) as its own message.
export function shareSteps(share) {
  if (!share) return [];
  return [...share.files.map((file) => ({ kind: 'file', file })), ...(share.text ? [{ kind: 'text', text: share.text }] : [])];
}

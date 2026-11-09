// Content another Android app shared to Hidden Messenger (a YouTube or Facebook link, text, photos, files), as the
// native shell reports it: { text, subject, files: [{ index, name, mimeType, size }] }.
import { firstLink } from './links.js';
import { forwardSections } from './forwarding.js';

export const SHARE_TARGET_LIMIT = 5;
// How many recent chats appear in the share sheet's top row (ours and Android's).
export const RECENT_SHARE_COUNT = 8;

// "chat:<id>" / "group:<id>" from an Android share-sheet shortcut; null otherwise.
export function parseShareTarget(value) {
  const match = /^(chat|group):(.{1,128})$/.exec(typeof value === 'string' ? value : '');
  return match ? { kind: match[1], id: match[2] } : null;
}

// The people and groups chatted with most recently, newest first: the share sheet's one-tap row.
export function recentShareTargets(chats = [], groups = [], userId = '', limit = RECENT_SHARE_COUNT) {
  const time = (value) => (value ? new Date(value).getTime() || 0 : 0);
  return [
    ...chats.filter((chat) => chat?.id && chat.id !== userId && chat.lastActivityAt).map((chat) => ({ ...chat, kind: 'chat' })),
    ...groups.filter((group) => group?.id && group.lastActivityAt).map((group) => ({ ...group, kind: 'group' })),
  ]
    .sort((left, right) => time(right.lastActivityAt) - time(left.lastActivityAt))
    .slice(0, limit);
}

// The "Send to…" list, like WhatsApp's: "Frequently contacted" (chats you send to most), "Recent chats",
// "Groups", then "Other contacts". Each item carries its kind ('chat' | 'group').
export function shareSections({ chats = [], groups = [], messages = {}, userId = '', query = '' } = {}) {
  const needle = query.trim().replace(/^@+/, '').toLowerCase();
  const chatSections = forwardSections(chats, messages, userId, query).map((section) => ({
    id: section.id,
    title: section.title,
    items: section.chats.map((chat) => ({ ...chat, kind: 'chat' })),
  }));
  const groupItems = groups
    .filter((group) => group?.id && (!needle || String(group.name ?? '').toLowerCase().includes(needle)))
    .map((group) => ({ ...group, kind: 'group' }));
  const others = chatSections.findIndex((section) => section.id === 'others');
  const groupSection = groupItems.length ? [{ id: 'groups', title: 'Groups', items: groupItems }] : [];
  return others < 0 ? [...chatSections, ...groupSection] : [...chatSections.slice(0, others), ...groupSection, ...chatSections.slice(others)];
}

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
  return { text: message.slice(0, 4000), files, target: parseShareTarget(raw.target) };
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

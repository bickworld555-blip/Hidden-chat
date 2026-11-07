import { fileTone, parseMediaRef } from './media.js';
import { parseContact, parseLocation } from './geo.js';

// Contact info: what has been shared in a conversation, its text export, and per-chat wallpaper themes.

const SPECIAL_CONTENT = /^(media|voice|call|file|location|live|contact):/;
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;

export function sharedKind(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const ref = parseMediaRef(content);
  if (ref) return ['image', 'video'].includes(fileTone(ref.filename)) ? 'media' : 'doc';
  if (!SPECIAL_CONTENT.test(content) && LINK_PATTERN.test(content)) return 'link';
  return null;
}

// Newest first, like WhatsApp's "Media, links and docs" row.
export function sharedContent(messages) {
  const groups = { media: [], links: [], docs: [] };
  for (const message of messages ?? []) {
    const kind = sharedKind(message);
    if (kind === 'media') groups.media.unshift(message);
    else if (kind === 'doc') groups.docs.unshift(message);
    else if (kind === 'link') groups.links.unshift(message);
  }
  return { ...groups, total: groups.media.length + groups.links.length + groups.docs.length };
}

const pad = (value) => String(value).padStart(2, '0');

function exportTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function exportBody(content) {
  if (typeof content !== 'string') return '';
  const ref = parseMediaRef(content);
  if (ref) return `<attached: ${ref.filename}>`;
  if (content.startsWith('voice:')) return '<attached: voice message>';
  if (content.startsWith('location:')) {
    const location = parseLocation(content);
    return location ? `location: ${location.name ? `${location.name} ` : ''}https://maps.google.com/?q=${location.lat},${location.lon}` : 'location';
  }
  if (content.startsWith('live:')) return 'live location';
  if (content.startsWith('contact:')) {
    const contact = parseContact(content);
    return contact ? `Contact card: ${contact.name}${contact.username ? ` (@${contact.username})` : ''}` : 'Contact card';
  }
  if (content.startsWith('call:')) {
    try {
      const call = JSON.parse(content.slice(5));
      const kind = call?.mode === 'video' ? 'video call' : 'voice call';
      return call?.status === 'missed' ? `Missed ${kind}` : kind[0].toUpperCase() + kind.slice(1);
    } catch {
      return 'Call';
    }
  }
  return content;
}

// WhatsApp's "Export chat → Without media" text format, one line per message in this device's local time.
export function exportChatText(messages, { userId, selfName = 'You', peerName = 'Contact' }) {
  return (messages ?? [])
    .filter((message) => message?.id && !message.deleted)
    .map((message) => `${exportTimestamp(message.timestamp)} - ${message.senderId === userId ? selfName : peerName}: ${exportBody(message.content)}`)
    .join('\n');
}

export function exportFilename(peerName) {
  const safe = String(peerName ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Relay chat with ${safe || 'contact'}.txt`;
}

export const CHAT_THEMES = Object.freeze([
  { id: 'default', label: 'Default' },
  { id: 'sage', label: 'Sage' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'blush', label: 'Blush' },
  { id: 'sand', label: 'Sand' },
  { id: 'lavender', label: 'Lavender' },
  { id: 'night', label: 'Night' },
]);

export function chatThemeLabel(themeId) {
  return CHAT_THEMES.find((theme) => theme.id === themeId)?.label ?? 'Default';
}

// In-chat search covers what the user reads in bubbles: message text and shared file names, oldest first.
export function searchMessages(messages, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  return (messages ?? [])
    .filter((message) => {
      const content = typeof message?.content === 'string' ? message.content : '';
      const ref = parseMediaRef(content);
      const text = ref ? ref.filename : SPECIAL_CONTENT.test(content) ? '' : content;
      return text.toLowerCase().includes(needle);
    })
    .map((message) => message.id);
}

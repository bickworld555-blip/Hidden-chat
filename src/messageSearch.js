// Search across every chat, on this device. Messages are end-to-end encrypted, so the server cannot search
// them: direct chats come from the local store, groups are fetched and opened (src/e2e/client.js) when a
// search starts. A filter (Photos, Videos, Links, Documents, Audio, Polls) narrows by kind; text matches
// what people read (formatting markers ignored, file names for attachments, poll questions).
import { fileTone, parseMediaRef } from './media.js';
import { plainText } from './textFormat.js';
import { parsePollContent } from './polls.js';

export const SEARCH_FILTERS = [
  ['photos', 'Photos'], ['videos', 'Videos'], ['links', 'Links'], ['docs', 'Documents'], ['audio', 'Audio'], ['polls', 'Polls'],
];
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;
const SPECIAL = /^(media|emedia|voice|call|file|location|live|contact|poll|event|order|sticker|vonce|vnote|e2e2|relaycall|scheduledcall):/;

/** The kind of a message for filtering: photos | videos | audio | docs | links | polls | text | other. */
export function messageKind(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  if (message?.deleted || !content) return 'other';
  if (content.startsWith('voice:')) return 'audio';
  if (content.startsWith('poll:')) return 'polls';
  const ref = parseMediaRef(content);
  if (ref) {
    const tone = fileTone(ref.filename);
    return tone === 'image' ? 'photos' : tone === 'video' ? 'videos' : tone === 'audio' ? 'audio' : 'docs';
  }
  if (SPECIAL.test(content)) return 'other';
  return LINK.test(content) ? 'links' : 'text';
}

/** What a person reads for this message, used for matching and the result snippet. */
export function searchableText(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const kind = messageKind(message);
  if (kind === 'polls') return parsePollContent(content)?.question ?? 'Poll';
  if (['photos', 'videos', 'docs'].includes(kind) || (kind === 'audio' && !content.startsWith('voice:'))) return parseMediaRef(content)?.filename ?? '';
  if (kind === 'audio') return 'Voice message';
  if (kind === 'other') return '';
  return plainText(content);
}

/**
 * sources: [{ key, name, isGroup, messages }]. Returns the newest matches first (up to `limit`):
 * { key, name, isGroup, message, kind, text }. An empty query with a filter lists everything of that kind.
 */
export function searchAllMessages(sources, { query = '', filter = '', limit = 200 } = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle && !filter) return [];
  const results = [];
  for (const source of sources) {
    for (const message of source.messages ?? []) {
      const kind = messageKind(message);
      if (filter ? kind !== filter : !['text', 'links', 'photos', 'videos', 'docs', 'audio', 'polls'].includes(kind)) continue;
      const text = searchableText(message);
      if (needle && !text.toLowerCase().includes(needle)) continue;
      results.push({ key: source.key, name: source.name, isGroup: Boolean(source.isGroup), message, kind, text });
    }
  }
  results.sort((a, b) => new Date(b.message.timestamp ?? b.message.createdAt ?? 0) - new Date(a.message.timestamp ?? a.message.createdAt ?? 0));
  return results.slice(0, limit);
}

/** About 80 characters around the first match, with the matched part marked for highlighting. */
export function snippet(text, query) {
  const needle = query.trim().toLowerCase();
  const flat = text.replace(/\s+/g, ' ');
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return { before: flat.slice(0, 80), match: '', after: flat.length > 80 ? '…' : '' };
  const start = Math.max(0, at - 30);
  return { before: `${start > 0 ? '…' : ''}${flat.slice(start, at)}`, match: flat.slice(at, at + needle.length), after: `${flat.slice(at + needle.length, at + needle.length + 50)}${at + needle.length + 50 < flat.length ? '…' : ''}` };
}

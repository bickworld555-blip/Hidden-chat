// Search results across chats ("Messages" under the chat list while searching), and the kind filters
// (Photos, Videos, Links, Documents, Audio, Polls). Matching runs on this device (src/messageSearch.js).
import { useEffect, useMemo, useState } from 'react';
import { FileText, Image, Link2, Mic, ListChecks, Video } from 'lucide-react';
import { groupChatKey, loadAllSavedMessages, searchSavedMessages, useChatStore } from '../store.js';
import { presentName } from '../profile.js';
import { formatViewerTimestamp } from '../time.js';
import { fetchGroupMessages } from '../groupHistory.js';
import { SEARCH_FILTERS, searchAllMessages, snippet } from '../messageSearch.js';

const KIND_ICON = { photos: Image, videos: Video, links: Link2, docs: FileText, audio: Mic, polls: ListChecks };

export function SearchFilterChips({ filter, onChange }) {
  return (
    <div className="wa-chips wa-search-filters" role="tablist" aria-label="Search filters">
      {SEARCH_FILTERS.map(([id, label]) => {
        const Icon = KIND_ICON[id];
        return (
          <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(filter === id ? '' : id)}>
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        );
      })}
    </div>
  );
}

export default function MessageSearch({ query, filter, groups = [], onOpenChat, onOpenGroup }) {
  const token = useChatStore((state) => state.sessionToken);
  const userId = useChatStore((state) => state.userId);
  const chats = useChatStore((state) => state.chats);
  const messages = useChatStore((state) => state.messages);
  const [groupHistory, setGroupHistory] = useState(null);
  const active = Boolean(query.trim() || filter);
  const groupIds = groups.map((group) => group.id).join(',');

  // Search covers everything saved on this device (local-first: the server keeps messages only until delivered),
  // read once per search session: one-to-one chats and groups alike. What the server still holds for a group is
  // added on top.
  const [saved, setSaved] = useState(null);
  useEffect(() => {
    if (!active || saved || !userId) return undefined;
    let cancelled = false;
    loadAllSavedMessages(userId).then((all) => { if (!cancelled) setSaved(all); }).catch(() => { if (!cancelled) setSaved({}); });
    return () => { cancelled = true; };
  }, [active, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active || groupHistory || !token || !groups.length) return undefined;
    let cancelled = false;
    Promise.all(groups.slice(0, 50).map((group) => fetchGroupMessages(token, group.id).then((rows) => [group.id, rows]).catch(() => [group.id, []])))
      .then((entries) => { if (!cancelled) setGroupHistory(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [active, token, groupIds]); // eslint-disable-line react-hooks/exhaustive-deps
  // On the phone the full-text index answers first; its hits narrow what is scanned for snippets.
  const [indexed, setIndexed] = useState(null);
  useEffect(() => {
    const text = query.trim();
    if (!active || !text || !userId) { setIndexed(null); return undefined; }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchSavedMessages(userId, text, 500).then((rows) => { if (!cancelled) setIndexed(Array.isArray(rows) ? new Set(rows.map((row) => row.id)) : null); }).catch(() => {});
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, query, userId]);
  useEffect(() => { if (!active) { setGroupHistory(null); setSaved(null); } }, [active]);

  const results = useMemo(() => {
    if (!active) return [];
    const merge = (...lists) => {
      const byId = new Map();
      for (const list of lists) for (const message of list ?? []) if (message?.id) byId.set(message.id, message);
      const all = [...byId.values()];
      return indexed && !filter ? all.filter((message) => indexed.has(message.id)) : all;
    };
    const sources = [
      ...chats.map((chat) => ({ key: chat.id, name: presentName(chat) || chat.name || 'Unknown', messages: merge(saved?.[chat.id], messages[chat.id]) })),
      ...groups.map((group) => ({ key: group.id, name: group.name, isGroup: true, messages: merge(saved?.[groupChatKey(group.id)], messages[groupChatKey(group.id)], groupHistory?.[group.id]) })),
    ];
    return searchAllMessages(sources, { query, filter });
  }, [active, chats, messages, saved, indexed, groups, groupHistory, query, filter]);

  if (!active) return null;
  const loadingGroups = groups.length > 0 && !groupHistory;
  return (
    <section className="wa-message-results" aria-label="Messages">
      <div className="wa-section-label">Messages{results.length ? ` · ${results.length}${results.length === 200 ? '+' : ''}` : ''}</div>
      {results.map(({ key, name, isGroup, message, kind, text }) => {
        const part = snippet(text, query);
        const Icon = KIND_ICON[kind];
        const mine = message.senderId === userId;
        return (
          <button key={`${key}:${message.id}`} type="button" className="wa-row wa-message-result"
            onClick={() => (isGroup ? onOpenGroup?.(key) : onOpenChat?.(key, message.id))}>
            <span className="wa-row-body">
              <span className="wa-row-top"><strong>{name}</strong><time>{formatViewerTimestamp(message.timestamp ?? message.createdAt)}</time></span>
              <span className="wa-row-bottom">
                <span className="wa-preview">
                  {mine && <span className="wa-result-you">You: </span>}
                  {Icon && <Icon size={14} className="wa-result-kind" aria-hidden="true" />}
                  {part.before}{part.match && <mark>{part.match}</mark>}{part.after}
                </span>
              </span>
            </span>
          </button>
        );
      })}
      {!results.length && !loadingGroups && <div className="wa-note">{filter && !query.trim() ? 'Nothing of this kind in your chats yet' : 'No messages found'}</div>}
      {loadingGroups && <div className="wa-note">Searching groups…</div>}
    </section>
  );
}

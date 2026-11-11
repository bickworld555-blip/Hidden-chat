// Custom chat lists ("Customers", "Pending", "VIP"…): chips in the chat list, "Add to list" from a chat's
// long-press menu, and Settings › Lists to create, edit and delete them. Stored as a chat preference
// (store.js chatLists), kept on this device and in encrypted backups.
import { useMemo, useState } from 'react';
import { Check, ChevronRight, ListPlus, Pencil, Trash2, Users } from 'lucide-react';
import { useChatStore } from '../store.js';
import { presentName } from '../profile.js';
import Panel from './parity/Panel.jsx';
import Avatar from './Avatar.jsx';

export const LIST_NAME_MAX = 40;
export const listEntries = (lists) => Object.entries(lists ?? {}).sort(([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

function useConversations(groups) {
  const chats = useChatStore((state) => state.chats);
  return useMemo(() => [
    ...chats.map((chat) => ({ key: chat.id, name: presentName(chat) || chat.name || 'Unknown', chat })),
    ...groups.map((group) => ({ key: `group:${group.id}`, name: group.name, group: true })),
  ].sort((a, b) => a.name.localeCompare(b.name)), [chats, groups]);
}

/** Create or edit a list: its name and which chats are in it. */
export function ListEditor({ listId = '', groups = [], onClose, onSaved }) {
  const lists = useChatStore((state) => state.chatLists);
  const saveChatList = useChatStore((state) => state.saveChatList);
  const deleteChatList = useChatStore((state) => state.deleteChatList);
  const existing = listId ? lists?.[listId] : null;
  const [name, setName] = useState(existing?.name ?? '');
  const [keys, setKeys] = useState(() => new Set(existing?.keys ?? []));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const conversations = useConversations(groups);
  const taken = listEntries(lists).some(([id, list]) => id !== listId && list.name.trim().toLowerCase() === name.trim().toLowerCase());
  const toggle = (key) => setKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  function save(event) {
    event.preventDefault();
    if (!name.trim() || taken) return;
    const id = saveChatList(listId, { name, keys: [...keys] });
    onSaved?.(id);
    onClose?.();
  }
  return (
    <Panel title={listId ? 'Edit list' : 'New list'} onClose={onClose}>
      <form className="hm-form chat-list-editor" onSubmit={save}>
        <label>List name<input value={name} maxLength={LIST_NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder="For example Customers, Pending or VIP" autoFocus /></label>
        {taken && <p className="hm-error" role="alert">You already have a list called “{name.trim()}”.</p>}
        <h3 className="hm-section">Chats in this list · {keys.size}</h3>
        <ul className="chat-list-picker">
          {conversations.map(({ key, name: label, chat, group }) => (
            <li key={key}>
              <label>
                <input type="checkbox" checked={keys.has(key)} onChange={() => toggle(key)} />
                {group ? <span className="wa-group-avatar small" aria-hidden="true"><Users size={18} /></span>
                  : <Avatar name={label} initials={chat.initials ?? label.slice(0, 2).toUpperCase()} color={chat.color} image={chat.avatar} size="small" />}
                <span>{label}</span>
              </label>
            </li>
          ))}
          {!conversations.length && <li className="hm-muted">Start a chat first, then add it here.</li>}
        </ul>
        <button type="submit" className="groups-primary" disabled={!name.trim() || taken}>{listId ? 'Save' : 'Create list'}</button>
        {listId && (confirmDelete
          ? <button type="button" className="groups-danger" onClick={() => { deleteChatList(listId); onClose?.(); }}>Delete “{existing?.name}” (chats stay)</button>
          : <button type="button" className="groups-secondary" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete list</button>)}
      </form>
    </Panel>
  );
}

/** "Add to list" for one chat: tick the lists it belongs to, or make a new one. */
export function ListPicker({ chatKey, chatName, groups = [], onClose }) {
  const lists = useChatStore((state) => state.chatLists);
  const toggleChatInList = useChatStore((state) => state.toggleChatInList);
  const saveChatList = useChatStore((state) => state.saveChatList);
  const [newName, setNewName] = useState('');
  const entries = listEntries(lists);
  return (
    <Panel title="Add to list" subtitle={chatName} onClose={onClose}>
      <ul className="chat-list-picker">
        {entries.map(([id, list]) => {
          const inList = list.keys.includes(chatKey);
          return (
            <li key={id}>
              <button type="button" className="chat-list-pick" onClick={() => toggleChatInList(id, chatKey)} aria-pressed={inList}>
                <span className={`chat-list-check${inList ? ' is-on' : ''}`} aria-hidden="true">{inList && <Check size={14} />}</span>
                <span>{list.name}</span><small>{list.keys.length}</small>
              </button>
            </li>
          );
        })}
      </ul>
      <form className="hm-form chat-list-new" onSubmit={(event) => { event.preventDefault(); if (!newName.trim()) return; saveChatList('', { name: newName, keys: [chatKey] }); setNewName(''); }}>
        <label>New list<input value={newName} maxLength={LIST_NAME_MAX} onChange={(event) => setNewName(event.target.value)} placeholder="Name, then Add" /></label>
        <button type="submit" className="groups-primary" disabled={!newName.trim()}><ListPlus size={16} /> Add</button>
      </form>
      <p className="hm-muted">Lists show as chips above your chats. Manage them in Settings › Lists.</p>
    </Panel>
  );
}

/** Settings › Lists: every list with its size; tap to edit, or make a new one. */
export function ListsManager({ groups = [], onClose }) {
  const lists = useChatStore((state) => state.chatLists);
  const [editing, setEditing] = useState(null);
  if (editing !== null) return <ListEditor listId={editing} groups={groups} onClose={() => setEditing(null)} />;
  const entries = listEntries(lists);
  return (
    <Panel title="Lists" onClose={onClose}>
      <p className="hm-muted">Group chats into lists such as Customers, Pending or VIP. Each list becomes a filter above your chats.</p>
      <ul className="hm-menu-list">
        <li><button type="button" onClick={() => setEditing('')}><ListPlus size={22} aria-hidden="true" /><span><strong>New list</strong></span><ChevronRight size={16} aria-hidden="true" /></button></li>
        {entries.map(([id, list]) => (
          <li key={id}><button type="button" onClick={() => setEditing(id)}><Pencil size={20} aria-hidden="true" /><span><strong>{list.name}</strong><small>{list.keys.length} chat{list.keys.length === 1 ? '' : 's'}</small></span><ChevronRight size={16} aria-hidden="true" /></button></li>
        ))}
      </ul>
    </Panel>
  );
}

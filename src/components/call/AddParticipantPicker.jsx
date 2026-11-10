import { useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import { useChatStore } from '../../store.js';
import { matchesContact, rankCallContacts } from '../../callRoom.js';

// Loaded on first use (like WhatsApp's ViewStub panels): the call screen starts without it.
function ContactRow({ contact, onSelect }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(contact)}>
        <Avatar name={contact.name} initials={contact.initials ?? contact.name?.slice(0, 2).toUpperCase()} color={contact.color} image={contact.avatar} />
        <span>{contact.name}{contact.username && contact.name !== `@${contact.username}` ? <small>@{contact.username}</small> : null}</span>
      </button>
    </li>
  );
}

// "Add people" during a call: frequently contacted first, then everyone else, with search.
export default function AddParticipantPicker({ contacts, onSelect, onClose }) {
  const messages = useChatStore((state) => state.messages);
  const callLogs = useChatStore((state) => state.callLogs);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const visible = contacts.filter((person) => matchesContact(person, query));
  const { frequent, others } = rankCallContacts(visible, { messages, callLogs });
  return (
    <div className="wa-add-participant" role="dialog" aria-modal="true" aria-label="Add people">
      <header>
        <button type="button" className="wa-call-circle-btn" onClick={onClose} aria-label="Close"><ArrowLeft size={18} /></button>
        {searching ? (
          <input autoFocus className="wa-add-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or @handle" aria-label="Search contacts" />
        ) : (
          <span className="wa-add-title"><strong>Add people</strong><small>{contacts.length} contact{contacts.length === 1 ? '' : 's'}</small></span>
        )}
        <button type="button" className="wa-call-circle-btn" onClick={() => { setSearching((open) => !open); setQuery(''); }} aria-label={searching ? 'Close search' : 'Search'}>{searching ? <X size={18} /> : <Search size={18} />}</button>
      </header>
      {contacts.length === 0 && <p>Everyone you chat with is already in this call.</p>}
      {contacts.length > 0 && visible.length === 0 && <p>No contacts match “{query}”.</p>}
      <div className="wa-add-scroll">
        {frequent.length > 0 && <h3>Frequently contacted</h3>}
        <ul>{frequent.map((contact) => <ContactRow key={contact.id} contact={contact} onSelect={onSelect} />)}</ul>
        {others.length > 0 && <h3>{frequent.length ? 'Other contacts' : 'Contacts'}</h3>}
        <ul>{others.map((contact) => <ContactRow key={contact.id} contact={contact} onSelect={onSelect} />)}</ul>
      </div>
    </div>
  );
}

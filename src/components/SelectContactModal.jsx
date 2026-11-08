import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, Check, QrCode, Search, UserPlus, Users, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { linkContact, searchPeople } from '../contactsApi.js';
import { exactHandleMatch, isSavedContact, matchesPerson, mergeSuggestions, savedContacts, unsavedThreads } from '../contactBook.js';
import Avatar from './Avatar.jsx';

const SUGGEST_DEBOUNCE_MS = 180;

// Debounced people search against the server; `known` people are listed first in the merged suggestions.
function usePeopleSearch(query, sessionToken, { minLength = 1 } = {}) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const needle = query.trim().replace(/^@/, '');
  useEffect(() => {
    if (!sessionToken || needle.length < minLength) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchPeople(sessionToken, needle, { signal: controller.signal }));
      } catch (error) {
        if (error.name !== 'AbortError') setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [needle, sessionToken, minLength]);
  return { results, searching };
}

function PersonRow({ person, online, onChat, onAdd, busy, trailing }) {
  const saved = isSavedContact(person);
  return (
    <div className="wa-sc-contact-item wa-sc-suggestion">
      <Avatar name={person.name} initials={person.initials ?? person.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={person.color} image={person.avatar} online={online} />
      <div className="wa-sc-contact-info">
        <strong className="wa-sc-contact-name">{person.name ?? person.username}</strong>
        <span className="wa-sc-contact-status">@{person.username}{saved ? ' · In your contacts' : person.known ? ' · Recent chat' : ''}</span>
      </div>
      {trailing ?? (
        <div className="wa-sc-suggestion-actions">
          <button type="button" onClick={() => onChat(person)} disabled={busy} aria-label={`Chat with @${person.username}`}>Chat</button>
          {!saved && <button type="button" className="primary" onClick={() => onAdd(person)} disabled={busy} aria-label={`Add @${person.username} to contacts`}>Add</button>}
        </div>
      )}
    </div>
  );
}

export default function SelectContactModal({ isOpen, onClose, onSelectContact }) {
  const rawChats = useChatStore((state) => state.chats);
  const hiddenContacts = useChatStore((state) => state.hiddenContacts);
  const presence = useChatStore((state) => state.presence);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const userId = useChatStore((state) => state.userId);
  const addContact = useChatStore((state) => state.addContact);

  const [query, setQuery] = useState('');
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newHandle, setNewHandle] = useState('');
  const [addError, setAddError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [adding, setAdding] = useState(false);

  const searchInputRef = useRef(null);
  const newHandleInputRef = useRef(null);

  const saved = useMemo(() => savedContacts(rawChats, hiddenContacts, { userId }), [rawChats, hiddenContacts, userId]);
  const recent = useMemo(() => unsavedThreads(rawChats, { userId }), [rawChats, userId]);
  const known = useMemo(() => [...saved, ...recent], [saved, recent]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSaved = useMemo(() => saved.filter((person) => matchesPerson(person, normalizedQuery)), [saved, normalizedQuery]);
  const filteredRecent = useMemo(() => recent.filter((person) => matchesPerson(person, normalizedQuery)), [recent, normalizedQuery]);

  // Two searches: the header search bar (people not yet known) and the "Enter @username" box (live suggestions).
  const global = usePeopleSearch(query, sessionToken, { minLength: 2 });
  const handleSearch = usePeopleSearch(newHandle, sessionToken);
  const globalResults = useMemo(() => global.results.filter((person) => person.id !== userId && !known.some((item) => item.id === person.id)), [global.results, known, userId]);
  const suggestions = useMemo(() => mergeSuggestions(known, handleSearch.results.filter((person) => person.id !== userId), newHandle), [known, handleSearch.results, newHandle, userId]);
  const exact = exactHandleMatch(suggestions, newHandle);

  useEffect(() => {
    if (isOpen && showSearchInput) searchInputRef.current?.focus();
  }, [isOpen, showSearchInput]);

  useEffect(() => {
    if (isAddingNew) newHandleInputRef.current?.focus();
  }, [isAddingNew]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Opens a thread. `save` puts the person in the contact book; otherwise it is a direct chat that only lives
  // in the chat list. People already in the chat list need no server call.
  async function openWith(person, { save }) {
    setBusyId(person.id);
    setAddError('');
    try {
      const inList = (Array.isArray(rawChats) ? rawChats : []).some((chat) => chat.id === person.id);
      const needsServer = sessionToken && (!inList || (save && !isSavedContact(person)));
      const link = needsServer ? await linkContact(sessionToken, person.id, { save }) : person;
      await addContact(link);
      setIsAddingNew(false);
      setNewHandle('');
      onSelectContact(link);
      onClose();
    } catch (error) {
      setAddError(error.message || 'Could not open this chat.');
    } finally {
      setBusyId('');
    }
  }

  // The Add button: the typed handle must name a real person; suggestions are checked first, then the server.
  async function handleCreateNewContact(event) {
    event.preventDefault();
    const handle = newHandle.trim().replace(/^@/, '');
    if (!handle) return;
    setAdding(true);
    setAddError('');
    try {
      let match = exact;
      if (!match) {
        const results = await searchPeople(sessionToken, handle);
        match = results.find((person) => person.username?.toLowerCase() === handle.toLowerCase()) ?? null;
      }
      if (!match) throw new Error(`User @${handle} was not found on Hidden Messenger.`);
      await openWith(match, { save: true });
    } catch (error) {
      setAddError(error.message || 'Failed to add contact.');
    } finally {
      setAdding(false);
    }
  }

  const chatWith = (person) => openWith(person, { save: false });
  const addPerson = (person) => openWith(person, { save: true });

  return (
    <div className="wa-select-contact-overlay" role="dialog" aria-modal="true" aria-label="Select contact">
      <div className="wa-select-contact-container">
        <header className="wa-sc-header">
          <button type="button" className="wa-sc-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={22} />
          </button>
          <div className="wa-sc-title-wrap">
            <h2>Select contact</h2>
            <span className="wa-sc-subtitle">{saved.length} contact{saved.length === 1 ? '' : 's'}{recent.length ? ` · ${recent.length} recent` : ''}</span>
          </div>
          <div className="wa-sc-actions">
            <button type="button" className="wa-sc-icon-btn" onClick={() => setShowSearchInput((open) => !open)} aria-label="Search contacts">
              <Search size={20} />
            </button>
          </div>
        </header>

        {showSearchInput && (
          <div className="wa-sc-search-bar">
            <Search size={18} className="wa-sc-search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name or @username..."
              maxLength={64}
            />
            {query && (
              <button type="button" className="wa-sc-clear-btn" onClick={() => setQuery('')} aria-label="Clear">
                <X size={16} />
              </button>
            )}
          </div>
        )}

        <div className="wa-sc-scroll-body">
          {!normalizedQuery && (
            <div className="wa-sc-quick-actions">
              <button type="button" className="wa-sc-action-row" onClick={() => alert('Group chat creation is coming soon in Hidden Messenger!')}>
                <div className="wa-sc-action-icon green"><Users size={22} /></div>
                <div className="wa-sc-action-label"><strong>New group</strong></div>
              </button>
              <button type="button" className="wa-sc-action-row" onClick={() => setIsAddingNew((open) => !open)} aria-expanded={isAddingNew}>
                <div className="wa-sc-action-icon green"><UserPlus size={22} /></div>
                <div className="wa-sc-action-label"><strong>New contact</strong></div>
                <div className="wa-sc-action-extra"><QrCode size={20} /></div>
              </button>
              <button type="button" className="wa-sc-action-row" onClick={() => alert('Community creation is coming soon in Hidden Messenger!')}>
                <div className="wa-sc-action-icon green"><Building2 size={22} /></div>
                <div className="wa-sc-action-label"><strong>New community</strong></div>
              </button>
            </div>
          )}

          {isAddingNew && (
            <form className="wa-sc-add-form" onSubmit={handleCreateNewContact}>
              <div className="wa-sc-form-inner">
                <input
                  ref={newHandleInputRef}
                  type="text"
                  value={newHandle}
                  onChange={(event) => { setNewHandle(event.target.value); setAddError(''); }}
                  placeholder="Enter @username to add..."
                  aria-label="Username to add"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={adding}
                  maxLength={32}
                />
                <button type="submit" className="wa-sc-submit-btn" disabled={adding || !newHandle.trim()}>
                  {adding ? 'Adding...' : 'Add'}
                </button>
              </div>
              {newHandle.trim() && (
                <ul className="wa-sc-suggestions" aria-label="Suggestions" aria-live="polite">
                  {suggestions.map((person) => (
                    <li key={person.id}>
                      <PersonRow person={person} online={presence?.[person.id] === 'online'} onChat={chatWith} onAdd={addPerson} busy={busyId === person.id || adding} />
                    </li>
                  ))}
                  {!suggestions.length && (
                    <li className="wa-sc-loading-note">{handleSearch.searching ? 'Searching…' : `No one named @${newHandle.trim().replace(/^@/, '')} yet`}</li>
                  )}
                </ul>
              )}
              <span className="wa-sc-hint">Add saves them to your contacts. Chat starts a direct conversation without saving.</span>
              {addError && <span className="wa-sc-error-msg" role="alert">{addError}</span>}
            </form>
          )}

          <div className="wa-sc-section-heading"><span>Contacts on Hidden Messenger</span></div>
          <div className="wa-sc-contacts-list">
            {filteredSaved.map((contact) => (
              <button type="button" key={contact.id} className="wa-sc-contact-item" onClick={() => chatWith(contact)} disabled={busyId === contact.id}>
                <Avatar name={contact.name} initials={contact.initials ?? contact.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={contact.color} image={contact.avatar} online={presence?.[contact.id] === 'online'} />
                <div className="wa-sc-contact-info">
                  <strong className="wa-sc-contact-name">{contact.name ?? 'Unknown'}</strong>
                  <span className="wa-sc-contact-status">{contact.username ? `@${contact.username}` : 'Hey there! I am using Hidden Messenger'}</span>
                </div>
                <span className="wa-sc-saved-badge" aria-hidden="true"><Check size={14} /></span>
              </button>
            ))}
            {filteredSaved.length === 0 && (
              <div className="wa-sc-empty-state">
                <p>{normalizedQuery ? `No contacts found matching “${query}”` : 'No saved contacts yet. Add someone by @username above.'}</p>
              </div>
            )}
          </div>

          {filteredRecent.length > 0 && (
            <>
              <div className="wa-sc-section-heading"><span>Recent chats · not in contacts</span></div>
              <div className="wa-sc-contacts-list">
                {filteredRecent.map((person) => (
                  <PersonRow key={person.id} person={person} online={presence?.[person.id] === 'online'} onChat={chatWith} onAdd={addPerson} busy={busyId === person.id} />
                ))}
              </div>
            </>
          )}

          {normalizedQuery && (globalResults.length > 0 || global.searching) && (
            <div className="wa-sc-global-section">
              <div className="wa-sc-section-heading"><span>Find people on Hidden Messenger</span></div>
              {global.searching && <div className="wa-sc-loading-note">Searching...</div>}
              {globalResults.map((person) => (
                <PersonRow key={person.id} person={person} onChat={chatWith} onAdd={addPerson} busy={busyId === person.id} />
              ))}
            </div>
          )}
          {addError && !isAddingNew && <div className="wa-sc-error-msg" role="alert">{addError}</div>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, Search, Settings, Smile, Timer, UserPlus, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { matchesPerson, memberSections, savedContacts, unifiedContacts, unsavedThreads } from '../contactBook.js';
import { findPerson } from '../contactNames.js';
import { forwardSections } from '../forwarding.js';
import { handleFrom, lookupUsername } from '../contactsApi.js';
import { prepareAvatarBlob, uploadGroupAvatar } from '../avatar.js';
import { useBackHandler } from '../backStack.js';
import { useContactNames } from '../useContactNames.js';
import { usePhoneContacts } from './PhoneContactsSection.jsx';
import Avatar from './Avatar.jsx';

// New group in two steps, as WhatsApp does it: pick the members from your contacts (step 1), then name the group, set
// its photo, disappearing messages and permissions, and create it (step 2). The people are the contact picker's
// (contactBook.js unifiedContacts: saved contacts and phonebook matches, once each) plus recent chats; anyone else
// by their exact @username or 10-digit ID.
export const GROUP_NAME_MAX = 100;
const NAME_EMOJI = ['😀', '😂', '😍', '🥳', '😎', '🙏', '❤️', '🔥', '⭐', '🎉', '👨‍👩‍👧', '⚽', '🏏', '🎵', '📚', '💼', '🏠', '✈️', '🍕', '☕', '🌙', '🌸', '🤝', '🇧🇩'];
// The server's defaults for a new group (server/parity.mjs); only changes are sent after creating it.
const DEFAULT_PERMISSIONS = Object.freeze({ onlyAdminsEdit: false, onlyAdminsSend: false, membersCanAdd: false, approveJoins: false });

const label = (person) => person.name ?? (person.username ? `@${person.username}` : 'Unknown');


function MemberRow({ person, picked, onToggle }) {
  return (
    <button type="button" className="wa-sc-contact-item ng-member-row" role="checkbox" aria-checked={picked} onClick={() => onToggle(person)}>
      <Avatar name={label(person)} initials={person.initials ?? label(person).slice(0, 2).toUpperCase()} color={person.color} image={person.avatar} />
      <span className="wa-sc-contact-info">
        <strong className="wa-sc-contact-name">{label(person)}</strong>
        {person.username && <span className="wa-sc-contact-status">@{person.username}</span>}
      </span>
      <span className={`ng-check ${picked ? 'is-on' : ''}`} aria-hidden="true">{picked && <Check size={16} strokeWidth={3} />}</span>
    </button>
  );
}

function Toggle({ title, detail, on, onChange }) {
  return (
    <label className="ng-toggle">
      <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

const NO_IDS = Object.freeze([]);
const NO_ACTIONS = Object.freeze([]);

/** A picked person as the pickers keep them: enough to show a chip and an avatar. */
export const pickedPerson = (person) => ({ id: person.id, name: label(person), username: person.username, avatar: person.avatar, color: person.color, initials: person.initials });

/**
 * Pick people from your contacts, as WhatsApp's "Add members" does: a search box, the chosen people as chips, action
 * rows (`actions`: [{ icon, label, onClick }], such as "Invite via link or QR code"), then "Frequently contacted",
 * "Contacts on Hidden Messenger" and "Recent chats" with a round check each (every person once, contactBook.js
 * memberSections), and a round button that moves on. Used by New group (step 1) and by Add members in group info.
 * `excludeIds`: people who cannot be picked (already in the group).
 */
export function MemberPicker({ token, userId, title, picked, onToggle, onBack, onNext, nextLabel = 'Next', nextIcon = <ArrowRight size={24} />, busy = false, excludeIds = NO_IDS, actions = NO_ACTIONS, notice = '' }) {
  useContactNames(); // re-render when a saved name changes
  const phone = usePhoneContacts();
  const chats = useChatStore((state) => state.chats);
  const hiddenContacts = useChatStore((state) => state.hiddenContacts);
  const messages = useChatStore((state) => state.messages);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState([]);
  // Keyed by the ids themselves, not the array: a new array each render must not restart the lookup below.
  const excludedKey = excludeIds.join(',');
  const excluded = useMemo(() => new Set([userId, ...excludedKey.split(',').filter(Boolean)]), [userId, excludedKey]);

  const contacts = useMemo(() => unifiedContacts(savedContacts(chats, hiddenContacts, { userId }), phone.registered,
    { userId, aliasFor: (id) => findPerson(id, useChatStore.getState())?.alias }), [chats, hiddenContacts, phone.registered, userId]);
  const recent = useMemo(() => {
    const listed = new Set(contacts.map((person) => person.id));
    return unsavedThreads(chats, { userId }).filter((person) => !listed.has(person.id));
  }, [chats, contacts, userId]);
  const frequent = useMemo(() => {
    const direct = (chats ?? []).filter((chat) => chat?.id && !chat.group && !chat.deleted && chat.id !== userId);
    return forwardSections(direct, messages, userId).find((section) => section.id === 'frequent')?.chats ?? [];
  }, [chats, messages, userId]);

  const needle = query.trim().toLowerCase();
  const visible = (list) => list.filter((person) => !excluded.has(person.id)
    && (matchesPerson(person, needle) || (person.phonebookName ?? '').toLowerCase().includes(needle)));

  // Someone not in the lists: their exact @username or 10-digit ID.
  useEffect(() => {
    const handle = handleFrom(query);
    if (!handle || !token) { setFound([]); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lookupUsername(token, handle, { signal: controller.signal })
        .then((person) => setFound(person && !excluded.has(person.id) ? [person] : []))
        .catch(() => setFound([]));
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, token, excluded]);

  const isPicked = (person) => picked.some((item) => item.id === person.id);
  const sections = memberSections({ frequent: visible(frequent), contacts: visible(contacts), recent: visible(recent), found });
  return (
    <div className="ng-screen" role="dialog" aria-modal="true" aria-label={`${title}: choose people`}>
      <header className="wa-sc-header">
        <button type="button" className="wa-sc-back" onClick={onBack} aria-label="Back"><ArrowLeft size={22} /></button>
        <div className="wa-sc-title-wrap">
          <h2>{title}</h2>
          <span className="wa-sc-subtitle">{picked.length ? `${picked.length} selected` : 'Add members'}</span>
        </div>
      </header>
      <div className="wa-sc-search-bar ng-search">
        <Search size={18} className="wa-sc-search-icon" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, @username or ID" aria-label="Search people" maxLength={64} />
        {query && <button type="button" className="wa-sc-clear-btn" onClick={() => setQuery('')} aria-label="Clear"><X size={16} /></button>}
      </div>
      {picked.length > 0 && (
        <div className="ng-chips" aria-label="Selected members">
          {picked.map((person) => (
            <button type="button" key={person.id} className="ng-chip" onClick={() => onToggle(person)} aria-label={`Remove ${person.name}`}>
              <span className="ng-chip-avatar">
                <Avatar name={person.name} initials={person.initials ?? person.name.slice(0, 2).toUpperCase()} color={person.color} image={person.avatar} size="small" />
                <span className="ng-chip-x"><X size={11} strokeWidth={3} /></span>
              </span>
              <small>{person.name}</small>
            </button>
          ))}
        </div>
      )}
      <div className="wa-sc-scroll-body ng-scroll">
        {notice && <p className="ng-notice">{notice}</p>}
        {actions.map(({ icon: Icon, label: text, onClick }) => (
          <button type="button" key={text} className="wa-sc-action-row" onClick={onClick}>
            <div className="wa-sc-action-icon green"><Icon size={22} /></div>
            <div className="wa-sc-action-label"><strong>{text}</strong></div>
          </button>
        ))}
        {phone.available && !phone.granted && (
          <button type="button" className="wa-sc-action-row" onClick={() => phone.sync(true)} disabled={phone.status === 'syncing'}>
            <div className="wa-sc-action-icon green"><UserPlus size={22} /></div>
            <div className="wa-sc-action-label"><strong>{phone.status === 'syncing' ? 'Syncing…' : 'Sync phone contacts'}</strong></div>
          </button>
        )}
        {sections.map(([heading, list]) => (
          <section key={heading} aria-label={heading}>
            <div className="wa-sc-section-heading"><span>{heading}</span></div>
            {list.map((person) => <MemberRow key={`${heading}:${person.id}`} person={person} picked={isPicked(person)} onToggle={onToggle} />)}
          </section>
        ))}
        {!sections.length && (
          <div className="wa-sc-empty-state"><p>{needle ? 'No one found. Type their full @username or 10-digit ID.' : 'No contacts yet. Search by @username or ID to add people.'}</p></div>
        )}
      </div>
      <button type="button" className="ng-fab" onClick={onNext} disabled={busy || !picked.length} aria-label={nextLabel}>
        {busy ? <span className="ng-spinner" aria-hidden="true" /> : nextIcon}
      </button>
    </div>
  );
}

/**
 * `request(path, options)`: the groups API (GroupsView's groupRequest). `onCreated(groupId, warning)`: the group exists;
 * `warning` names a setting that could not be applied (the group itself is fine).
 */
export default function NewGroupFlow({ token, userId, initialMembers = [], request, onClose, onCreated }) {
  const [step, setStep] = useState('members');
  const [picked, setPicked] = useState(() => initialMembers);
  const [name, setName] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [photo, setPhoto] = useState(null); // { blob, url }
  const [disappearing, setDisappearing] = useState(false);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef(null);
  const fileRef = useRef(null);

  // Back walks the steps: permissions sheet → details → members → closed.
  useBackHandler(true, () => {
    if (permissionsOpen) setPermissionsOpen(false);
    else if (emojiOpen) setEmojiOpen(false);
    else if (step === 'details') setStep('members');
    else onClose();
  });
  useEffect(() => () => { if (photo?.url) URL.revokeObjectURL(photo.url); }, [photo]);

  const toggle = (person) => setPicked((current) => (current.some((item) => item.id === person.id)
    ? current.filter((item) => item.id !== person.id)
    : [...current, pickedPerson(person)]));

  async function choosePhoto(file) {
    setError('');
    try {
      const blob = await prepareAvatarBlob(file);
      setPhoto((previous) => { if (previous?.url) URL.revokeObjectURL(previous.url); return { blob, url: URL.createObjectURL(blob) }; });
    } catch (caught) {
      setError(caught.message || 'This image could not be used.');
    }
  }

  function insertEmoji(emoji) {
    const input = nameRef.current;
    const start = input?.selectionStart ?? name.length;
    const end = input?.selectionEnd ?? name.length;
    const next = `${name.slice(0, start)}${emoji}${name.slice(end)}`;
    if (next.length > GROUP_NAME_MAX) return;
    setName(next);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  }

  // Creates the group, then applies the photo and the settings. The group exists once the first call succeeds; a
  // setting that fails afterwards is reported, not undone.
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    let created;
    try {
      created = await request('', { method: 'POST', body: { name: name.trim(), memberIds: picked.map((person) => person.id) } });
    } catch (caught) {
      setError(caught.message || 'Could not create the group.');
      setBusy(false);
      return;
    }
    const path = `/${encodeURIComponent(created.id)}`;
    const failed = [];
    if (photo?.blob) await uploadGroupAvatar(created.id, photo.blob, token).catch(() => failed.push('the photo'));
    const changes = Object.fromEntries(Object.entries(permissions).filter(([key, value]) => value !== DEFAULT_PERMISSIONS[key]));
    if (Object.keys(changes).length) await request(`${path}/permissions`, { method: 'PUT', body: changes }).catch(() => failed.push('the permissions'));
    if (disappearing) await request(`${path}/member-settings`, { method: 'PUT', body: { autoDelete: true } }).catch(() => failed.push('disappearing messages'));
    setBusy(false);
    onCreated(created.id, failed.length ? `The group was created, but ${failed.join(' and ')} could not be set. Try again in group info.` : '');
  }

  if (step === 'members') {
    return <MemberPicker token={token} userId={userId} title="New group" picked={picked} onToggle={toggle} onBack={onClose} onNext={() => setStep('details')} />;
  }

  return (
    <div className="ng-screen" role="dialog" aria-modal="true" aria-label="New group: details">
      <header className="wa-sc-header">
        <button type="button" className="wa-sc-back" onClick={() => setStep('members')} aria-label="Back"><ArrowLeft size={22} /></button>
        <div className="wa-sc-title-wrap"><h2>New group</h2></div>
      </header>
      <div className="wa-sc-scroll-body ng-scroll ng-details">
        <div className="ng-identity">
          <button type="button" className="ng-photo" onClick={() => fileRef.current?.click()} aria-label={photo ? 'Change group photo' : 'Add group photo'}>
            {photo ? <img src={photo.url} alt="" /> : <Camera size={26} />}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) choosePhoto(file); }} />
          <div className="ng-name">
            <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value.slice(0, GROUP_NAME_MAX))} placeholder="Group name" aria-label="Group name" maxLength={GROUP_NAME_MAX} autoFocus />
            <button type="button" className="ng-emoji-btn" onClick={() => setEmojiOpen((open) => !open)} aria-label="Emoji" aria-expanded={emojiOpen}><Smile size={22} /></button>
          </div>
        </div>
        {emojiOpen && (
          <div className="ng-emoji" role="listbox" aria-label="Emoji">
            {NAME_EMOJI.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
          </div>
        )}
        <button type="button" className="ng-setting" onClick={() => setDisappearing((on) => !on)} aria-pressed={disappearing}>
          <span><strong>Disappearing messages</strong><small>{disappearing ? '24 hours' : 'Off'}</small></span>
          <Timer size={22} />
        </button>
        <button type="button" className="ng-setting" onClick={() => setPermissionsOpen(true)}>
          <span><strong>Group permissions</strong></span>
          <Settings size={22} />
        </button>
        <div className="wa-sc-section-heading"><span>Members: {picked.length || 'None'}</span></div>
        <div className="ng-members">
          {picked.map((person) => (
            <div key={person.id} className="ng-member">
              <Avatar name={person.name} initials={person.initials ?? person.name.slice(0, 2).toUpperCase()} color={person.color} image={person.avatar} />
              <small>{person.name}</small>
            </div>
          ))}
          <button type="button" className="ng-member ng-add" onClick={() => setStep('members')} aria-label="Add members">
            <span className="ng-add-icon"><UserPlus size={24} /></span>
            <small>Add</small>
          </button>
        </div>
        {error && <div className="wa-sc-error-msg" role="alert">{error}</div>}
      </div>
      <button type="button" className="ng-fab" onClick={create} disabled={busy || !name.trim()} aria-label="Create group">
        {busy ? <span className="ng-spinner" aria-hidden="true" /> : <Check size={26} />}
      </button>

      {permissionsOpen && (
        <div className="ng-sheet-backdrop" onClick={() => setPermissionsOpen(false)}>
          <div className="ng-sheet" role="dialog" aria-label="Group permissions" onClick={(event) => event.stopPropagation()}>
            <h3>Group permissions</h3>
            <p className="ng-sheet-caption">Members can:</p>
            <Toggle title="Edit group settings" detail="Name, photo, description and disappearing messages." on={!permissions.onlyAdminsEdit} onChange={(on) => setPermissions((current) => ({ ...current, onlyAdminsEdit: !on }))} />
            <Toggle title="Send new messages" on={!permissions.onlyAdminsSend} onChange={(on) => setPermissions((current) => ({ ...current, onlyAdminsSend: !on }))} />
            <Toggle title="Add other members" on={permissions.membersCanAdd} onChange={(on) => setPermissions((current) => ({ ...current, membersCanAdd: on }))} />
            <p className="ng-sheet-caption">Admins can:</p>
            <Toggle title="Approve new members" detail="Admins approve anyone who joins with an invite link." on={permissions.approveJoins} onChange={(on) => setPermissions((current) => ({ ...current, approveJoins: on }))} />
            <button type="button" className="groups-primary" onClick={() => setPermissionsOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { formatAccountNumber } from '../accountNumber.js';
import { useChatStore } from '../store.js';
import { MAX_CONTACT_NAME, joinContactName, resolveDisplayName, shortId, splitContactName } from '../contactNames.js';

/**
 * "Add to contacts" / "Edit contact": first and last name for a person, saved to this account's contact book.
 * `person` needs an id; name/username/alias are read from the store when the person is known there.
 */
export default function ContactNameSheet({ person, onClose, onSaved }) {
  const known = useChatStore((state) => state.chats.find((row) => row.id === person?.id) ?? state.hiddenContacts.find((row) => row.id === person?.id) ?? null);
  const subject = known ?? person ?? {};
  const alias = typeof subject.alias === 'string' ? subject.alias : '';
  const [{ first, last }, setName] = useState(() => splitContactName(alias));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef(null);
  const editing = Boolean(alias);
  // Their own name (never the saved one), so the person being named is recognisable.
  const profileName = resolveDisplayName({ ...subject, alias: '' });

  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function save(name) {
    setBusy(true);
    setError('');
    try {
      await useChatStore.getState().renameContact(person.id, { name, source: 'manual' });
      onSaved?.(name);
      onClose?.();
    } catch (failure) {
      setError(failure.message || 'Could not save this contact. Try again.');
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    const name = joinContactName(first, last);
    if (!name) { setError('Enter a first or last name.'); return; }
    save(name);
  }

  return (
    <div className="wa-info-dialog-backdrop" onClick={busy ? undefined : onClose}>
      <form className="wa-info-dialog contact-name-sheet" role="dialog" aria-modal="true" aria-label={editing ? 'Edit contact' : 'Add to contacts'} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>{editing ? 'Edit contact' : 'Add to contacts'}</h3>
        <p className="contact-name-sheet-who">
          <strong>{profileName}</strong>
          {subject.username && <small>@{subject.username}</small>}
          <small className="contact-name-sheet-id">ID {subject.number ? formatAccountNumber(subject.number) : shortId(person?.id)}</small>
        </p>
        <label className="contact-name-sheet-field">
          First name
          <input ref={firstRef} value={first} maxLength={MAX_CONTACT_NAME} autoComplete="off" onChange={(event) => setName((current) => ({ ...current, first: event.target.value }))} disabled={busy} />
        </label>
        <label className="contact-name-sheet-field">
          Last name
          <input value={last} maxLength={MAX_CONTACT_NAME} autoComplete="off" onChange={(event) => setName((current) => ({ ...current, last: event.target.value }))} disabled={busy} />
        </label>
        <p className="contact-name-sheet-hint">Only you see this name. It replaces their profile name in your chats, calls and notifications on all your devices.</p>
        {error && <p className="wa-info-error" role="alert">{error}</p>}
        <div className="wa-info-dialog-actions">
          {editing && <button type="button" className="wa-info-dialog-cancel contact-name-sheet-remove" onClick={() => save('')} disabled={busy}>Remove name</button>}
          <button type="button" className="wa-info-dialog-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="wa-info-dialog-confirm" disabled={busy}>Save</button>
        </div>
      </form>
    </div>
  );
}

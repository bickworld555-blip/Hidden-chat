// Contact naming, WhatsApp-style. Accounts have a unique id and a self-chosen profile name; what the app shows for
// a person is, in order: the name this user saved for them (in the app's contact book or synced from the phone's
// contacts), else their own profile name, else their @username, else their account number, else a shortened id. The saved name lives on the
// server per owner (contacts.alias), so every device of this account agrees, and nobody else ever sees it.
//
// Store rows keep both: `profileName` (the person's own name, as the server sends it) and `name` (what is shown).
// Views keep reading `chat.name`, which is why a saved name reaches every list, header, call screen and
// notification at once. No store import here: the server shares these rules.
import { normalizeDisplayName, presentName } from './profile.js';
import { formatAccountNumber } from './accountNumber.js';

export const MAX_CONTACT_NAME = 80;

/** Trims, collapses whitespace, drops control characters and caps the length. */
export function normalizeContactName(raw) {
  return normalizeDisplayName(raw).slice(0, MAX_CONTACT_NAME).trim();
}

/** "Nasir" + "Bhai" → "Nasir Bhai"; either part may be empty. */
export function joinContactName(first, last) {
  return normalizeContactName(`${first ?? ''} ${last ?? ''}`);
}

/** "Nasir Bhai" → { first: "Nasir", last: "Bhai" } (the first word is the first name, the rest the last name). */
export function splitContactName(name) {
  const whole = normalizeContactName(name);
  if (!whole) return { first: '', last: '' };
  const space = whole.indexOf(' ');
  return space < 0 ? { first: whole, last: '' } : { first: whole.slice(0, space), last: whole.slice(space + 1) };
}

/** A unique id shortened for display ("d90b8953…"), when nothing better is known about a person. */
export function shortId(id) {
  const value = String(id ?? '').trim();
  if (!value) return '';
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/**
 * The name to show for a person: saved name → their profile name → @username → short id.
 * `person` may be a store row ({ alias, profileName, name, username, id }) or a bare server user ({ name, username, id }).
 */
export function resolveDisplayName(person) {
  if (!person || typeof person !== 'object') return '';
  const alias = normalizeContactName(person.alias);
  if (alias) return alias;
  const profileName = typeof person.profileName === 'string' ? person.profileName : person.name;
  const profile = presentName({ ...person, name: profileName });
  if (profile) return profile;
  if (person.number) return formatAccountNumber(person.number);
  return shortId(person.id);
}

/**
 * A server link or persisted row → a store row with the naming fields in place. Idempotent: a row that already
 * carries `profileName` keeps it, so applying this again after a rename never loses the person's own name.
 */
export function withContactAlias(link) {
  if (!link || typeof link !== 'object') return link;
  const alias = normalizeContactName(link.alias);
  const profileName = typeof link.profileName === 'string' ? link.profileName : typeof link.name === 'string' ? link.name : '';
  return { ...link, alias, aliasSource: alias ? String(link.aliasSource ?? '') : '', profileName, name: alias || profileName };
}

/** A profile update from the server applied to a store row: the person's own name changes, a saved name stays. */
export function withProfileUpdate(row, user) {
  const profileName = typeof user?.name === 'string' ? user.name : row.profileName ?? row.name;
  return withContactAlias({ ...row, ...user, profileName, name: profileName, alias: row.alias, aliasSource: row.aliasSource });
}

/** The row for a person in the store's lists, or null. */
export function findPerson(id, state) {
  if (!id || !state) return null;
  return (state.chats ?? []).find((row) => row?.id === id)
    ?? (state.hiddenContacts ?? []).find((row) => row?.id === id)
    ?? state.knownPeople?.[id]
    ?? null;
}

let readState = () => null;
/** The store registers how to read its state, so getContactDisplayName(id) works without importing the store here. */
export function bindContactNameSource(reader) {
  readState = typeof reader === 'function' ? reader : () => null;
}

/**
 * getContactDisplayName(uniqueId): the one name resolver for chat lists, chat headers, call history, the call
 * screen, group member lists and notifications. `fallback` is what the caller already knows about the person (a
 * group member, a message's sender), used when they are not in this user's lists; a saved name still wins.
 */
export function getContactDisplayName(id, state = readState(), fallback = null) {
  const person = findPerson(id, state);
  const alias = normalizeContactName(person?.alias);
  if (alias) return alias;
  const source = fallback && (fallback.name || fallback.username) ? { ...fallback, id: fallback.id ?? id } : person;
  if (source) return resolveDisplayName(source) || shortId(id) || 'Unknown';
  return shortId(id) || 'Unknown';
}

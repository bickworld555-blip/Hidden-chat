// Sync phone contacts (Android app): WhatsApp-style "who in my phonebook is here", by Hidden Messenger ID.
//
// Hidden Messenger has no phone numbers. People save each other's 10-digit ID (src/accountNumber.js) in a phonebook
// entry: as a phone number, in the Note, or in a website / IM field. This reads the phonebook on the phone
// (DeviceContacts.java), finds those IDs, and asks the server which are accounts here (POST /api/v1/contacts/match).
//
// What leaves the phone: only the 10-digit IDs found, nothing else (no names, no phone numbers). The server keeps none
// of it. Results:
// - registered: phonebook entries whose ID is an account here, shown with the phonebook name, ready to message or call;
// - invite: entries with a phone number and no account here, with an Invite button (an SMS the person sends).
// A phonebook name becomes the contact's saved name (src/contactNames.js) unless the person typed a name in the app.
//
// One limit: a 10-digit phone number someone stored (10 digits, not starting with 0) has the same shape as an ID, so it
// is sent too and could, rarely, equal someone's ID. Every match therefore shows the account's own @username, so a
// wrong person is easy to spot before writing to them.
import { apiFetch } from './api.js';
import { accountNumberFrom } from './accountNumber.js';
import { normalizeContactName } from './contactNames.js';
import { nativeContactsPermission, nativeReadDeviceContacts, nativeRequestContacts } from './native.js';
import { useChatStore } from './store.js';

export const CONTACT_MATCH_BATCH = 500;
export const DEVICE_NAMES_KEY = 'hm.deviceNames';
// Digit runs that may be an ID: 10 digits, written with spaces, dots or dashes, maybe after a "+".
const DIGIT_RUN = /\+?\d[\d\s.-]{8,18}\d/g;

/** The IDs a phonebook field holds ("ID 804 994 3704", "8049943704", "804-994-3704"). */
export function accountNumbersIn(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(DIGIT_RUN)) {
    const number = accountNumberFrom(match[0].trim());
    if (number) found.add(number);
  }
  return [...found];
}

/** Phonebook entries → [{ key, name, numbers, phones }] (IDs in any field; phone fields kept for Invite). */
export function readPhonebook(contacts) {
  const entries = [];
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const name = normalizeContactName(contact?.name);
    if (!name) continue;
    const numbers = new Set();
    const phones = [];
    for (const field of Array.isArray(contact.fields) ? contact.fields : []) {
      for (const number of accountNumbersIn(field?.text)) numbers.add(number);
      if (field?.kind === 'phone' && typeof field.text === 'string' && field.text.trim()) phones.push(field.text.trim());
    }
    entries.push({ key: String(contact.id ?? name), name, numbers: [...numbers], phones });
  }
  return entries;
}

/**
 * Entries + server matches ([{ number, user }]) → { registered: [{ key, name, user }], invite: [{ key, name, phone }] }.
 * One row per account (the first phonebook name wins); myself left out; invite only for entries with a phone number.
 */
export function categorize(entries, matches, { userId = '' } = {}) {
  const byNumber = new Map((matches ?? []).filter((match) => match?.user?.id).map((match) => [match.number, match.user]));
  const registered = [];
  const invite = [];
  const seen = new Set();
  // The same person is often in the phonebook twice (SIM and Google account): one Invite per phone number, compared by
  // its last 10 digits so "+8801712…" and "01712…" are the same.
  const invited = new Set();
  const phoneKey = (phone) => String(phone).replace(/\D/g, '').slice(-10);
  for (const entry of entries) {
    const user = entry.numbers.map((number) => byNumber.get(number)).find(Boolean);
    if (user) {
      if (user.id !== userId && !seen.has(user.id)) { seen.add(user.id); registered.push({ key: entry.key, name: entry.name, user }); }
    } else if (entry.phones.length && !invited.has(phoneKey(entry.phones[0]))) {
      invited.add(phoneKey(entry.phones[0]));
      invite.push({ key: entry.key, name: entry.name, phone: entry.phones[0] });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { registered: registered.sort(byName), invite: invite.sort(byName) };
}

/**
 * Which registered people get their phonebook name as their saved name: those with no saved name, or whose saved
 * name came from the phonebook last time (`previous`, id → name) and changed there. A name typed in the app stays.
 */
export function planDeviceNames(registered, people, previous = {}) {
  const known = new Map((people ?? []).map((person) => [person.id, person]));
  const rename = [];
  for (const { user, name } of registered) {
    // Only people already in this account's lists: saving a name adds a contact, and a sync must never fill the chat
    // list by itself (people get the phonebook name when they are opened from the synced list).
    const person = known.get(user.id);
    if (!person) continue;
    const alias = person.alias ?? '';
    if (alias === name) continue;
    if (!alias || alias === previous[user.id]) rename.push({ userId: user.id, name });
  }
  return rename;
}

/** The server's matches for these IDs, in batches. */
export async function matchNumbers(sessionToken, numbers, { fetcher = apiFetch } = {}) {
  const unique = [...new Set(numbers)];
  const matches = [];
  for (let start = 0; start < unique.length; start += CONTACT_MATCH_BATCH) {
    const response = await fetcher('/api/v1/contacts/match', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: unique.slice(start, start + CONTACT_MATCH_BATCH) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || 'Could not check your contacts right now.');
    matches.push(...(body?.matches ?? []));
  }
  return matches;
}

function readPrevious(storage) {
  try { return JSON.parse(storage?.getItem(DEVICE_NAMES_KEY) ?? '{}') ?? {}; } catch { return {}; }
}
function savePrevious(storage, value) {
  try { storage?.setItem(DEVICE_NAMES_KEY, JSON.stringify(value)); } catch {}
}

/**
 * Asks for permission when `ask` (the person tapped Sync), reads the phonebook, matches IDs and applies phonebook
 * names. Returns { supported, permission, registered, invite, renamed, scanned }.
 */
export async function syncDeviceContacts({
  sessionToken,
  ask = false,
  userId = useChatStore.getState().userId,
  permission = nativeContactsPermission,
  request = nativeRequestContacts,
  read = nativeReadDeviceContacts,
  match = (numbers) => matchNumbers(sessionToken, numbers),
  people = () => [...useChatStore.getState().chats, ...useChatStore.getState().hiddenContacts, ...Object.values(useChatStore.getState().knownPeople ?? {})],
  rename = (id, name) => useChatStore.getState().renameContact(id, { name }),
  storage = globalThis.localStorage,
} = {}) {
  let state = await permission();
  if (state === null) return { supported: false, permission: null, registered: [], invite: [], renamed: 0, scanned: 0 };
  if (state !== 'granted' && ask) state = await request();
  if (state !== 'granted') return { supported: true, permission: state, registered: [], invite: [], renamed: 0, scanned: 0 };
  const entries = readPhonebook(await read());
  const numbers = entries.flatMap((entry) => entry.numbers);
  const matches = numbers.length ? await match(numbers) : [];
  const { registered, invite } = categorize(entries, matches, { userId });
  const previous = readPrevious(storage);
  let renamed = 0;
  for (const item of planDeviceNames(registered, people(), previous)) {
    try { await rename(item.userId, item.name); previous[item.userId] = item.name; renamed += 1; } catch {}
  }
  savePrevious(storage, previous);
  return { supported: true, permission: 'granted', registered, invite, renamed, scanned: entries.length };
}

/** The Invite SMS text: the download link and my ID, so they find me after installing. */
export function inviteText({ number = '', link = 'https://hiddenmessenger.com/download' } = {}) {
  const id = accountNumberFrom(number);
  return `Let's talk on Hidden Messenger, private chats and calls with no phone number. Get it: ${link}${id ? ` My ID: ${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}` : ''}`;
}

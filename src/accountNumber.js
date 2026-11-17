// Account numbers: every account's public numeric ID, 10 digits ("482 193 7765"), unique and random. People share it
// and save it (in this app's contacts, or by hand in the phone's contacts, where only digits fit a number field) and
// find each other by it, like an @username. It is not a phone number: no SMS, no phonebook upload.
//
// Internally an account keeps its UUID (messages, contacts, encryption keys and XMPP addresses are keyed by it); the
// number only names the account to people. Shared by the server (assignment, lookup) and the app (display, search).

export const ACCOUNT_NUMBER_DIGITS = 10;
export const ACCOUNT_NUMBER_PATTERN = /^[1-9]\d{9}$/;

/** A new random number: 10 digits, never starting with 0. `randomInt(min, max)` is node:crypto's (max exclusive). */
export function newAccountNumber(randomInt) {
  return String(randomInt(1_000_000_000, 10_000_000_000));
}

/** The number a search box or a pasted text holds ("482-193-7765", "+482 193 7765", "4821937765"), or ''. */
export function accountNumberFrom(query) {
  const text = String(query ?? '').trim();
  if (!/^\+?[\d\s.-]+$/.test(text)) return '';
  const digits = text.replace(/\D/g, '');
  return ACCOUNT_NUMBER_PATTERN.test(digits) ? digits : '';
}

/** "4821937765" → "482 193 7765" (groups of 3-3-4, easy to read out and type); anything else unchanged. */
export function formatAccountNumber(number) {
  const value = String(number ?? '');
  return ACCOUNT_NUMBER_PATTERN.test(value) ? `${value.slice(0, 3)} ${value.slice(3, 6)} ${value.slice(6)}` : value;
}

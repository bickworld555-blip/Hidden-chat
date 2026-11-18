// Sync phone contacts (src/deviceContacts.js, DeviceContacts.java, POST /api/v1/contacts/match): IDs found in the
// phonebook are matched to accounts; only IDs leave the phone; registered people show with the phonebook name and the
// rest get an Invite; a name typed in the app is never replaced, and a sync never fills the chat list by itself.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { accountNumbersIn, categorize, inviteText, matchNumbers, planDeviceNames, readPhonebook, syncDeviceContacts } from '../src/deviceContacts.js';
import { unifiedContacts } from '../src/contactBook.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-phonebook-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;

test('IDs are found however they were saved; phone numbers stay local for Invite', () => {
  assert.deepEqual(accountNumbersIn('HM ID: 804 994 3704'), ['8049943704']);
  assert.deepEqual(accountNumbersIn('804-994-3704 and 2898128666'), ['8049943704', '2898128666']);
  assert.deepEqual(accountNumbersIn('+880 1712-345678'), [], 'a Bangladeshi mobile number (13 digits) is not an ID');
  assert.deepEqual(accountNumbersIn('01712345678'), [], '11 digits with a leading 0 is not an ID');
  const entries = readPhonebook([
    { id: '1', name: 'Nasir Bhai', fields: [{ kind: 'phone', text: '804 994 3704' }] },
    { id: '2', name: 'Ammu', fields: [{ kind: 'phone', text: '+880 1712-345678' }, { kind: 'note', text: 'birthday in May' }] },
    { id: '3', name: 'Rana', fields: [{ kind: 'note', text: 'Hidden Messenger 289 812 8666' }] },
    { id: '4', name: '', fields: [{ kind: 'phone', text: '1234567890' }] },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.numbers, entry.phones]), [
    ['Nasir Bhai', ['8049943704'], ['804 994 3704']],
    ['Ammu', [], ['+880 1712-345678']],
    ['Rana', ['2898128666'], []],
  ], 'nameless entries skipped');
});

test('registered first (one row per account, phonebook name), the rest invited; myself left out', () => {
  const entries = readPhonebook([
    { id: '1', name: 'Nasir Bhai', fields: [{ kind: 'phone', text: '8049943704' }] },
    { id: '2', name: 'Nasir Office', fields: [{ kind: 'note', text: '8049943704' }] },
    { id: '3', name: 'Ammu', fields: [{ kind: 'phone', text: '+8801712345678' }] },
    { id: '4', name: 'Me', fields: [{ kind: 'phone', text: '1111111111' }] },
    { id: '5', name: 'Old friend', fields: [{ kind: 'phone', text: '5555555555' }] },
  ]);
  const matches = [{ number: '8049943704', user: { id: 'u-nasir', username: 'nasir' } }, { number: '1111111111', user: { id: 'me' } }];
  const { registered, invite } = categorize(entries, matches, { userId: 'me' });
  assert.deepEqual(registered.map((item) => [item.name, item.user.id]), [['Nasir Bhai', 'u-nasir']]);
  assert.deepEqual(invite.map((item) => [item.name, item.phone]), [['Ammu', '+8801712345678'], ['Old friend', '5555555555']], 'an ID-shaped number with no account is invited');
  assert.match(inviteText({ number: '8049943704' }), /hiddenmessenger\.com\/download.*My ID: 804 994 3704/);
});

test('phonebook names: never over a name typed in the app, follow phonebook edits, never add people by themselves', () => {
  const registered = [
    { name: 'Nasir Bhai', user: { id: 'a' } },
    { name: 'Rana P.', user: { id: 'b' } },
    { name: 'Salim', user: { id: 'c' } },
    { name: 'Stranger', user: { id: 'z' } },
  ];
  const people = [{ id: 'a', alias: '' }, { id: 'b', alias: 'Rana Ahmed' }, { id: 'c', alias: 'Salim old' }];
  assert.deepEqual(planDeviceNames(registered, people, { c: 'Salim old' }), [{ userId: 'a', name: 'Nasir Bhai' }, { userId: 'c', name: 'Salim' }],
    'a: no saved name; b: typed in the app, kept; c: came from the phonebook, updated; z: not in my lists, not added');
});

test('the server matches only IDs, under the lookup rules, and stores nothing', async () => {
  const me = await register('pb_me');
  const friend = await register('pb_friend');
  const hidden = await register('pb_hidden');
  await api('/api/v1/me/privacy', { token: hidden.token, method: 'PUT', body: { discoverableByUsername: false } });
  const fetcher = (path, options) => fetch(base + path, options);
  const matches = await matchNumbers(me.token, [friend.user.number, hidden.user.number, me.user.number, '1000000001'], { fetcher });
  assert.deepEqual(matches.map((match) => match.user.id), [friend.user.id], 'not the undiscoverable account, not myself, not unknown IDs');
  assert.equal((await api('/api/v1/contacts/match', { token: me.token, method: 'POST', body: { numbers: Array.from({ length: 501 }, (_, i) => String(2_000_000_000 + i)) } })).status, 400);
  assert.equal((await api('/api/v1/contacts/match', { method: 'POST', body: { numbers: [friend.user.number] } })).status, 401);
  assert.deepEqual((await api('/api/v1/contacts', { token: me.token })).body, [], 'matching adds nobody to my contacts');
});

test('the whole sync: permission only when asked, then registered and invite lists', async () => {
  let asked = false;
  const contacts = [{ id: '1', name: 'Nasir', fields: [{ kind: 'phone', text: '8049943704' }] }, { id: '2', name: 'Ammu', fields: [{ kind: 'phone', text: '+8801712345678' }] }];
  const common = { sessionToken: 't', userId: 'me', read: async () => contacts, match: async () => [{ number: '8049943704', user: { id: 'n' } }], people: () => [], rename: async () => {}, storage: null };
  const quiet = await syncDeviceContacts({ ...common, permission: async () => 'prompt', request: async () => { asked = true; return 'granted'; } });
  assert.deepEqual([quiet.permission, quiet.registered.length, asked], ['prompt', 0, false], 'opening the picker never asks');
  const tapped = await syncDeviceContacts({ ...common, ask: true, permission: async () => 'prompt', request: async () => { asked = true; return 'granted'; } });
  assert.deepEqual([asked, tapped.registered.map((r) => r.name), tapped.invite.map((r) => r.name)], [true, ['Nasir'], ['Ammu']]);
  assert.equal((await syncDeviceContacts({ ...common, permission: async () => null })).supported, false, 'outside the Android app');

  const java = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/DeviceContacts.java', import.meta.url), 'utf8');
  assert.ok(java.includes('ContactsContract.Data.CONTENT_URI') && java.includes('MAX_CONTACTS = 5000'));
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.ok(manifest.includes('android.permission.READ_CONTACTS') && !manifest.includes('READ_PHONE_NUMBERS') && !manifest.includes('SEND_SMS'), 'contacts only: no phone-number or SMS permission');
});

test('someone saved twice (SIM and Google account, "+880…" and "0…") is invited once', () => {
  const twice = categorize(readPhonebook([
    { id: 'a', name: '+8801324740609', fields: [{ kind: 'phone', text: '+8801324740609' }] },
    { id: 'b', name: '+8801324740609', fields: [{ kind: 'phone', text: '+880 1324-740609' }] },
    { id: 'c', name: 'Ammu', fields: [{ kind: 'phone', text: '01324740609' }] },
    { id: 'd', name: 'Abu', fields: [{ kind: 'phone', text: '01765342154' }] },
  ]), []);
  assert.deepEqual(twice.invite.map((item) => item.phone), ['+8801324740609', '01765342154']);
});

test('the picker lists each person on Hidden Messenger once: saved contacts and phonebook matches merge by account', () => {
  const saved = [
    { id: 'u-nasir', name: 'Nasir Bhai', username: 'nasir', saved: true },
    { id: 'u-rana', name: 'Rana', username: 'rana', saved: true },
  ];
  const registered = [
    { key: 'p1', name: 'Nasir (phone)', user: { id: 'u-nasir', username: 'nasir', name: '@nasir' } }, // saved too
    { key: 'p2', name: 'Abir Office', user: { id: 'u-abir', username: 'abir', name: '@abir' } },     // phone only
    { key: 'p3', name: 'Me', user: { id: 'u-me', username: 'me' } },                                 // my own ID
  ];
  const list = unifiedContacts(saved, registered, { userId: 'u-me', aliasFor: (id) => (id === 'u-abir' ? '' : '') });
  assert.deepEqual(list.map((person) => person.id), ['u-abir', 'u-nasir', 'u-rana'], 'once each, by name, never myself');
  const nasir = list.find((person) => person.id === 'u-nasir');
  assert.equal(nasir.name, 'Nasir Bhai', 'a saved contact keeps its saved name');
  assert.equal(nasir.saved, true);
  assert.equal(nasir.inPhone, true, 'and is known to be in the phonebook');
  const abir = list.find((person) => person.id === 'u-abir');
  assert.deepEqual([abir.name, abir.phonebookName, abir.saved, abir.inPhone], ['Abir Office', 'Abir Office', undefined, true], 'a phone-only match shows its phonebook name and is not saved yet');
  assert.equal(unifiedContacts([], registered, { userId: 'u-me', aliasFor: (id) => (id === 'u-abir' ? 'Abir (typed in app)' : '') })
    .find((person) => person.id === 'u-abir').name, 'Abir (typed in app)', 'a name typed in the app wins over the phonebook');
  assert.deepEqual(unifiedContacts(saved, [], { userId: 'u-me' }).map((person) => person.id), ['u-nasir', 'u-rana'], 'without a phone sync, the saved contacts');
});

test('the picker shows one contact list with chat, voice and video on every row, and the invite list last', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const picker = read('src/components/SelectContactModal.jsx');
  const phone = read('src/components/PhoneContactsSection.jsx');
  assert.ok(!picker.includes('From your phone') && !phone.includes('From your phone'), 'no second "from your phone" list');
  assert.match(picker, /unifiedContacts\(saved, phone\.registered/, 'saved contacts and phonebook matches are one list');
  assert.match(picker, /aria-label=\{`Message \$\{label\}`\}[\s\S]*aria-label=\{`Voice call \$\{label\}`\}[\s\S]*aria-label=\{`Video call \$\{label\}`\}/, 'chat, voice and video on each row');
  assert.match(picker, /!listed\.has\(person\.id\)/, 'a recent chat with someone in the list is not listed again');
  assert.ok(picker.lastIndexOf('<PhoneInviteSection') > picker.lastIndexOf('Recent chats · not in contacts'), 'the invite list comes last');
  assert.match(picker, /return props\.isOpen \? <SelectContactPicker/, 'the phonebook is read only once the picker is open');
});

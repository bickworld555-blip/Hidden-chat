// Account numbers (src/accountNumber.js): every account gets a unique random 10-digit public ID, found by lookup like
// an @username (same "Discoverable" and block rules), shown as the fallback name; saved contact names still win
// everywhere (src/contactNames.js).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { ACCOUNT_NUMBER_PATTERN, accountNumberFrom, formatAccountNumber, newAccountNumber } from '../src/accountNumber.js';
import { getContactDisplayName, resolveDisplayName } from '../src/contactNames.js';
import { handleFrom } from '../src/contactsApi.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-numbers-'));
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

test('numbers: 10 digits, never a leading zero; typed with spaces, dashes or a plus; shown 3-3-4', () => {
  assert.equal(newAccountNumber(() => 1_000_000_000), '1000000000');
  assert.equal(newAccountNumber(() => 9_999_999_999), '9999999999');
  assert.equal(accountNumberFrom('482 193 7765'), '4821937765');
  assert.equal(accountNumberFrom('482-193-7765'), '4821937765');
  assert.equal(accountNumberFrom('+4821937765'), '4821937765');
  for (const bad of ['0821937765', '48219377', '48219377651', 'rahim_42', '482 193 77a5', '']) assert.equal(accountNumberFrom(bad), '', bad);
  assert.equal(formatAccountNumber('4821937765'), '482 193 7765');
  assert.equal(handleFrom('482 193 7765'), '4821937765', 'every search box takes a number');
  assert.equal(handleFrom('@Rahim_42'), 'rahim_42', 'usernames still work');
});

test('every account gets a unique number, and people find each other by it', async () => {
  const alice = await register('num_alice');
  const bob = await register('num_bob');
  assert.match(alice.user.number, ACCOUNT_NUMBER_PATTERN, 'given at sign-up');
  assert.match(bob.user.number, ACCOUNT_NUMBER_PATTERN);
  assert.notEqual(alice.user.number, bob.user.number);
  assert.match(alice.user.id, /^[0-9a-f-]{36}$/, 'the internal id stays a UUID (keys, history and XMPP use it)');

  const found = await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { username: formatAccountNumber(bob.user.number) } });
  assert.equal(found.status, 200);
  assert.deepEqual([found.body.user.id, found.body.user.number], [bob.user.id, bob.user.number]);
  const byField = await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { number: bob.user.number } });
  assert.equal(byField.body.user.id, bob.user.id);
  assert.equal((await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { username: '1000000001' } })).status, 404);
  assert.equal((await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { username: alice.user.number } })).status, 404, 'not yourself');

  // Not discoverable: a stranger's number finds nothing, as with a username.
  const carol = await register('num_carol');
  assert.equal((await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { username: carol.user.number } })).status, 200);
  const off = await api('/api/v1/me/privacy', { token: carol.token, method: 'PUT', body: { discoverableByUsername: false } });
  assert.equal(off.status, 200);
  assert.equal((await api('/api/v1/users/lookup', { token: alice.token, method: 'POST', body: { username: carol.user.number } })).status, 404);
});

test('names: a saved name wins; then the profile name, the @username, the number; never a bare UUID when a number is known', () => {
  const state = { chats: [{ id: 'u1', alias: 'Nasir Bhai', name: 'Nasir Bhai', profileName: 'Nasir', number: '4821937765' }], hiddenContacts: [], knownPeople: { u2: { id: 'u2', number: '5551234567' } } };
  assert.equal(getContactDisplayName('u1', state), 'Nasir Bhai');
  assert.equal(getContactDisplayName('u1', state, { id: 'u1', name: 'Nasir (group name)' }), 'Nasir Bhai', 'over a group member\'s own name');
  assert.equal(resolveDisplayName({ id: 'u2', number: '5551234567' }), '555 123 4567');
  assert.equal(resolveDisplayName({ id: 'u3', username: 'rana', number: '5551234567' }), '@rana');
});

test('every view reads names through the resolver: group members, the call screen, call history', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(read('src/components/GroupsView.jsx'), /members: \(rawGroup\.members \?\? \[\]\)\.map\(\(member\) => \(\{ \.\.\.member, profileName: member\.profileName \?\? member\.name, name: contactName\(member\) \}\)\)/);
  const overlay = read('src/components/CallOverlay.jsx');
  assert.match(overlay, /const nameOf = \(peerId\) => contactName\(/);
  assert.match(overlay, /info: \{ \.\.\.known, name: contactName\(known\) \}/);
  assert.match(read('src/App.jsx'), /name: getContactDisplayName\(call\.peerId, useChatStore\.getState\(\), call\.peerInfo\)/);
  assert.match(read('src/components/CallsView.jsx'), /getContactDisplayName\(row\.peerId, useChatStore\.getState\(\)\)/);
  assert.match(read('src/components/ToolsView.jsx'), /<AccountNumber number=\{user\?\.number\}/, 'your own number in Settings, with copy');
});

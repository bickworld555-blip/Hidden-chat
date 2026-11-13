// No Email. No Number.: how people find each other without a phone number or an address book.
//   * exact @username lookup (POST /api/v1/users/lookup): no prefixes or display names, one answer for "missing",
//     "hidden" and "blocked", the name never in a URL, rate-limited per account;
//   * invite links (/api/v1/connect/*): 128-bit tokens kept only as SHA-256, limited uses, revocable;
//   * the website's account deletion (POST /api/v1/account/delete), which Google Play requires;
//   * strict end-to-end encryption: a strict server refuses what people write when it is not sealed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { refusesPlaintext } from './strictE2E.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const HOUR = 60 * 60 * 1000;
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-discovery-'));
  service = createChatServer({
    port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, strictE2E: true,
    abuseLimits: { trustProxyHops: 0, messages: [{ limit: 1000, windowMs: HOUR }], signups: [{ limit: 1000, windowMs: HOUR }], lookups: [{ limit: 12, windowMs: HOUR }] },
  });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, text: await response.clone().text(), data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}
async function register(prefix) {
  counter += 1;
  return (await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } })).data;
}
const lookup = (session, username) => api('/api/v1/users/lookup', { session, method: 'POST', body: { username } });

test('lookup finds exactly one handle; missing, hidden and blocked accounts give the same 404', async () => {
  const ana = await register('lka');
  const ben = await register('lkb');
  const cal = await register('lkc');
  assert.equal((await lookup(ana, `@${ben.user.username.toUpperCase()}`)).data.user.id, ben.user.id);
  assert.equal((await lookup(ana, 'lk')).status, 400, 'too short to be a username');
  assert.equal((await lookup(ana, ben.user.username.slice(0, -1))).status, 404, 'a prefix finds no one');

  const missing = await lookup(ana, 'nobody_by_this_name');
  // Ben turns off Discoverable by username: strangers can't find him, people already linked with him still can.
  assert.equal((await api('/api/v1/me/privacy', { session: ben, method: 'PUT', body: { discoverableByUsername: false } })).data.discoverableByUsername, false);
  assert.equal((await api('/api/v1/me/privacy', { session: ben, method: 'PUT', body: { discoverableByUsername: 'no' } })).status, 400);
  const hidden = await lookup(cal, ben.user.username);
  assert.deepEqual([hidden.status, hidden.text], [missing.status, missing.text], 'hidden looks exactly like missing');
  await api('/api/v1/contacts', { session: ana, method: 'POST', body: { userId: ben.user.id } });
  assert.equal((await lookup(ana, ben.user.username)).status, 200, 'a contact still finds him');

  // Blocked either way: the same 404.
  await api(`/api/v1/blocks/${cal.user.id}`, { session: ana, method: 'PUT' });
  const blocked = await lookup(cal, ana.user.username);
  assert.deepEqual([blocked.status, blocked.text], [missing.status, missing.text]);
  assert.equal((await lookup(ana, cal.user.username)).status, 404);
});

test('lookups are rate-limited per account, and the old prefix search is gone', async () => {
  const dan = await register('lkd');
  let status = 0;
  for (let attempt = 0; attempt < 13 && status !== 429; attempt += 1) status = (await lookup(dan, `ghost_${attempt}_x`)).status;
  assert.equal(status, 429, 'the hourly limit stops a scan');
  assert.equal((await api(`/api/v1/contacts/search?q=${dan.user.username}`, { session: dan })).status, 404);
});

test('invite links: hashed at rest, limited uses, revocable, never your own; redeeming links both people', async () => {
  const owner = await register('inv');
  const friend = await register('invf');
  const other = await register('invo');
  assert.equal((await api('/api/v1/connect/tokens', { session: owner, method: 'POST', body: { uses: 5 } })).status, 400);
  const link = (await api('/api/v1/connect/tokens', { session: owner, method: 'POST', body: { uses: 1 } })).data;
  assert.match(link.token, /^[A-Za-z0-9_-]{22}$/, '128 random bits');

  // The database holds only the token's SHA-256.
  const db = new DatabaseSync(join(directory, 'db.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT * FROM connect_tokens').all();
  db.close();
  assert.ok(rows.length > 0);
  assert.equal(JSON.stringify(rows).includes(link.token), false, 'no raw token at rest');

  assert.equal((await api('/api/v1/connect/redeem', { session: owner, method: 'POST', body: { token: link.token } })).data.code, 'own_invite');
  const redeemed = await api('/api/v1/connect/redeem', { session: friend, method: 'POST', body: { token: link.token } });
  assert.equal(redeemed.data.user.id, owner.user.id);
  const friendContacts = (await api('/api/v1/contacts', { session: friend })).data;
  const ownerContacts = (await api('/api/v1/contacts', { session: owner })).data;
  assert.equal(friendContacts.find((item) => item.id === owner.user.id)?.saved, true);
  assert.equal(ownerContacts.find((item) => item.id === friend.user.id)?.saved, true, 'both people are linked');
  assert.equal((await api('/api/v1/connect/redeem', { session: other, method: 'POST', body: { token: link.token } })).data.code, 'invite_invalid', 'one use only');
  assert.equal((await api('/api/v1/connect/redeem', { session: other, method: 'POST', body: { token: 'not a token' } })).status, 400);

  const shared = (await api('/api/v1/connect/tokens', { session: owner, method: 'POST', body: { uses: 10 } })).data;
  assert.deepEqual((await api('/api/v1/connect/tokens', { session: owner })).data.map((item) => [item.id, item.usesLeft]), [[shared.id, 10]], 'used-up links are not listed');
  assert.equal(JSON.stringify((await api('/api/v1/connect/tokens', { session: owner })).data).includes(shared.token), false, 'the token is shown once');
  assert.equal((await api(`/api/v1/connect/tokens/${shared.id}`, { session: owner, method: 'DELETE' })).status, 204);
  assert.equal((await api('/api/v1/connect/redeem', { session: other, method: 'POST', body: { token: shared.token } })).status, 404, 'revoked');
});

test('the website deletes an account with its username and password; a wrong password changes nothing', async () => {
  const gone = await register('webdel');
  const body = { username: gone.user.username, password: PASSWORD, confirm: 'DELETE' };
  assert.equal((await api('/api/v1/account/delete', { method: 'POST', body: { ...body, confirm: 'yes' } })).status, 400);
  const wrong = await api('/api/v1/account/delete', { method: 'POST', body: { ...body, password: 'Wrong-Password-12345' } });
  const unknown = await api('/api/v1/account/delete', { method: 'POST', body: { ...body, username: 'no_such_account' } });
  assert.deepEqual([wrong.status, wrong.text], [unknown.status, unknown.text], 'no hint whether the username exists');
  assert.equal((await api('/api/v1/me', { session: gone })).status, 200, 'still there');
  assert.equal((await api('/api/v1/account/delete', { method: 'POST', body })).status, 204);
  assert.equal((await api('/api/v1/me', { session: gone })).status, 401, 'signed out everywhere');
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: gone.user.username, password: PASSWORD } })).status, 401);
});

test('a strict server refuses readable messages people write, in chats and groups; system records pass', async () => {
  assert.equal(refusesPlaintext(true, 'hello'), true);
  assert.equal(refusesPlaintext(true, 'media:abc'), true, 'an attachment reference is something a person sent');
  assert.equal(refusesPlaintext(true, 'e2e2:sealed'), false);
  assert.equal(refusesPlaintext(true, 'call:audio:missed:0'), false, 'call logs are not people’s words');
  assert.equal(refusesPlaintext(false, 'hello'), false, 'off outside production');

  const ana = await register('ste');
  const ben = await register('stf');
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${ana.token}`, 'relay.v1']);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'plain-1', receiverId: ben.user.id, content: 'readable words' } }));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !events.some((event) => event.messageId === 'plain-1')) await new Promise((r) => setTimeout(r, 20));
  socket.close();
  assert.equal(events.find((event) => event.messageId === 'plain-1')?.code, 'e2e_required');
  assert.equal(events.some((event) => event.type === 'message:ack'), false, 'nothing stored');

  const group = (await api('/api/v1/groups', { session: ana, method: 'POST', body: { name: 'Strict', memberIds: [ben.user.id] } })).data;
  const sent = await api(`/api/v1/groups/${group.id}/messages`, { session: ana, method: 'POST', body: { content: 'readable group words' } });
  assert.deepEqual([sent.status, sent.data.code], [400, 'e2e_required']);
});

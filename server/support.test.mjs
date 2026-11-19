// Hidden Messenger Support (server/support.mjs): a person writes to support from the app, the support team reads and
// answers in the admin console, the answer reaches every device of that person at once, and nobody else sees it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { SUPPORT_HOURLY_LIMIT, SUPPORT_MESSAGE_MAX } from './support.mjs';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'support_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;
let cookie = '';

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-support-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminCredentials: ADMIN });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
  const login = await fetch(`${base}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify(ADMIN) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, admin = false, method = 'GET', body } = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(admin ? { Cookie: cookie, 'X-HM-Admin': '1' } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
function listen(session) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => socket.once('open', () => resolve(socket)));
}
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = check(); if (found) return found; await new Promise((r) => setTimeout(r, 20)); } return null; };

test('a question reaches the console, the answer reaches the person live, and the badge clears once read', async () => {
  const ava = await register('support_ava');
  const ben = await register('support_ben');
  const socket = await listen(ava);

  const sent = await api('/api/v1/support/messages', { token: ava.token, method: 'POST', body: { body: '  My photos won’t send.  ', start: true } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.body, 'My photos won’t send.');
  assert.equal(sent.body.fromSupport, false);
  assert.ok(await until(() => socket.events.find((event) => event.type === 'support:message' && event.message.id === sent.body.id)), 'the person’s other devices see it');

  assert.equal((await api('/api/admin/v1/live', { admin: true })).body.openSupport, 1, 'the console badge counts it');
  const threads = (await api('/api/admin/v1/support', { admin: true })).body.threads;
  assert.deepEqual(threads.map((thread) => [thread.user.username, thread.unread, thread.last.body]), [['support_ava', 1, 'My photos won’t send.']]);

  const opened = (await api(`/api/admin/v1/support/${ava.user.id}`, { admin: true })).body;
  assert.deepEqual(opened.messages.map((message) => message.body), ['My photos won’t send.']);
  assert.equal((await api('/api/admin/v1/live', { admin: true })).body.openSupport, 0, 'read by support');

  const reply = await api(`/api/admin/v1/support/${ava.user.id}`, { admin: true, method: 'POST', body: { body: 'Try again on Wi-Fi, then tell us.' } });
  assert.equal(reply.status, 201);
  assert.ok(await until(() => socket.events.find((event) => event.type === 'support:message' && event.message.fromSupport)), 'the answer arrives live');

  const mine = (await api('/api/v1/support/messages', { token: ava.token })).body.messages;
  assert.deepEqual(mine.map((message) => [message.fromSupport, message.body]), [[false, 'My photos won’t send.'], [true, 'Try again on Wi-Fi, then tell us.']]);
  assert.equal(mine[0].readBySupport, true);
  assert.deepEqual((await api('/api/v1/support/messages', { token: ben.token })).body.messages, [], 'nobody else sees it');
  socket.close();
});

test('support refuses empty, oversized and flooding messages, strangers and chat sessions in the console', async () => {
  const cy = await register('support_cy');
  assert.equal((await api('/api/v1/support/messages', { method: 'POST', body: { body: 'hi' } })).status, 401);
  assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: '   ' } })).status, 400);
  assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: 'x'.repeat(SUPPORT_MESSAGE_MAX + 1) } })).status, 400);
  assert.ok([401, 403, 404].includes((await api('/api/admin/v1/support', { token: cy.token })).status), 'a chat session is not an admin session');
  assert.equal((await api('/api/admin/v1/support/nobody', { admin: true, method: 'POST', body: { body: 'hello' } })).status, 404);
  for (let index = 0; index < SUPPORT_HOURLY_LIMIT; index += 1) {
    assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: `message ${index}`, start: index === 0 } })).status, 201);
  }
  assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: 'one more' } })).status, 429);
});

test('deleting the account deletes its support conversation', async () => {
  const dee = await register('support_dee');
  assert.equal((await api('/api/v1/support/messages', { token: dee.token, method: 'POST', body: { body: 'Please help.', start: true } })).status, 201);
  assert.equal((await api('/api/v1/me', { token: dee.token, method: 'DELETE', body: { password: PASSWORD, confirm: 'support_dee' } })).status, 204);
  const threads = (await api('/api/admin/v1/support', { admin: true })).body.threads;
  assert.equal(threads.some((thread) => thread.user.id === dee.user.id), false);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const upload = (bytes, name) => fetch(`${base}/api/admin/v1/support-media`, {
  method: 'POST', headers: { Cookie: cookie, 'X-HM-Admin': '1', 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: bytes,
}).then(async (response) => ({ status: response.status, body: await response.json() }));

test('a reply can carry a photo: only the console and that person can load it, and the pinned row shows it unread', async () => {
  const eve = await register('support_eve');
  const fay = await register('support_fay');
  assert.equal((await upload(Buffer.from('not a file we accept, at all'), 'x.exe')).status, 415);
  assert.equal((await fetch(`${base}/api/admin/v1/support-media`, { method: 'POST', headers: { 'X-HM-Admin': '1' }, body: PNG })).status, 401, 'admins only');
  const media = (await upload(PNG, '../../screens/how-to.png')).body.media;
  assert.deepEqual([media.type, media.kind, media.name, media.size], ['image/png', 'image', 'how-to.png', PNG.length], 'the name has no path');

  assert.equal((await api(`/api/admin/v1/support/${eve.user.id}`, { admin: true, method: 'POST', body: {} })).status, 400, 'text or a file');
  assert.equal((await api(`/api/admin/v1/support/${eve.user.id}`, { admin: true, method: 'POST', body: { mediaId: 'missing' } })).status, 400);
  const reply = await api(`/api/admin/v1/support/${eve.user.id}`, { admin: true, method: 'POST', body: { mediaId: media.id } });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.body, '');

  const summary = (await api('/api/v1/support/summary', { token: eve.token })).body;
  assert.deepEqual([summary.unread, summary.last.preview, summary.last.fromSupport], [1, '📷 Photo', true]);
  const [message] = (await api('/api/v1/support/messages', { token: eve.token })).body.messages;
  assert.equal(message.media.url, `/api/v1/support/media/${media.id}`);
  assert.equal((await api('/api/v1/support/summary', { token: eve.token })).body.unread, 0, 'opening the chat reads it');

  const seen = await fetch(base + message.media.url, { headers: { Authorization: `Bearer ${eve.token}` } });
  assert.deepEqual([seen.status, seen.headers.get('content-type'), Buffer.compare(Buffer.from(await seen.arrayBuffer()), PNG)], [200, 'image/png', 0]);
  assert.equal((await fetch(base + message.media.url, { headers: { Authorization: `Bearer ${fay.token}` } })).status, 404, 'not another person');
  assert.equal((await fetch(`${base}/api/admin/v1/support-media/${media.id}`, { headers: { Cookie: cookie, 'X-HM-Admin': '1' } })).status, 200);
});

test('a campaign reaches every active account live, stays out of the support inbox, and counts who saw it', async () => {
  const gil = await register('support_gil');
  const hal = await register('support_hal');
  const socket = await listen(hal);
  const before = (await api('/api/admin/v1/support', { admin: true })).body.threads.length;
  assert.equal((await api('/api/admin/v1/support-campaigns', { admin: true, method: 'POST', body: { body: '   ' } })).status, 400);
  const sent = await api('/api/admin/v1/support-campaigns', { admin: true, method: 'POST', body: { body: 'New: group photos are here.' } });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.recipients >= 2, 'everyone, not only people who wrote to support');

  const live = await until(() => socket.events.find((event) => event.type === 'support:message' && event.message.campaign));
  assert.equal(live?.message.body, 'New: group photos are here.', 'an open app shows it at once');
  assert.deepEqual((await api('/api/v1/support/summary', { token: gil.token })).body.last, { preview: 'New: group photos are here.', fromSupport: true, createdAt: live.message.createdAt });
  assert.equal((await api('/api/admin/v1/support', { admin: true })).body.threads.length, before, 'no new conversations in the inbox');

  await api('/api/v1/support/messages', { token: gil.token });
  const [campaign] = (await api('/api/admin/v1/support-campaigns', { admin: true })).body.campaigns;
  assert.deepEqual([campaign.body, campaign.recipients, campaign.seen], ['New: group photos are here.', sent.body.recipients, 1]);
  socket.close();
});

test('campaigns are read-only: no reply where only campaigns arrived, unless the person asks for help; open conversations stay two-way', async () => {
  const ivy = await register('support_ivy');
  const jon = await register('support_jon');
  await api(`/api/v1/support/messages`, { token: jon.token, method: 'POST', body: { body: 'Help with my account', start: true } });
  assert.equal((await api('/api/admin/v1/support-campaigns', { admin: true, method: 'POST', body: { body: 'Maintenance tonight at 2am.' } })).status, 201);

  const chat = (await api('/api/v1/support/messages', { token: ivy.token })).body;
  assert.equal(chat.replies, 'closed', 'only a campaign: the app shows no composer');
  assert.equal(chat.messages.at(-1).campaign, true);
  const reply = await api('/api/v1/support/messages', { token: ivy.token, method: 'POST', body: { body: 'ok thanks' } });
  assert.equal(reply.status, 403, 'a reply to a campaign is refused by the server too');
  assert.equal((await api('/api/admin/v1/support', { admin: true })).body.threads.some((thread) => thread.user.id === ivy.user.id), false);

  // Contact support: an explicit request for help opens a conversation, which is two-way from then on.
  assert.equal((await api('/api/v1/support/messages', { token: ivy.token, method: 'POST', body: { body: 'I need help with calls', start: true } })).status, 201);
  assert.equal((await api('/api/v1/support/messages', { token: ivy.token })).body.replies, 'open');
  assert.equal((await api('/api/v1/support/messages', { token: ivy.token, method: 'POST', body: { body: 'They drop after a minute' } })).status, 201);

  // Someone already talking with support keeps writing after a campaign arrives.
  assert.equal((await api('/api/v1/support/messages', { token: jon.token })).body.replies, 'open');
  assert.equal((await api('/api/v1/support/messages', { token: jon.token, method: 'POST', body: { body: 'Any news?' } })).status, 201);
});

test('the pinned Hidden Messenger chat hides the composer for campaigns; Help Center asks for help', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const help = read('src/components/HelpCenter.jsx');
  const list = read('src/components/ChatsList.jsx');
  assert.match(list, /<SupportRow summary=\{supportSummary\} onOpen=\{\(\) => onSheet\?\.\('official'\)\} \/>/, 'the pinned row opens the read-only view');
  assert.match(help, /const canWrite = replies === 'open' \|\| asking \|\| messages\?\.length === 0;/);
  assert.match(help, /canWrite \? \(\n\s+<form className="support-composer"/, 'the composer only where writing is allowed');
  assert.ok(help.includes('Only Hidden Messenger can send messages here.'));
  assert.match(help, /sendSupportMessage\(token, body, \{ start: replies !== 'open' \}\)/);
});

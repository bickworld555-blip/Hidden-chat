// Hidden Messenger Support (server/support.mjs): a person writes to support from the app, the support team reads and
// answers in the admin console, the answer reaches every device of that person at once, and nobody else sees it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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

  const sent = await api('/api/v1/support/messages', { token: ava.token, method: 'POST', body: { body: '  My photos won’t send.  ' } });
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
    assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: `message ${index}` } })).status, 201);
  }
  assert.equal((await api('/api/v1/support/messages', { token: cy.token, method: 'POST', body: { body: 'one more' } })).status, 429);
});

test('deleting the account deletes its support conversation', async () => {
  const dee = await register('support_dee');
  await api('/api/v1/support/messages', { token: dee.token, method: 'POST', body: { body: 'Please help.' } });
  assert.equal((await api('/api/v1/me', { token: dee.token, method: 'DELETE', body: { password: PASSWORD, confirm: 'support_dee' } })).status, 204);
  const threads = (await api('/api/admin/v1/support', { admin: true })).body.threads;
  assert.equal(threads.some((thread) => thread.user.id === dee.user.id), false);
});

// Verified business badge (server/verification.mjs): a business asks, an admin approves, everyone sees the badge.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'console_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;

async function start() {
  await service?.close();
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminCredentials: ADMIN });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
}
async function api(path, { token, cookie, method = 'GET', body } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie, 'X-HM-Admin': '1' } : {}), ...(path.startsWith('/api/admin/') ? { 'X-HM-Admin': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
const contactOf = async (token, userId) => (await api('/api/v1/contacts', { token })).body.find((row) => row.id === userId);

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-verified-'));
  await start();
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('a business asks for the verified badge, an admin approves it, and others see it; revoking removes it', async () => {
  const login = await fetch(`${base}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify(ADMIN) });
  const admin = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const shop = await register('bakery_shop');
  const customer = await register('customer_1');
  await api('/api/v1/contacts', { token: customer.token, method: 'POST', body: { userId: shop.user.id } });

  assert.deepEqual((await api('/api/v1/me/verification', { token: shop.token })).body, { status: 'none' });
  const early = await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: { note: 'Bakery on Lake Road' } });
  assert.equal(early.status, 400, 'a business category comes first');
  await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { profile: { category: 'Bakery', description: 'Bread' } } });
  const asked = await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: { note: 'Bakery on Lake Road' } });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.status, 'pending');
  assert.equal((await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: {} })).status, 409, 'one request at a time');

  assert.equal((await api('/api/admin/v1/verification', { token: shop.token })).status, 401, 'only the admin console sees requests');
  const queue = await api('/api/admin/v1/verification', { cookie: admin.cookie });
  assert.deepEqual(queue.body.pending.map((item) => [item.user.username, item.note]), [['bakery_shop', 'Bakery on Lake Road']]);

  assert.equal((await api(`/api/admin/v1/users/${shop.user.id}/verified`, { token: shop.token, method: 'PUT', body: { verified: true } })).status, 401, 'a chat session cannot grant the badge');
  const approved = await api(`/api/admin/v1/users/${shop.user.id}/verified`, { cookie: admin.cookie, method: 'PUT', body: { verified: true } });
  assert.equal(approved.body.status, 'verified');
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, true, 'the badge is on the public record');
  assert.equal((await api('/api/admin/v1/verification', { cookie: admin.cookie })).body.pending.length, 0);

  // Survives a restart (loaded from the database).
  await start();
  // A restart signs admins out (sessions are in memory); sign in again.
  const again = await fetch(`${base}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify(ADMIN) });
  admin.cookie = again.headers.get('set-cookie').split(';')[0];
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, true);

  await api(`/api/admin/v1/users/${shop.user.id}/verified`, { cookie: admin.cookie, method: 'PUT', body: { verified: false } });
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, undefined);
});

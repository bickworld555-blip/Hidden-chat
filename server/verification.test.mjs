// Verification badges (server/verification.mjs): businesses and channels ask, each request gets its own ID, the
// admin console approves or rejects it, and everyone sees the badge.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { newRequestId } from './verification.mjs';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'console_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;
let adminCookie = '';

async function start() {
  await service?.close();
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminCredentials: ADMIN });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
  const login = await fetch(`${base}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify(ADMIN) });
  adminCookie = login.headers.get('set-cookie').split(';')[0];
}
async function api(path, { token, admin = false, method = 'GET', body } = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(admin ? { Cookie: adminCookie } : {}),
    ...(path.startsWith('/api/admin/') ? { 'X-HM-Admin': '1' } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
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

test('request IDs are short, unambiguous and unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, newRequestId));
  assert.ok([...ids].every((id) => /^VR-[A-HJKMNP-TV-Z2-9]{6}$/.test(id)));
  assert.ok(ids.size > 1990);
});

test('a business asks, gets a request ID, an admin approves it, and others see the badge; it can be removed', async () => {
  const shop = await register('bakery_shop');
  const customer = await register('customer_1');
  await api('/api/v1/contacts', { token: customer.token, method: 'POST', body: { userId: shop.user.id } });

  assert.deepEqual((await api('/api/v1/me/verification', { token: shop.token })).body, { status: 'none' });
  assert.equal((await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: { note: 'Bakery' } })).status, 400, 'a business category comes first');
  await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { profile: { category: 'Bakery', description: 'Bread' } } });
  const asked = await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: { note: 'Bakery on Lake Road' } });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.status, 'pending');
  assert.match(asked.body.requestId, /^VR-/);
  assert.equal((await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: {} })).status, 409, 'one request at a time');

  assert.equal((await api('/api/admin/v1/verification', { token: shop.token })).status, 401, 'only the admin console sees requests');
  const queue = (await api('/api/admin/v1/verification?kind=business&status=pending', { admin: true })).body;
  assert.deepEqual(queue.map((item) => [item.requestId, item.subject.username, item.subject.category, item.note, item.requester]),
    [[asked.body.requestId, 'bakery_shop', 'Bakery', 'Bakery on Lake Road', 'bakery_shop']]);
  assert.equal((await api(`/api/admin/v1/verification?kind=business&status=pending&q=${asked.body.requestId.slice(3, 7)}`, { admin: true })).body.length, 1, 'searchable by request ID');

  const approved = await api(`/api/admin/v1/verification/${asked.body.requestId}/decision`, { admin: true, method: 'POST', body: { decision: 'approve' } });
  assert.deepEqual(approved.body, { requestId: asked.body.requestId, status: 'approved' });
  assert.equal((await api(`/api/admin/v1/verification/${asked.body.requestId}/decision`, { admin: true, method: 'POST', body: { decision: 'reject' } })).status, 409, 'decided once');
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, true, 'the badge is on the public record');
  const mine = (await api('/api/v1/me/verification', { token: shop.token })).body;
  assert.deepEqual([mine.status, mine.requestId], ['verified', asked.body.requestId]);
  const summary = (await api('/api/admin/v1/verification/summary', { admin: true })).body;
  assert.equal(summary.verifiedBusinesses, 1);
  assert.equal(summary.business.approved, 1);

  await start();
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, true, 'survives a restart');
  await api(`/api/admin/v1/users/${shop.user.id}/verified`, { admin: true, method: 'PUT', body: { verified: false } });
  assert.equal((await contactOf(customer.token, shop.user.id)).verified, undefined, 'removed');
});

test('a rejected request says why; the business can ask again with a new request ID', async () => {
  const shop = await register('shoe_shop');
  await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { profile: { category: 'Shoes' } } });
  const first = (await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: {} })).body;
  await api(`/api/admin/v1/verification/${first.requestId}/decision`, { admin: true, method: 'POST', body: { decision: 'reject', note: 'Add your shop address' } });
  const rejected = (await api('/api/v1/me/verification', { token: shop.token })).body;
  assert.deepEqual([rejected.status, rejected.decisionNote, rejected.requestId], ['rejected', 'Add your shop address', first.requestId]);
  assert.equal((await api('/api/admin/v1/verification?kind=business&status=rejected', { admin: true })).body.some((item) => item.requestId === first.requestId && item.decidedBy === 'admin:console_admin'), true);
  const second = (await api('/api/v1/me/verification', { token: shop.token, method: 'POST', body: { note: 'Address added' } })).body;
  assert.equal(second.status, 'pending');
  assert.notEqual(second.requestId, first.requestId);
});

test('a channel owner asks for the channel badge; only the owner can; approved channels show it', async () => {
  const owner = await register('news_owner');
  const reader = await register('news_reader');
  const channel = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Lake Road News', description: 'Local news', category: 'news' } })).body;
  assert.equal((await api(`/api/v1/channels/${channel.id}/verification`, { token: reader.token, method: 'POST', body: {} })).status, 403);
  const asked = await api(`/api/v1/channels/${channel.id}/verification`, { token: owner.token, method: 'POST', body: { note: 'Official' } });
  assert.equal(asked.status, 201);
  const queue = (await api('/api/admin/v1/verification?kind=channel', { admin: true })).body;
  assert.deepEqual(queue.map((item) => [item.requestId, item.subject.name, item.subject.owner]), [[asked.body.requestId, 'Lake Road News', 'news_owner']]);
  assert.equal((await api('/api/admin/v1/verification?kind=business', { admin: true })).body.some((item) => item.requestId === asked.body.requestId), false, 'kept apart from business requests');
  await api(`/api/admin/v1/verification/${asked.body.requestId}/decision`, { admin: true, method: 'POST', body: { decision: 'approve' } });
  assert.equal((await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.verified, true);
  assert.equal((await api('/api/v1/channels/discover?q=lake', { token: reader.token })).body[0].verified, true);
  await api(`/api/admin/v1/channels/${channel.id}/verified`, { admin: true, method: 'PUT', body: { verified: false } });
  assert.equal((await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.verified, undefined);
});

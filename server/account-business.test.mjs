// Account information and deletion (server/account.mjs), and business profile links, cover photo, away date
// ranges and catalog collections (server/parity.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { PERSONAL_ROWS } from './account.mjs';
import { parseBusinessLinks } from './parity.mjs';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;
let counter = 0;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-account-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, pushSender: null });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function api(path, { token, method = 'GET', body, raw, type } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': type ?? 'application/octet-stream' } : {}) };
  const response = await fetch(base + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}
async function user(prefix) {
  counter += 1;
  const username = `${prefix}${counter}`;
  return { ...(await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body, username };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8f50000000049454e44ae426082', 'hex');

test('account information downloads as a report without message contents', async () => {
  const me = await user('info');
  const report = await api('/api/v1/me/account-info', { token: me.token });
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-disposition'), /attachment; filename="hidden-messenger-account-info-info\d+\.json"/);
  assert.equal(report.body.account.username, me.username);
  assert.ok(Array.isArray(report.body.devices) && report.body.devices.length >= 1);
  assert.match(report.body.about, /not included/);
});

test('deleting an account needs the password and the username, signs out everywhere and frees the username', async () => {
  const me = await user('leaver');
  const friend = await user('friend');
  await api('/api/v1/contacts', { token: friend.token, method: 'POST', body: { userId: me.user.id } });
  await api('/api/v1/business', { token: me.token, method: 'PUT', body: { profile: { category: 'Bakery' } } });
  assert.equal((await api('/api/v1/me', { token: me.token, method: 'DELETE', body: { password: 'wrong password!!', confirm: me.username } })).status, 401);
  assert.equal((await api('/api/v1/me', { token: me.token, method: 'DELETE', body: { password: PASSWORD, confirm: 'nope' } })).status, 400);
  assert.equal((await api('/api/v1/me', { token: me.token, method: 'DELETE', body: { password: PASSWORD, confirm: me.username } })).status, 204);
  assert.equal((await api('/api/v1/me', { token: me.token })).status, 401, 'every session is gone');
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: me.username, password: PASSWORD } })).status, 401, 'the account cannot sign in');
  assert.equal((await api(`/api/v1/users/${me.user.id}/business`, { token: friend.token })).body, null, 'the business profile is gone');
  assert.equal((await api('/api/v1/auth/register', { method: 'POST', body: { username: me.username, dob: '1990-04-12', password: PASSWORD } })).status, 201, 'the username can be registered again');
  assert.ok(PERSONAL_ROWS.some(([table]) => table === 'messages') && PERSONAL_ROWS.some(([table]) => table === 'e2e_devices'));
});

test('business profile: extra links, a cover photo, and an away message for a date range', async () => {
  const shop = await user('shop');
  const customer = await user('cust');
  assert.deepEqual(parseBusinessLinks([{ label: '', url: 'instagram.com/bakery' }]), [{ label: 'instagram.com', url: 'https://instagram.com/bakery' }]);
  assert.equal(parseBusinessLinks([{ url: 'not a site' }]), null);
  assert.equal(parseBusinessLinks(Array(5).fill({ url: 'a.com' })), null, 'at most four');
  const saved = (await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { profile: { links: [{ label: 'Instagram', url: 'instagram.com/bakery' }, { label: 'Shop', url: 'https://shop.example/' }] } } })).body;
  assert.deepEqual(saved.profile.links.map((link) => link.label), ['Instagram', 'Shop']);
  assert.equal((await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { profile: { links: [{ url: 'nope' }] } } })).status, 400);

  assert.equal((await api('/api/v1/business/cover', { token: shop.token, method: 'PUT', raw: Buffer.from('not an image') })).status, 415);
  const withCover = (await api('/api/v1/business/cover', { token: shop.token, method: 'PUT', raw: PNG, type: 'image/png' })).body;
  assert.match(withCover.profile.cover, new RegExp(`^/api/v1/users/${shop.user.id}/business/cover\\?v=`));
  const seen = (await api(`/api/v1/users/${shop.user.id}/business`, { token: customer.token })).body;
  assert.equal(seen.profile.cover, withCover.profile.cover, 'customers see the cover and the links');
  assert.equal(seen.profile.links.length, 2);
  const image = await fetch(base + withCover.profile.cover, { headers: { Authorization: `Bearer ${customer.token}` } });
  assert.deepEqual([image.status, image.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await api('/api/v1/business/cover', { token: shop.token, method: 'DELETE' })).body.profile.cover, null);

  const from = Date.now() - 60_000;
  const until = Date.now() + 3_600_000;
  const away = (await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { away: { enabled: true, text: 'On holiday', schedule: 'custom', from, until } } })).body.away;
  assert.deepEqual([away.schedule, away.from, away.until], ['custom', from, until]);
  assert.equal((await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { away: { schedule: 'custom', from: until, until: from } } })).status, 400, 'the end must come after the start');
  const back = (await api('/api/v1/business', { token: shop.token, method: 'PUT', body: { away: { schedule: 'always' } } })).body.away;
  assert.deepEqual([back.schedule, back.from], ['always', null], 'switching back clears the range');
});

test('catalog collections group the owner’s items; customers only see visible ones', async () => {
  const shop = await user('collect');
  const other = await user('looker');
  const item = async (name, hidden = false) => (await api('/api/v1/catalog', { token: shop.token, method: 'POST', body: { name, price: 2, currency: 'USD', hidden } })).body;
  const bread = await item('Bread');
  const secret = await item('Secret menu', true);
  const foreign = (await api('/api/v1/catalog', { token: other.token, method: 'POST', body: { name: 'Not yours', price: 1, currency: 'USD' } })).body;
  const made = await api('/api/v1/catalog/collections', { token: shop.token, method: 'POST', body: { name: 'Bakery', itemIds: [bread.id, secret.id, foreign.id] } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.itemIds, [bread.id, secret.id], 'only the owner’s own items');
  assert.deepEqual((await api(`/api/v1/users/${shop.user.id}/catalog/collections`, { token: other.token })).body.map((c) => c.itemIds), [[bread.id]], 'hidden items stay hidden');
  assert.equal((await api(`/api/v1/catalog/collections/${made.body.id}`, { token: other.token, method: 'PUT', body: { name: 'Mine now' } })).status, 404);
  assert.equal((await api(`/api/v1/catalog/collections/${made.body.id}`, { token: shop.token, method: 'PUT', body: { name: 'Fresh bread' } })).body.name, 'Fresh bread');
  assert.equal((await api(`/api/v1/catalog/collections/${made.body.id}`, { token: shop.token, method: 'DELETE' })).status, 204);
  assert.deepEqual((await api(`/api/v1/users/${shop.user.id}/catalog/collections`, { token: shop.token })).body, []);
});

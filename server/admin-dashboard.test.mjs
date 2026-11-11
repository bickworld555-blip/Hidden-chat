// Admin dashboard data (server/regions.mjs, server/admin.mjs, server/billing.mjs): per-country totals from time
// zones, live counters, the prepared billing structure, and that no admin response ever carries chat content.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { countryForTimeZone } from './regions.mjs';
import { PLANS, hasFeature } from './billing.mjs';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'console_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;
let cookie = '';

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-dashboard-'));
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
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;

test('time zones map to a country code, and nothing else is accepted', () => {
  assert.equal(countryForTimeZone('Asia/Dhaka'), 'BD');
  assert.equal(countryForTimeZone('America/Argentina/Buenos_Aires'), 'AR');
  assert.equal(countryForTimeZone('Europe/London'), 'GB');
  for (const value of ['UTC', 'Etc/GMT+3', '', null, 'Asia/Dhaka; DROP TABLE users', 'x'.repeat(80), 42]) assert.equal(countryForTimeZone(value), null, String(value));
});

test('the world map gets per-country totals only; accounts without a country are "unknown"', async () => {
  const a = await register('geo_bd_one');
  const b = await register('geo_bd_two');
  const c = await register('geo_gb_one');
  await register('geo_unknown');
  assert.deepEqual((await api('/api/v1/me/region', { token: a.token, method: 'POST', body: { timeZone: 'Asia/Dhaka' } })).body, { country: 'BD' });
  await api('/api/v1/me/region', { token: b.token, method: 'POST', body: { timeZone: 'Asia/Dhaka' } });
  await api('/api/v1/me/region', { token: c.token, method: 'POST', body: { timeZone: 'Europe/London' } });
  assert.deepEqual((await api('/api/v1/me/region', { token: c.token, method: 'POST', body: { timeZone: 'Mars/Olympus' } })).body, { country: null }, 'an unknown zone changes nothing');

  assert.ok([401, 403].includes((await api('/api/admin/v1/geo', { token: a.token })).status), 'a chat token gets nothing');
  const geo = (await api('/api/admin/v1/geo', { admin: true })).body;
  const bd = geo.countries.find((row) => row.code === 'BD');
  assert.deepEqual([bd.users, bd.active, bd.numeric, bd.name], [2, 2, '050', 'Bangladesh']);
  assert.equal(geo.countries.find((row) => row.code === 'GB').users, 1);
  assert.ok(geo.unknown.users >= 1);
  assert.ok(!/geo_bd_one|username|"id"/.test(JSON.stringify(geo)), 'no account is identified');

  const info = (await api('/api/v1/me/account-info', { token: a.token })).body;
  assert.equal(info.account.country, 'BD', 'people can see what is stored about them');
});

test('live counters and overview totals for the console', async () => {
  const live = (await api('/api/admin/v1/live', { admin: true })).body;
  for (const key of ['online', 'activeLastHour', 'messagesLastHour', 'signupsToday', 'openReports', 'pendingVerifications']) assert.equal(typeof live[key], 'number', key);
  assert.ok(live.signupsToday >= 1);
  const stats = (await api('/api/admin/v1/stats', { admin: true })).body;
  for (const key of ['verifiedBusinesses', 'verifiedChannels', 'pendingVerifications', 'activeWeek']) assert.equal(typeof stats[key], 'number', key);
});

test('billing is prepared, not live: plans and features, everyone on Free, nothing locked', async () => {
  const billing = (await api('/api/admin/v1/billing', { admin: true })).body;
  assert.equal(billing.live, false);
  assert.deepEqual(billing.plans.map((plan) => [plan.id, plan.status]), [['free', 'live'], ['business_pro', 'planned'], ['enterprise', 'planned']]);
  assert.deepEqual(billing.subscribers, []);
  assert.equal(PLANS[0].priceMonthly, 0);
  assert.equal(await hasFeature('anyone', 'catalog'), true);
  assert.equal(await hasFeature('anyone', 'multi_agent'), false);
});

test('privacy: no admin response contains message text, even when chats exist', async () => {
  const one = await register('privacy_one');
  const two = await register('privacy_two');
  await api('/api/v1/contacts', { token: one.token, method: 'POST', body: { userId: two.user.id } });
  const secret = 'SECRET-PHRASE-7f3a9';
  // Stored straight into the database: as if a message existed, readable or not.
  service.db.prepare("INSERT INTO messages(id, sender_id, receiver_id, content, created_at, status) VALUES (?, ?, ?, ?, ?, 'sent')")
    .run('privacy-msg', one.user.id, two.user.id, secret, new Date().toISOString());
  await api(`/api/v1/users/${two.user.id}/report`, { token: one.token, method: 'POST', body: { reason: 'spam', details: 'report details' } });
  const paths = ['/api/admin/v1/stats', '/api/admin/v1/live', '/api/admin/v1/geo', '/api/admin/v1/users?q=', '/api/admin/v1/reports?status=open',
    '/api/admin/v1/reports?status=resolved', '/api/admin/v1/verification?kind=business', '/api/admin/v1/verification?kind=channel',
    '/api/admin/v1/verification/summary', '/api/admin/v1/verified?kind=business', '/api/admin/v1/media-integrity', '/api/admin/v1/billing', '/api/admin/v1/help'];
  for (const path of paths) {
    const response = await api(path, { admin: true });
    assert.equal(response.status, 200, path);
    assert.ok(!response.text.includes(secret), `${path} must not include message content`);
  }
});

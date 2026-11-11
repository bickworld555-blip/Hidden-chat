// Help Center, reports, the admin console and suspension (server/admin.mjs), the standalone admin sign-in
// (server/adminAuth.mjs), and which page a URL opens.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { adminCredentialsFrom } from './adminAuth.mjs';
import { entryFor } from '../src/site/links.js';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'console_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;

async function start(adminCredentials = ADMIN) {
  await service?.close();
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminCredentials });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-admin-'));
  await start();
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, cookie, method = 'GET', body, adminHeader = path.startsWith('/api/admin/') } = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(adminHeader ? { 'X-HM-Admin': '1' } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
async function adminCookie(credentials = ADMIN) {
  const response = await api('/api/admin/v1/login', { method: 'POST', body: credentials });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.headers.get('set-cookie').split(';')[0];
}

test('admin sign-in uses the server credentials and its own cookie, never a chat session', async () => {
  const session = await api('/api/admin/v1/session');
  assert.deepEqual(session.body, { configured: true, signedIn: false, username: null });

  assert.equal((await api('/api/admin/v1/login', { method: 'POST', body: { username: ADMIN.username, password: 'wrong-password-123' } })).status, 401);
  const login = await api('/api/admin/v1/login', { method: 'POST', body: { username: 'CONSOLE_ADMIN', password: ADMIN.password } });
  assert.equal(login.status, 200, 'the username is not case-sensitive');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /^hm_admin=[A-Za-z0-9_-]{40,};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/admin/, 'the chat app never sends it');
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const cookie = setCookie.split(';')[0];
  assert.equal((await api('/api/admin/v1/session', { cookie })).body.signedIn, true);
  assert.equal((await api('/api/admin/v1/stats', { cookie })).status, 200);

  // A chat account, even one called like the admin, gets nowhere on the admin API.
  const member = await register('console_admin');
  assert.equal((await api('/api/admin/v1/stats', { token: member.token })).status, 401, 'chat tokens are not admin sessions');
  assert.equal((await api('/api/v1/me', { cookie })).status, 401, 'the admin cookie is not a chat session');
  assert.equal((await api('/api/admin/v1/stats', { cookie, adminHeader: false })).status, 403, 'the admin header is required');
  assert.equal((await api('/api/v1/admin/stats', { token: member.token })).status, 404, 'the old chat-session admin routes are gone');

  await api('/api/admin/v1/logout', { cookie, method: 'POST' });
  assert.equal((await api('/api/admin/v1/stats', { cookie })).status, 401, 'signed out');
});

test('repeated wrong passwords slow admin sign-in down; unset credentials turn it off', async () => {
  await start();
  for (let i = 0; i < 5; i += 1) await api('/api/admin/v1/login', { method: 'POST', body: { username: ADMIN.username, password: `nope-${i}-xxxxxxx` } });
  const throttled = await api('/api/admin/v1/login', { method: 'POST', body: ADMIN });
  assert.equal(throttled.status, 429, 'even the right password waits');

  await start(null);
  assert.equal((await api('/api/admin/v1/session')).body.configured, false);
  assert.equal((await api('/api/admin/v1/login', { method: 'POST', body: ADMIN })).status, 503);
  assert.equal(adminCredentialsFrom({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'short' }, { error() {} }), null, 'passwords under 12 characters are refused');
  assert.deepEqual(adminCredentialsFrom({ ADMIN_USERNAME: ' ops ', ADMIN_PASSWORD: 'twelve-chars!' }), { username: 'ops', password: 'twelve-chars!' });
  assert.equal(adminCredentialsFrom({}), null);
  await start();
});

test('the Help Center is public, starts with articles, and only the admin console edits it', async () => {
  const list = await api('/api/v1/help');
  assert.equal(list.status, 200);
  assert.ok(list.body.articles.length >= 5 && list.body.articles.every((article) => article.summary && article.body === undefined));
  const found = await api('/api/v1/help?q=security%20code');
  assert.ok(found.body.articles.some((article) => article.slug === 'end-to-end-encryption'));
  assert.equal((await api('/api/v1/help/end-to-end-encryption')).body.title, 'How end-to-end encryption works');
  const cookie = await adminCookie();
  const member = await register('helpreader');
  assert.equal((await api('/api/admin/v1/help', { token: member.token })).status, 401);
  const created = await api('/api/admin/v1/help', { cookie, method: 'POST', body: { slug: 'change-username', category: 'account', title: 'Change your username', body: 'Open Settings › Profile.', published: false } });
  assert.equal(created.status, 201);
  assert.equal((await api('/api/v1/help/change-username')).status, 404, 'hidden articles are not public');
  await api(`/api/admin/v1/help/${created.body.id}`, { cookie, method: 'PUT', body: { ...created.body, published: true } });
  assert.equal((await api('/api/v1/help/change-username')).body.body, 'Open Settings › Profile.');
  assert.equal((await api('/api/admin/v1/help', { cookie, method: 'POST', body: { slug: 'change-username', category: 'account', title: 'x', body: 'y' } })).status, 409);
  assert.equal((await api('/api/admin/v1/help', { cookie, method: 'POST', body: { slug: 'Bad Slug!', category: 'account', title: 'x', body: 'y' } })).status, 400);
});

test('reports reach the admin console; suspending signs the account out and blocks sign-in until restored', async () => {
  const cookie = await adminCookie();
  const reporter = await register('reporter1');
  const abuser = await register('abuser1');
  assert.equal((await api(`/api/v1/users/${abuser.user.id}/report`, { token: reporter.token, method: 'POST', body: { reason: 'nonsense' } })).status, 400);
  assert.equal((await api(`/api/v1/users/${abuser.user.id}/report`, { token: reporter.token, method: 'POST', body: { reason: 'spam', details: 'sends links' } })).status, 201);
  const reports = (await api('/api/admin/v1/reports', { cookie })).body;
  const report = reports.find((item) => item.targetId === abuser.user.id);
  assert.deepEqual([report.kind, report.reason, report.reporterName, report.details], ['user', 'spam', 'reporter1', 'sends links']);
  assert.equal((await api('/api/admin/v1/reports', { token: reporter.token })).status, 401);

  const stats = (await api('/api/admin/v1/stats', { cookie })).body;
  assert.ok(stats.users >= 2 && stats.openReports >= 1 && stats.signups.length === 14 && stats.messages.length === 14);

  assert.equal((await api(`/api/admin/v1/users/${abuser.user.id}/suspend`, { cookie, method: 'POST' })).status, 200);
  assert.equal((await api('/api/v1/me', { token: abuser.token })).status, 401, 'signed out everywhere');
  const blocked = await api('/api/v1/auth/login', { method: 'POST', body: { identity: 'abuser1', password: PASSWORD } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /suspended/);
  await api(`/api/admin/v1/reports/user/${report.id}`, { cookie, method: 'POST', body: { status: 'resolved' } });
  assert.equal((await api('/api/admin/v1/reports', { cookie })).body.some((item) => item.id === report.id), false);
  await api(`/api/admin/v1/users/${abuser.user.id}/restore`, { cookie, method: 'POST' });
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: 'abuser1', password: PASSWORD } })).status, 200);
  assert.equal((await api(`/api/admin/v1/users/${abuser.user.id}/admin`, { cookie, method: 'POST' })).status, 400, 'chat accounts cannot be made admins');
  const listed = (await api('/api/admin/v1/users?q=abuser', { cookie })).body;
  assert.deepEqual([listed.length, listed[0].suspendedAt, listed[0].isAdmin], [1, null, undefined]);
});

test('page routing: public pages on the website, the messenger everywhere else and always in the app', () => {
  for (const path of ['/', '/features', '/privacy', '/business', '/download', '/help', '/help/create-account']) assert.equal(entryFor(path), 'site', path);
  for (const path of ['/app', '/join/abcdefghijklmnop', '/call/abcdefghijklmnop']) assert.equal(entryFor(path), 'app', path);
  assert.equal(entryFor('/', { signedIn: true }), 'redirect-app');
  assert.equal(entryFor('/features', { signedIn: true }), 'site', 'signed-in people can still read the site');
  assert.equal(entryFor('/', { native: true }), 'app', 'the Android app never shows the website');
});

test('the admin console sees which stored media lost their files and can remove those records', async () => {
  const cookie = await adminCookie();
  const member = await register('mediacheck');
  const other = await register('mediapeer');
  assert.equal((await api('/api/admin/v1/media-integrity', { token: member.token })).status, 401);
  const before = (await api('/api/admin/v1/media-integrity', { cookie })).body;
  assert.equal(typeof before.checked, 'number');
  assert.equal(before.missing, 0, 'a fresh server has no missing files');
  // A record whose file is gone (as after a deploy wiped an old upload folder).
  service.db.prepare('INSERT INTO media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('lost-media', member.user.id, other.user.id, 'old.jpg', 'image/jpeg', 10, 'does-not-exist.blob', Date.now() - 86_400_000);
  const scan = (await api('/api/admin/v1/media-integrity', { cookie })).body;
  assert.equal(scan.missing, 1);
  assert.ok(scan.oldestMissingAt > 0);
  assert.equal((await api('/api/admin/v1/media-integrity/clean', { token: member.token, method: 'POST' })).status, 401);
  assert.deepEqual((await api('/api/admin/v1/media-integrity/clean', { cookie, method: 'POST' })).body, { removed: 1 });
  assert.equal((await api('/api/admin/v1/media-integrity', { cookie })).body.missing, 0);
});

// Help Center, reports, admin console and suspension (server/admin.mjs), plus which page a URL opens.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { adminUsernamesFrom } from './admin.mjs';
import { entryFor } from '../src/site/links.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;

// Like a deployment: the listed admins already have accounts when the server starts.
async function start(adminUsernames) {
  await service?.close();
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminUsernames });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-admin-'));
  await start(['shakil']);
  await register('shakil');
  await start(['shakil']);
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
const login = async (identity) => (await api('/api/v1/auth/login', { method: 'POST', body: { identity, password: PASSWORD } })).body;

test('the Help Center is public, starts with articles, and only admins edit it', async () => {
  const list = await api('/api/v1/help');
  assert.equal(list.status, 200);
  assert.ok(list.body.articles.length >= 5 && list.body.articles.every((article) => article.summary && article.body === undefined));
  const found = await api('/api/v1/help?q=security%20code');
  assert.ok(found.body.articles.some((article) => article.slug === 'end-to-end-encryption'));
  assert.equal((await api('/api/v1/help/end-to-end-encryption')).body.title, 'How end-to-end encryption works');
  const admin = await login('shakil');
  const member = await register('helpreader');
  assert.equal((await api('/api/v1/admin/help', { token: member.token })).status, 404, 'non-admins do not even learn the route exists');
  const created = await api('/api/v1/admin/help', { token: admin.token, method: 'POST', body: { slug: 'change-username', category: 'account', title: 'Change your username', body: 'Open Settings › Profile.', published: false } });
  assert.equal(created.status, 201);
  assert.equal((await api('/api/v1/help/change-username')).status, 404, 'hidden articles are not public');
  await api(`/api/v1/admin/help/${created.body.id}`, { token: admin.token, method: 'PUT', body: { ...created.body, published: true } });
  assert.equal((await api('/api/v1/help/change-username')).body.body, 'Open Settings › Profile.');
  assert.equal((await api('/api/v1/admin/help', { token: admin.token, method: 'POST', body: { slug: 'change-username', category: 'account', title: 'x', body: 'y' } })).status, 409);
  assert.equal((await api('/api/v1/admin/help', { token: admin.token, method: 'POST', body: { slug: 'Bad Slug!', category: 'account', title: 'x', body: 'y' } })).status, 400);
});

test('reports reach the admins; suspending signs the account out and blocks sign-in until restored', async () => {
  const admin = (await api('/api/v1/auth/login', { method: 'POST', body: { identity: 'shakil', password: PASSWORD } })).body;
  const reporter = await register('reporter1');
  const abuser = await register('abuser1');
  assert.equal((await api(`/api/v1/users/${abuser.user.id}/report`, { token: reporter.token, method: 'POST', body: { reason: 'nonsense' } })).status, 400);
  assert.equal((await api(`/api/v1/users/${abuser.user.id}/report`, { token: reporter.token, method: 'POST', body: { reason: 'spam', details: 'sends links' } })).status, 201);
  const reports = (await api('/api/v1/admin/reports', { token: admin.token })).body;
  const report = reports.find((item) => item.targetId === abuser.user.id);
  assert.deepEqual([report.kind, report.reason, report.reporterName, report.details], ['user', 'spam', 'reporter1', 'sends links']);
  assert.equal((await api('/api/v1/admin/reports', { token: reporter.token })).status, 404);

  const stats = (await api('/api/v1/admin/stats', { token: admin.token })).body;
  assert.ok(stats.users >= 3 && stats.openReports >= 1 && stats.signups.length === 14 && stats.messages.length === 14);

  assert.equal((await api(`/api/v1/admin/users/${abuser.user.id}/suspend`, { token: admin.token, method: 'POST' })).status, 200);
  assert.equal((await api('/api/v1/me', { token: abuser.token })).status, 401, 'signed out everywhere');
  const blocked = await api('/api/v1/auth/login', { method: 'POST', body: { identity: 'abuser1', password: PASSWORD } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /suspended/);
  await api(`/api/v1/admin/reports/user/${report.id}`, { token: admin.token, method: 'POST', body: { status: 'resolved' } });
  assert.equal((await api('/api/v1/admin/reports', { token: admin.token })).body.some((item) => item.id === report.id), false);
  await api(`/api/v1/admin/users/${abuser.user.id}/restore`, { token: admin.token, method: 'POST' });
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: 'abuser1', password: PASSWORD } })).status, 200);
  assert.equal((await api(`/api/v1/admin/users/${admin.user.id}/suspend`, { token: admin.token, method: 'POST' })).status, 400, 'an admin cannot suspend themselves');
  const listed = (await api('/api/v1/admin/users?q=abuser', { token: admin.token })).body;
  assert.deepEqual([listed.length, listed[0].suspendedAt], [1, null]);
});

test('page routing: public pages on the website, the messenger everywhere else and always in the app', () => {
  for (const path of ['/', '/features', '/privacy', '/business', '/download', '/help', '/help/create-account']) assert.equal(entryFor(path), 'site', path);
  for (const path of ['/app', '/admin', '/join/abcdefghijklmnop', '/call/abcdefghijklmnop']) assert.equal(entryFor(path), 'app', path);
  assert.equal(entryFor('/', { signedIn: true }), 'redirect-app');
  assert.equal(entryFor('/features', { signedIn: true }), 'site', 'signed-in people can still read the site');
  assert.equal(entryFor('/', { native: true }), 'app', 'the Android app never shows the website');
});

test('ADMIN_USERNAMES lists admins: parsed leniently, granted at deployment to existing accounts only', () => {
  assert.deepEqual(adminUsernamesFrom(' Shakil, @ops_lead ,,bad name!,ops_lead'), ['shakil', 'ops_lead']);
  assert.deepEqual(adminUsernamesFrom(undefined), ['shakil']);
  assert.deepEqual(adminUsernamesFrom('  '), ['shakil']);
});

test('admins grant and revoke the role in the console; listed admins arrive with each deployment', async () => {
  const lead = await register('ops_lead');
  // Listed, but the account was created after this start-up: no role until the next deployment.
  await start(['shakil', 'ops_lead', 'not_yet_taken']);
  const squatter = await register('not_yet_taken');
  assert.equal((await api('/api/v1/admin/me', { token: squatter.token })).status, 404, 'registering a listed name later does not make you an admin');
  const leadSession = await login('ops_lead');
  assert.equal((await api('/api/v1/admin/me', { token: leadSession.token })).status, 200, 'an existing listed account is an admin after deployment');

  const admin = await login('shakil');
  const helper = await register('helper_one');
  const users = (q, role = '') => api(`/api/v1/admin/users?q=${q}${role}`, { token: admin.token });
  assert.equal((await api('/api/v1/admin/me', { token: helper.token })).status, 404);
  assert.equal((await api(`/api/v1/admin/users/${helper.user.id}/admin`, { token: admin.token, method: 'POST' })).status, 200);
  assert.equal((await api('/api/v1/admin/me', { token: helper.token })).status, 200, 'granted from the console');
  const admins = (await users('', '&role=admin')).body.map((user) => user.username).sort();
  assert.deepEqual(admins, ['helper_one', 'ops_lead', 'shakil']);
  assert.equal((await users('ops_lead')).body[0].configuredAdmin, true);
  assert.equal((await users('helper_one')).body[0].configuredAdmin, false);

  const refused = await api(`/api/v1/admin/users/${lead.user.id}/unadmin`, { token: admin.token, method: 'POST' });
  assert.equal(refused.status, 409, 'a listed admin is managed in ADMIN_USERNAMES');
  assert.match(refused.body.error, /ADMIN_USERNAMES/);
  assert.equal((await api(`/api/v1/admin/users/${helper.user.id}/unadmin`, { token: admin.token, method: 'POST' })).status, 200);
  assert.equal((await api('/api/v1/admin/me', { token: helper.token })).status, 404, 'revoked from the console');
  assert.equal((await api(`/api/v1/admin/users/${admin.user.id}/unadmin`, { token: admin.token, method: 'POST' })).status, 400, 'nobody removes their own role');
});

// Group permissions › Members can › Add other members (schema 26), the in-app camera's helpers, and the group
// member sheet / Exit group flow (source checks for the screens).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { cameraVideoType, clockOf } from '../src/cameraMedia.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-group-camera-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}
async function register(prefix) {
  counter += 1;
  return (await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } })).data;
}

test('Add other members: off, only admins add; on, any member adds; only admins change it', async () => {
  const ana = await register('gca');
  const ben = await register('gcb');
  const cara = await register('gcc');
  const dev = await register('gcd');
  const group = (await api('/api/v1/groups', { session: ana, method: 'POST', body: { name: 'Hikers', memberIds: [ben.user.id] } })).data;
  const path = `/api/v1/groups/${group.id}`;
  assert.equal((await api(`${path}/members`, { session: ben, method: 'POST', body: { userId: cara.user.id } })).status, 403, 'members cannot add by default');
  assert.equal((await api(`${path}/permissions`, { session: ben, method: 'PUT', body: { membersCanAdd: true } })).status, 403, 'only admins change permissions');
  const changed = await api(`${path}/permissions`, { session: ana, method: 'PUT', body: { membersCanAdd: true } });
  assert.equal(changed.data.membersCanAdd, true);
  assert.equal((await api(path, { session: ben })).data.membersCanAdd, true, 'members see the permission');
  assert.ok([200, 201].includes((await api(`${path}/members`, { session: ben, method: 'POST', body: { userId: cara.user.id } })).status), 'a member adds');
  assert.equal((await api(`${path}/members`, { session: ben, method: 'POST', body: { userId: cara.user.id } })).status, 409, 'already a member');
  assert.equal((await api(`${path}/permissions`, { session: ana, method: 'PUT', body: { membersCanAdd: 'yes' } })).status, 400);
  await api(`${path}/permissions`, { session: ana, method: 'PUT', body: { membersCanAdd: false } });
  assert.equal((await api(`${path}/members`, { session: ben, method: 'POST', body: { userId: dev.user.id } })).status, 403, 'off again');
});

test('in-app camera: MP4 where the phone records it, else WebM; a recording clock', () => {
  assert.equal(cameraVideoType((type) => type.startsWith('video/mp4')), 'video/mp4;codecs=avc1,mp4a');
  assert.equal(cameraVideoType((type) => type === 'video/webm'), 'video/webm');
  assert.equal(cameraVideoType(() => false), '');
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(75.4), '1:15');
});

test('chats and groups open the in-app camera; groups have WhatsApp’s member sheet and Exit group dialog', () => {
  const chat = readFileSync(new URL('../src/components/ChatWindow.jsx', import.meta.url), 'utf8');
  assert.match(chat, /className="composer-icon composer-camera" onClick=\{\(\) => setPicker\('camera'\)\}/);
  assert.match(chat, /else if \(option === 'camera'\) setPicker\('camera'\);/);
  const groups = readFileSync(new URL('../src/components/GroupsView.jsx', import.meta.url), 'utf8');
  assert.match(groups, /else if \(option === 'camera'\) setCameraOpen\(true\);/);
  assert.match(groups, /\{member\.role === 'admin' \? 'Dismiss as admin' : 'Make group admin'\}/);
  assert.match(groups, /Remove from group/);
  assert.match(groups, /<h3 id="groups-exit-title">Exit “\{group\.name\}”\?<\/h3>/);
  assert.match(groups, /\(group\.role === 'admin' \|\| group\.membersCanAdd\) && <>/);
  const admin = readFileSync(new URL('../src/components/parity/GroupAdmin.jsx', import.meta.url), 'utf8');
  for (const label of ['Members can:', 'Edit group settings', 'Send new messages', 'Add other members', 'Admins can:', 'Edit group admins']) assert.ok(admin.includes(label), label);
});

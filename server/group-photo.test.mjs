// Group photos (New group › photo, server/parity.mjs): set by whoever may edit the group's info, shown to members only,
// listed with the group, replaced and removed. Postgres: migration 040.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createChatServer } from './index.mjs';
import { groupRow } from '../src/groupRows.js';

const PASSWORD = 'correct horse battery staple';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
let directory;
let service;
let base;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-group-photo-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body, raw } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}) };
  const response = await fetch(base + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, type, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;

test('a group photo: set at creation by the admin, listed with the group, shown to members only, replaced and removed', async () => {
  const admin = await register('gp_admin');
  const member = await register('gp_member');
  const stranger = await register('gp_stranger');
  const group = (await api('/api/v1/groups', { token: admin.token, method: 'POST', body: { name: 'Photo group', memberIds: [member.user.id] } })).body;

  assert.equal((await api(`/api/v1/groups/${group.id}/avatar`, { token: admin.token, method: 'PUT', raw: Buffer.from('not an image') })).status, 415);
  const set = await api(`/api/v1/groups/${group.id}/avatar`, { token: admin.token, method: 'PUT', raw: PNG });
  assert.equal(set.status, 200);
  assert.match(set.body.avatar, new RegExp(`^/api/v1/groups/${group.id}/avatar\\?v=\\d+$`), 'a versioned URL');

  const listed = (await api('/api/v1/groups', { token: member.token })).body.find((item) => item.id === group.id);
  assert.equal(listed.avatar, set.body.avatar, 'the group list carries the photo');
  assert.ok(!('avatarDiskName' in listed), 'never the file name');
  assert.equal((await api(`/api/v1/groups/${group.id}`, { token: member.token })).body.avatar, set.body.avatar, 'and so do the group details');

  const seen = await api(set.body.avatar, { token: member.token });
  assert.deepEqual([seen.status, seen.type, Buffer.compare(seen.body, PNG)], [200, 'image/png', 0], 'a member sees it');
  assert.equal((await api(set.body.avatar, { token: stranger.token })).status, 404, 'a stranger does not');
  assert.equal((await api(`/api/v1/groups/${group.id}/avatar`, { token: stranger.token, method: 'PUT', raw: PNG })).status, 404, 'nor changes it');

  // "Edit group info: only admins" keeps members from changing it.
  assert.equal((await api(`/api/v1/groups/${group.id}/permissions`, { token: admin.token, method: 'PUT', body: { onlyAdminsEdit: true } })).status, 200);
  assert.equal((await api(`/api/v1/groups/${group.id}/avatar`, { token: member.token, method: 'PUT', raw: PNG })).status, 403);

  const replaced = await api(`/api/v1/groups/${group.id}/avatar`, { token: admin.token, method: 'PUT', raw: PNG });
  assert.notEqual(replaced.body.avatar, set.body.avatar, 'a new version, a new URL');
  assert.equal((await api(`/api/v1/groups/${group.id}/avatar`, { token: admin.token, method: 'DELETE' })).body.avatar, null);
  assert.equal((await api(`/api/v1/groups/${group.id}`, { token: member.token })).body.avatar, null, 'removed');
  assert.equal((await api(replaced.body.avatar, { token: member.token })).status, 404);
});

test('New group is two steps: pick members from your contacts, then name, photo, disappearing messages and permissions', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const groups = read('src/components/GroupsView.jsx');
  const flow = read('src/components/NewGroupFlow.jsx');
  assert.ok(!groups.includes('Type the full @username'), 'no more typing usernames to make a group');
  assert.match(groups, /<NewGroupFlow token=\{token\}/);
  // Step 1: the contact picker's people, with a round check each, and the round Next button.
  assert.match(flow, /unifiedContacts\(savedContacts\(chats, hiddenContacts/);
  assert.match(flow, /role="checkbox" aria-checked=\{picked\}/);
  assert.match(flow, /className="ng-fab" onClick=\{\(\) => setStep\('details'\)\} disabled=\{!picked\.length\} aria-label="Next"/);
  // Step 2: photo, the bordered name with emoji, the two settings, the members with Add, and the round create button.
  for (const part of ['aria-label={photo ? \'Change group photo\' : \'Add group photo\'}', 'placeholder="Group name"', 'aria-label="Emoji"',
    '<strong>Disappearing messages</strong>', '<strong>Group permissions</strong>', 'Members: {picked.length || \'None\'}', 'aria-label="Add members"', 'aria-label="Create group"']) {
    assert.ok(flow.includes(part), part);
  }
  assert.match(flow, /uploadGroupAvatar\(created\.id, photo\.blob, token\)/, 'the photo is set right after the group is made');
  assert.match(flow, /`\$\{path\}\/permissions`/);
  assert.match(flow, /`\$\{path\}\/member-settings`, \{ method: 'PUT', body: \{ autoDelete: true \} \}/);
  assert.equal(groupRow({ id: 'g1', name: 'Team', avatar: '/api/v1/groups/g1/avatar?v=1' }, 'me').avatar, '/api/v1/groups/g1/avatar?v=1', 'chat list rows show the photo');
});

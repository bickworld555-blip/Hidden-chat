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
  assert.match(flow, /<MemberPicker token=\{token\} userId=\{userId\} title="New group"[^\n]*onNext=\{\(\) => setStep\('details'\)\}/);
  assert.match(flow, /className="ng-fab" onClick=\{onNext\} disabled=\{busy \|\| !picked\.length\} aria-label=\{nextLabel\}/, 'Next stays off until someone is picked');
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

test('Add members lists each person once: frequently contacted people are not repeated under contacts or recent chats', async () => {
  const { memberSections } = await import('../src/contactBook.js');
  const a = { id: 'a', name: 'A' }; const b = { id: 'b', name: 'B' }; const c = { id: 'c', name: 'C' };
  const sections = memberSections({ frequent: [a], contacts: [a, b], recent: [b, c], found: [c] });
  assert.deepEqual(sections.map(([title, list]) => [title, list.map((person) => person.id)]), [['Frequently contacted', ['a']], ['Contacts on Hidden Messenger', ['b']], ['Recent chats', ['c']]]);
});

test('group screens follow WhatsApp\'s structure: chat menu, Invite, Group link, Group permissions, Add members', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const groups = read('src/components/GroupsView.jsx');
  const admin = read('src/components/parity/GroupAdmin.jsx');
  // Chat header: Add to list, then ⋮ with Group info, Group media, Mute, Disappearing messages, More (Clear, Export, Report, Exit).
  for (const item of ['aria-label="Add to list"', 'aria-label="More options"', '>Group info</button>', '>Group media</button>', "'Mute notifications'",
    '>Disappearing messages</button>', 'More <ChevronRight', '>Clear chat</button>', '>Export chat</button>', '>Report</button>', '>Exit group</button>']) {
    assert.ok(groups.includes(item), item);
  }
  // Group info: Invite in the toolbar and under Add members; Group permissions first in Settings; Add members is the picker.
  assert.match(groups, /onClick=\{\(\) => setGroupScreen\('link'\)\} aria-label="Invite"/);
  assert.ok(groups.includes('<strong>Invite via link or QR code</strong>'));
  assert.match(groups, /title="Group permissions"[^\n]*setGroupScreen\('permissions'\)/);
  assert.match(groups, /<MemberPicker token=\{token\} userId=\{userId\} title="Add members"/);
  assert.match(groups, /excludeIds=\{group\.members\.map\(\(member\) => member\.id\)\}/, 'people already in the group are not offered');
  assert.ok(!groups.includes('Add member by username'), 'no more typing usernames to add members');
  // Group link: the group and link, then Copy, Share, QR code, Reset; then Manage permissions with Edit.
  const link = admin.slice(admin.indexOf('export function GroupLinkScreen'));
  for (const action of ["'Copy link'", "'Share link'", "'QR code'", "'Reset link'", '<span>Manage permissions</span>', '>Edit</button>']) assert.ok(link.includes(action), action);
  // Group permissions: Members can / Admins can / Group admins, with the four switches and Edit group admins, in order.
  const permissions = admin.slice(admin.indexOf('export function GroupPermissionsScreen'), admin.indexOf('export function GroupLinkScreen'));
  const order = ['Members can:', 'title="Edit group settings"', 'title="Send new messages"', 'title="Add other members"', 'Admins can:', 'title="Approve new members"', 'Group admins', 'Edit group admins'];
  const at = order.map((part) => permissions.indexOf(part));
  assert.ok(at.every((index) => index >= 0), `all present: ${order.filter((_, index) => at[index] < 0).join(', ')}`);
  assert.deepEqual([...at].sort((left, right) => left - right), at, 'in WhatsApp\'s order');
});

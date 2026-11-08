// Profile photos and favourites ordering.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer, detectAvatarImage } from './index.mjs';
import { orderChats } from '../src/chatOrder.js';
import { useChatStore } from '../src/store.js';
import { MAX_DISPLAY_NAME, displayNameError, hasCustomDisplayName, initialsFor, presentName } from '../src/profile.js';

let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-profile-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'profile.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function register(prefix) {
  counter += 1;
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `${prefix}${counter}`, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

const auth = (session, extra = {}) => ({ Authorization: 'Bearer ' + session.token, ...extra });

// Smallest valid files of each format: enough header for detection plus some payload.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);

function connectSocket(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

function until(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 20);
    })();
  });
}

test('a profile photo is stored, announced to everyone online, served to signed-in users, replaced and removed', async () => {
  const me = await register('me');
  const friend = await register('friend');
  const friendSocket = await connectSocket(friend);
  await fetch(`${baseUrl}/api/v1/contacts`, { method: 'POST', headers: auth(friend, { 'Content-Type': 'application/json' }), body: JSON.stringify({ userId: me.user.id }) });

  const upload = await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', headers: auth(me, { 'Content-Type': 'application/octet-stream' }), body: PNG });
  assert.equal(upload.status, 200);
  const { user } = await upload.json();
  assert.match(user.avatar, new RegExp(`^/api/v1/users/${me.user.id}/avatar\\?v=\\d+$`));
  const announced = await until(() => friendSocket.events.find((event) => event.type === 'user:updated' && event.user.id === me.user.id), 'user:updated');
  assert.equal(announced.user.avatar, user.avatar, 'contacts learn the new photo URL immediately');

  const contacts = await (await fetch(`${baseUrl}/api/v1/contacts`, { headers: auth(friend) })).json();
  assert.equal(contacts.find((contact) => contact.id === me.user.id).avatar, user.avatar, 'the photo travels with the contact list');
  const meAgain = await (await fetch(`${baseUrl}/api/v1/me`, { headers: auth(me) })).json();
  assert.equal(meAgain.user.avatar, user.avatar);

  const served = await fetch(baseUrl + user.avatar, { headers: auth(friend) });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('cache-control'), /max-age=86400/);
  assert.equal(Buffer.compare(Buffer.from(await served.arrayBuffer()), PNG), 0);
  assert.equal((await fetch(baseUrl + user.avatar)).status, 401, 'photos need a session');

  const firstFile = service.db.prepare('SELECT avatar_disk_name FROM users WHERE id = ?').get(me.user.id).avatar_disk_name;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replaced = await (await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', headers: auth(me), body: JPEG })).json();
  assert.notEqual(replaced.user.avatar, user.avatar, 'the URL changes so caches refresh');
  assert.equal((await fetch(baseUrl + replaced.user.avatar, { headers: auth(me) })).headers.get('content-type'), 'image/jpeg');
  assert.equal(existsSync(join(service.avatarDirectory, firstFile)), false, 'the replaced file is deleted');
  const secondFile = service.db.prepare('SELECT avatar_disk_name FROM users WHERE id = ?').get(me.user.id).avatar_disk_name;
  assert.ok(existsSync(join(service.avatarDirectory, secondFile)));

  const removed = await (await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'DELETE', headers: auth(me) })).json();
  assert.equal(removed.user.avatar, null);
  assert.equal(existsSync(join(service.avatarDirectory, secondFile)), false, 'removing deletes the file');
  assert.equal((await fetch(baseUrl + replaced.user.avatar, { headers: auth(me) })).status, 404);
  await until(() => friendSocket.events.some((event) => event.type === 'user:updated' && event.user.id === me.user.id && event.user.avatar === null), 'removal announced');
  friendSocket.close();
});

test('only real images within the size limit are accepted as profile photos', async () => {
  const me = await register('me');
  const text = await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', headers: auth(me, { 'Content-Type': 'image/png' }), body: Buffer.from('<svg onload=alert(1)>') });
  assert.equal(text.status, 415, 'the declared type is not trusted');
  const big = await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', headers: auth(me), body: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', body: PNG })).status, 401);
  assert.equal(detectAvatarImage(WEBP)?.type, 'image/webp');
  assert.equal(detectAvatarImage(Buffer.from('GIF89a....'))?.extension, 'gif');
  assert.equal(detectAvatarImage(Buffer.from('RIFF....WAVE')), null, 'other RIFF files are not WebP');
  assert.equal(detectAvatarImage(Buffer.alloc(0)), null);
});

test('display names are validated, change initials, are announced live and make people searchable by name', async () => {
  const me = await register('me');
  const friend = await register('friend');
  const friendSocket = await connectSocket(friend);
  assert.equal(me.user.name, `@${me.user.username}`, 'new accounts start with the handle as their name');
  assert.equal(hasCustomDisplayName(me.user), false);
  assert.equal(presentName(me.user), `@${me.user.username}`);

  const patch = (session, body) => fetch(`${baseUrl}/api/v1/me`, { method: 'PATCH', headers: auth(session, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  assert.equal((await patch(me, { name: '   ' })).status, 400, 'blank names are rejected');
  assert.equal((await patch(me, { name: 'x'.repeat(MAX_DISPLAY_NAME + 1) })).status, 400, 'over-long names are rejected');
  assert.equal((await fetch(`${baseUrl}/api/v1/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Nope"}' })).status, 401);

  const updated = await patch(me, { name: '  Shakil\tAhmed  Khan ' });
  assert.equal(updated.status, 200);
  const { user } = await updated.json();
  assert.equal(user.name, 'Shakil Ahmed Khan', 'whitespace is normalised');
  assert.equal(user.username, me.user.username, 'the handle never changes');
  assert.equal(user.initials, 'SA', 'initials follow the display name');
  assert.equal(hasCustomDisplayName(user), true);
  const announced = await until(() => friendSocket.events.find((event) => event.type === 'user:updated' && event.user.id === me.user.id), 'user:updated');
  assert.equal(announced.user.name, 'Shakil Ahmed Khan', 'everyone online learns the new name immediately');
  const meAgain = await (await fetch(`${baseUrl}/api/v1/me`, { headers: auth(me) })).json();
  assert.equal(meAgain.user.name, 'Shakil Ahmed Khan');

  const search = async (query) => (await (await fetch(`${baseUrl}/api/v1/contacts/search?q=${encodeURIComponent(query)}`, { headers: auth(friend) })).json()).map((row) => row.id);
  assert.ok((await search('ahmed')).includes(me.user.id), 'display names match by substring, case-insensitively');
  assert.ok((await search('Shakil Ahmed')).includes(me.user.id), 'multi-word queries match display names');
  assert.ok((await search(me.user.username.slice(0, 3))).includes(me.user.id), 'handle prefixes still match');
  assert.ok((await search(`@${me.user.username}`)).includes(me.user.id), 'a leading @ is accepted');
  assert.deepEqual(await search('zzz-no-such-person'), []);
  assert.deepEqual(await search(''), []);
  assert.ok(!(await search('ahmed')).includes(friend.user.id), 'the searcher is never returned');

  assert.equal(initialsFor('bob', 'bob'), 'BO');
  assert.equal(initialsFor('@bob', 'bob'), 'BO');
  assert.equal(initialsFor('', 'carol'), 'CA');
  assert.equal(displayNameError('Fine'), '');
  friendSocket.close();
});

test('chats are ordered pinned, then favourites, then the rest, keeping recency inside each band', () => {
  const chats = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
  const ordered = orderChats(chats, { pinnedChatIds: ['e', 'b'], favouriteChatIds: ['f', 'c', 'b'] });
  assert.deepEqual(ordered.map((chat) => chat.id), ['b', 'e', 'c', 'f', 'a', 'd']);
  assert.deepEqual(orderChats(chats).map((chat) => chat.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.notEqual(orderChats(chats), chats, 'the input is not mutated');
});

test('a profile update refreshes the signed-in user and the matching chat row without touching others', () => {
  const initial = useChatStore.getState();
  try {
    useChatStore.setState({
      userId: '',
      user: { id: 'me', name: 'Me', username: 'me', initials: 'ME', color: 'blue', avatar: null },
      chats: [
        { id: 'pal', name: 'Pal', initials: 'PA', color: 'green', avatar: null, preview: 'hi', unread: 1 },
        { id: 'other', name: 'Other', initials: 'OT', color: 'coral', avatar: null, preview: 'yo', unread: 0 },
      ],
    });
    useChatStore.getState().updateUserProfile({ id: 'pal', name: 'Pal', username: 'pal', initials: 'PA', color: 'green', avatar: '/api/v1/users/pal/avatar?v=1' });
    useChatStore.getState().updateUserProfile({ id: 'me', name: 'Me', username: 'me', initials: 'ME', color: 'blue', avatar: '/api/v1/users/me/avatar?v=2' });
    const state = useChatStore.getState();
    assert.equal(state.chats.find((chat) => chat.id === 'pal').avatar, '/api/v1/users/pal/avatar?v=1');
    assert.equal(state.chats.find((chat) => chat.id === 'pal').unread, 1, 'other chat fields are preserved');
    assert.equal(state.chats.find((chat) => chat.id === 'other').avatar, null);
    assert.equal(state.user.avatar, '/api/v1/users/me/avatar?v=2');
    useChatStore.getState().updateUserProfile(null);
  } finally {
    useChatStore.setState(initial, true);
  }
});

test('the UI shows the pencil on the own photo, filled hearts for favourites, and passes photos to every contact avatar', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const profile = await read('../src/components/ProfilePhoto.jsx');
  const avatar = await read('../src/components/Avatar.jsx');
  const drawer = await read('../src/components/ContactInfoDrawer.jsx');
  const list = await read('../src/components/ChatsList.jsx');
  const tools = await read('../src/components/ToolsView.jsx');
  const sidebar = await read('../src/components/Sidebar.jsx');
  const chatWindow = await read('../src/components/ChatWindow.jsx');

  assert.ok(profile.includes('aria-label="Edit profile photo"') && profile.includes('<Pencil size={14} />'));
  assert.ok(profile.includes('accept="image/*" capture="user"') && profile.includes('Choose from gallery') && profile.includes('Remove photo'));
  assert.ok(profile.includes('uploadAvatar(await prepareAvatarBlob(file), sessionToken)'), 'photos are resized before upload');
  assert.ok(tools.includes('<ProfilePhoto size="large" />') && sidebar.includes('<ProfilePhoto size="small"'));
  assert.ok(avatar.includes('useAvatarSrc(image ?? avatar ?? \'\')'), 'server photos load with the session header');

  assert.ok(drawer.includes("iconProps={favourite ? { fill: 'currentColor' } : undefined}"), 'the heart fills when favourited');
  assert.ok(drawer.includes("title={favourite ? 'Remove from favourites' : 'Add to favourites'}"));
  assert.ok(list.includes("import { orderChats } from '../chatOrder.js'") && list.includes('orderChats(chats, { pinnedChatIds, favouriteChatIds })'));
  assert.ok(list.includes('className="wa-row-badge-icon is-favourite" fill="currentColor"'), 'favourite rows show a filled heart');

  for (const [name, source] of [['ChatsList', list], ['ChatWindow', chatWindow], ['ContactInfoDrawer', drawer]]) {
    assert.ok(/image=\{(chat|contact)\.avatar\}/.test(source), `${name} passes the contact photo to Avatar`);
  }
  assert.ok(drawer.includes('<small>Messages are stored on your Hidden Messenger server and are not end-to-end encrypted.</small>'), 'the encryption notice is unchanged');
});

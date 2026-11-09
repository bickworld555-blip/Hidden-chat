// Last seen / online presence with its privacy setting, password change, and linked devices.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { canSeePresence, deviceNameFromUserAgent, presenceFor } from './presence.mjs';
import { formatLastSeen, presenceLine } from '../src/presence.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BP22; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-presence-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'presence.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body, userAgent } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(prefix, userAgent) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD }, userAgent });
  assert.equal(status, 201);
  return body;
}

function connect(session) {
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

const closed = (socket) => new Promise((resolve) => { socket.once('close', (code) => resolve(code)); socket.close(); });
const latest = (socket, userId) => socket.events.filter((event) => event.type === 'presence:update' && event.userId === userId).at(-1);

test('presence rules: privacy decides who sees online and last seen', () => {
  const contacts = new Set(['friend']);
  assert.equal(canSeePresence({ ownerId: 'a', viewerId: 'x', privacy: 'everyone' }), true);
  assert.equal(canSeePresence({ ownerId: 'a', viewerId: 'friend', privacy: 'contacts', ownerContactIds: contacts }), true);
  assert.equal(canSeePresence({ ownerId: 'a', viewerId: 'stranger', privacy: 'contacts', ownerContactIds: contacts }), false);
  assert.equal(canSeePresence({ ownerId: 'a', viewerId: 'friend', privacy: 'nobody', ownerContactIds: contacts }), false);
  assert.equal(canSeePresence({ ownerId: 'a', viewerId: 'a', privacy: 'nobody' }), true);
  assert.deepEqual(presenceFor({ online: true, lastSeenAt: 5, visible: true }), { status: 'online', lastSeenAt: null });
  assert.deepEqual(presenceFor({ online: false, lastSeenAt: 5, visible: true }), { status: 'offline', lastSeenAt: 5 });
  assert.deepEqual(presenceFor({ online: true, lastSeenAt: 5, visible: false }), { status: 'hidden', lastSeenAt: null });
});

test('device names come from the browser and system, with the Android app recognised', () => {
  assert.equal(deviceNameFromUserAgent(CHROME_WINDOWS), 'Chrome on Windows');
  assert.equal(deviceNameFromUserAgent(ANDROID_APP), 'Hidden Messenger app on Android');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Safari/537.36 Edg/140'), 'Edge on Windows');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox on Linux');
  assert.equal(deviceNameFromUserAgent(''), 'Browser');
  assert.equal(deviceNameFromUserAgent(undefined, 'Linked device'), 'Linked device');
});

test('the header line reads "online", "last seen today at …", "… weeks/months ago", or nothing when hidden', () => {
  const now = new Date(2026, 10, 8, 22, 15);
  assert.equal(presenceLine({ status: 'online' }, now), 'online');
  assert.equal(presenceLine({ status: 'hidden' }, now), '');
  assert.equal(presenceLine(undefined, now), '');
  assert.equal(presenceLine({ status: 'offline', lastSeenAt: null }, now), '');
  assert.equal(formatLastSeen(new Date(2026, 10, 8, 21, 33).getTime(), now), 'last seen today at 9:33 pm');
  assert.equal(formatLastSeen(new Date(2026, 10, 8, 0, 5).getTime(), now), 'last seen today at 12:05 am');
  assert.equal(formatLastSeen(new Date(2026, 10, 7, 12, 0).getTime(), now), 'last seen yesterday at 12:00 pm');
  assert.equal(formatLastSeen(new Date(2026, 10, 4, 8, 7).getTime(), now), 'last seen Wednesday at 8:07 am');
  assert.equal(formatLastSeen(new Date(2026, 10, 1, 9, 0).getTime(), now), 'last seen 1 week ago');
  assert.equal(formatLastSeen(new Date(2026, 9, 20, 18, 45).getTime(), now), 'last seen 2 weeks ago');
  assert.equal(formatLastSeen(new Date(2026, 9, 10, 8, 0).getTime(), now), 'last seen 4 weeks ago');
  assert.equal(formatLastSeen(new Date(2026, 9, 5, 8, 0).getTime(), now), 'last seen 1 month ago');
  assert.equal(formatLastSeen(new Date(2026, 4, 1, 8, 0).getTime(), now), 'last seen 6 months ago');
  assert.equal(formatLastSeen(new Date(2025, 9, 31, 23, 59).getTime(), now), 'last seen over a year ago');
  // A clock slightly ahead of this device still reads as today, not "tomorrow".
  assert.equal(formatLastSeen(new Date(2026, 10, 8, 22, 16).getTime(), now), 'last seen today at 10:16 pm');
});

test('a chat partner sees online, then last seen with a time once the other person leaves', async () => {
  const ava = await register('ava');
  const ben = await register('ben');
  assert.equal((await api('/api/v1/contacts', { session: ben, method: 'POST', body: { userId: ava.user.id } })).status, 200);
  const avaSocket = await connect(ava);
  const benSocket = await connect(ben);
  const ready = await until(() => benSocket.events.find((event) => event.type === 'connection:ready'), 'ready');
  assert.deepEqual(ready.presence.find((item) => item.userId === ava.user.id), { userId: ava.user.id, status: 'online', lastSeenAt: null });
  const before = Date.now();
  await closed(avaSocket);
  const offline = await until(() => latest(benSocket, ava.user.id)?.status === 'offline' && latest(benSocket, ava.user.id), 'offline');
  assert.ok(offline.lastSeenAt >= before && offline.lastSeenAt <= Date.now(), 'last seen is when the last connection closed');
  // Reconnecting later still shows the stored last seen for an offline partner.
  await closed(benSocket);
  const again = await connect(ben);
  const snapshot = await until(() => again.events.find((event) => event.type === 'connection:ready'), 'ready again');
  assert.deepEqual(snapshot.presence.find((item) => item.userId === ava.user.id), { userId: ava.user.id, status: 'offline', lastSeenAt: offline.lastSeenAt });
  again.close();
});

test('"Nobody" hides online and last seen from everyone; "My contacts" shows them only to saved contacts', async () => {
  const owner = await register('own');
  const friend = await register('fri');
  const stranger = await register('str');
  assert.equal((await api('/api/v1/me/privacy', { session: owner })).body.lastSeen, 'everyone');
  assert.equal((await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { lastSeen: 'friends' } })).status, 400);
  await api('/api/v1/contacts', { session: owner, method: 'POST', body: { userId: friend.user.id } });
  const friendSocket = await connect(friend);
  const strangerSocket = await connect(stranger);
  await until(() => strangerSocket.events.some((event) => event.type === 'connection:ready'), 'stranger ready');
  const ownerSocket = await connect(owner);
  await until(() => latest(friendSocket, owner.user.id)?.status === 'online', 'friend sees online');
  await until(() => latest(strangerSocket, owner.user.id)?.status === 'online', 'stranger sees online');

  assert.equal((await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { lastSeen: 'contacts' } })).body.lastSeen, 'contacts');
  await until(() => latest(strangerSocket, owner.user.id)?.status === 'hidden', 'stranger loses presence');
  assert.equal(latest(friendSocket, owner.user.id).status, 'online');

  await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { lastSeen: 'nobody' } });
  await until(() => latest(friendSocket, owner.user.id)?.status === 'hidden', 'friend loses presence');
  await closed(ownerSocket);
  await until(() => friendSocket.events.filter((event) => event.userId === owner.user.id).length >= 4, 'offline broadcast');
  for (const socket of [friendSocket, strangerSocket]) {
    const update = latest(socket, owner.user.id);
    assert.deepEqual([update.status, update.lastSeenAt], ['hidden', null], 'no last seen time leaks');
  }
  friendSocket.close();
  strangerSocket.close();
});

test('changing the password needs the current one and signs other devices out', async () => {
  const user = await register('pwd', CHROME_WINDOWS);
  const phone = (await api('/api/v1/auth/login', { method: 'POST', body: { identity: user.user.username, password: PASSWORD }, userAgent: ANDROID_APP })).body;
  const phoneSocket = await connect(phone);
  const wrong = await api('/api/v1/me/password', { session: user, method: 'PUT', body: { currentPassword: 'not-my-password', newPassword: 'Another-Long-Password-7' } });
  assert.equal(wrong.status, 401);
  assert.equal((await api('/api/v1/me/password', { session: user, method: 'PUT', body: { currentPassword: PASSWORD, newPassword: 'short' } })).status, 400);
  assert.equal((await api('/api/v1/me/password', { session: user, method: 'PUT', body: { currentPassword: PASSWORD, newPassword: PASSWORD } })).status, 400);
  const changed = await api('/api/v1/me/password', { session: user, method: 'PUT', body: { currentPassword: PASSWORD, newPassword: 'Another-Long-Password-7' } });
  assert.deepEqual(changed, { status: 200, body: { signedOutDevices: 1 } });
  assert.equal(await new Promise((resolve) => phoneSocket.once('close', resolve)), 4001);
  assert.equal((await api('/api/v1/me', { session: phone })).status, 401);
  assert.equal((await api('/api/v1/me', { session: user })).status, 200);
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: user.user.username, password: PASSWORD } })).status, 401);
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: user.user.username, password: 'Another-Long-Password-7' } })).status, 200);
});

test('linked devices lists every signed-in device and can sign one out remotely', async () => {
  const user = await register('dev', CHROME_WINDOWS);
  const phone = (await api('/api/v1/auth/login', { method: 'POST', body: { identity: user.user.username, password: PASSWORD }, userAgent: ANDROID_APP })).body;
  const phoneSocket = await connect(phone);
  await until(() => phoneSocket.events.some((event) => event.type === 'connection:ready'), 'phone ready');
  const devices = (await api('/api/v1/me/sessions', { session: user })).body;
  assert.deepEqual(devices.map(({ deviceName, current, online }) => ({ deviceName, current, online })), [
    { deviceName: 'Chrome on Windows', current: true, online: false },
    { deviceName: 'Hidden Messenger app on Android', current: false, online: true },
  ]);
  assert.ok(devices.every((device) => typeof device.id === 'string' && device.createdAt > 0 && !('hash' in device)));
  assert.ok(!JSON.stringify(devices).includes(phone.token), 'no credentials are listed');
  assert.equal((await api(`/api/v1/me/sessions/${devices[0].id}`, { session: user, method: 'DELETE' })).status, 400, 'this device uses Log out');
  const other = await register('oth');
  assert.equal((await api(`/api/v1/me/sessions/${devices[1].id}`, { session: other, method: 'DELETE' })).status, 404, 'cannot sign out someone else');
  const closing = new Promise((resolve) => phoneSocket.once('close', resolve));
  assert.equal((await api(`/api/v1/me/sessions/${devices[1].id}`, { session: user, method: 'DELETE' })).status, 204);
  assert.equal(await closing, 4001);
  assert.equal((await api('/api/v1/me', { session: phone })).status, 401);
  assert.equal((await api('/api/v1/me/sessions', { session: user })).body.length, 1);
});

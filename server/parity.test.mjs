// WhatsApp (Business) parity features on the server: message edits, account-synced stars, archived chats, pinned
// messages, group administration and invite links, communities, the business suite and two-step verification.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createLoginThrottle, isEditableText, pairKey, parseChatKey, validPin } from './parity.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let service;
let directory;
let baseUrl;
let counter = 0;
const sockets = [];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-parity-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  for (const socket of sockets) socket.close();
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body, raw } = {}) {
  const headers = { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(baseUrl + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
async function register(prefix = 'p') {
  counter += 1;
  const username = `${prefix}${counter}`;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201, JSON.stringify(body));
  return { ...body, username };
}
async function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  sockets.push(socket);
  return socket;
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
async function sendDirect(socket, receiverId, content) {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  socket.send(JSON.stringify({ type: 'message:send', message: { id, receiverId, content } }));
  await until(() => socket.events.find((event) => event.type === 'message:ack' && event.message.id === id), `ack of ${content}`);
  return id;
}
async function createGroup(owner, members, name = 'Team') {
  const { status, body } = await api('/api/v1/groups', { session: owner, method: 'POST', body: { name, memberIds: members.map((member) => member.user.id) } });
  assert.equal(status, 201);
  return body.id;
}

test('pure rules: editable text, chat keys, PINs and the sign-in throttle', () => {
  assert.equal(isEditableText('hello: world'), true);
  for (const content of ['media:x:a.png', 'voice:x:3', 'poll:{}', 'sticker:hearts/love', 'product:abc', 'call:audio:ended:0', '']) assert.equal(isEditableText(content), false, content);
  assert.deepEqual(parseChatKey('group:abc-1'), { kind: 'group', id: 'abc-1', key: 'group:abc-1' });
  assert.equal(parseChatKey('a b'), null);
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'));
  assert.equal(validPin('123456'), true);
  assert.equal(validPin('12345'), false);
  assert.equal(validPin(123456), false);
  let clock = 0;
  const throttle = createLoginThrottle({ now: () => clock, freeAttempts: 2, baseMs: 1000, maxMs: 4000 });
  throttle.fail(['k']);
  assert.equal(throttle.retryAfter(['k']), 0);
  throttle.fail(['k']);
  assert.equal(throttle.retryAfter(['k']), 1000, 'after the free attempts');
  throttle.fail(['k']); throttle.fail(['k']); throttle.fail(['k']);
  assert.equal(throttle.retryAfter(['k']), 4000, 'capped');
  clock = 5000;
  assert.equal(throttle.retryAfter(['k']), 0);
  throttle.succeed(['k']);
  throttle.fail(['k']);
  assert.equal(throttle.retryAfter(['k']), 0, 'a success resets the count');
});

test('a sender edits their text message; both people see it with its edit time, others cannot', async () => {
  const ana = await register('ed');
  const ben = await register('ed');
  const anaSocket = await connect(ana);
  const benSocket = await connect(ben);
  const id = await sendDirect(anaSocket, ben.user.id, 'See you at 5');
  const edited = await api(`/api/v1/messages/${id}`, { session: ana, method: 'PUT', body: { content: 'See you at 6' } });
  assert.equal(edited.status, 200);
  const event = await until(() => benSocket.events.find((item) => item.type === 'message:edited' && item.messageId === id), 'edit event');
  assert.equal(event.content, 'See you at 6');
  assert.ok(Date.parse(event.editedAt));
  assert.equal((await api(`/api/v1/messages/${id}`, { session: ben, method: 'PUT', body: { content: 'hijack' } })).status, 403);
  assert.equal((await api(`/api/v1/messages/${id}`, { session: ana, method: 'PUT', body: { content: 'media:abc:x.png' } })).status, 400);
  const history = (await api(`/api/v1/messages?peerId=${ben.user.id}`, { session: ana })).body;
  const stored = (Array.isArray(history) ? history : history.messages ?? []).find((message) => message.id === id);
  assert.equal(stored.content, 'See you at 6');
  assert.ok(stored.editedAt);
  const media = await sendDirect(anaSocket, ben.user.id, 'sticker:hearts/love');
  assert.equal((await api(`/api/v1/messages/${media}`, { session: ana, method: 'PUT', body: { content: 'text' } })).status, 400, 'stickers are not edited');
});

test('stars follow the account, only for messages the person can see', async () => {
  const ana = await register('st');
  const ben = await register('st');
  const eve = await register('st');
  const anaSocket = await connect(ana);
  const id = await sendDirect(anaSocket, ben.user.id, 'Important address');
  assert.equal((await api(`/api/v1/stars/${id}`, { session: eve, method: 'PUT' })).status, 404, 'a stranger cannot star it');
  assert.equal((await api(`/api/v1/stars/${id}`, { session: ben, method: 'PUT' })).status, 200);
  const list = (await api('/api/v1/stars', { session: ben })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].content, 'Important address');
  assert.equal(list[0].chatKey, ana.user.id);
  const groupId = await createGroup(ana, [ben]);
  const posted = (await api(`/api/v1/groups/${groupId}/messages`, { session: ana, method: 'POST', body: { content: 'Group note' } })).body;
  assert.equal((await api(`/api/v1/stars/${posted.id}`, { session: ben, method: 'PUT' })).status, 200);
  const both = (await api('/api/v1/stars', { session: ben })).body;
  assert.deepEqual(both.map((item) => item.chatKey).sort(), [ana.user.id, `group:${groupId}`].sort());
  assert.equal(both.find((item) => item.chatKey.startsWith('group:')).groupName, 'Team');
  await api(`/api/v1/stars/${id}`, { session: ben, method: 'DELETE' });
  assert.equal((await api('/api/v1/stars', { session: ben })).body.length, 1);
});

test('archived chats are kept per account', async () => {
  const ana = await register('ar');
  assert.equal((await api('/api/v1/chat-prefs/group:abc', { session: ana, method: 'PUT', body: { archived: true } })).status, 200);
  assert.equal((await api('/api/v1/chat-prefs/someone', { session: ana, method: 'PUT', body: { archived: true } })).status, 200);
  await api('/api/v1/chat-prefs/someone', { session: ana, method: 'PUT', body: { archived: false } });
  assert.deepEqual((await api('/api/v1/chat-prefs', { session: ana })).body, { archived: ['group:abc'] });
  assert.equal((await api('/api/v1/chat-prefs/bad%20key', { session: ana, method: 'PUT', body: { archived: true } })).status, 400);
});

test('pinned messages are shared by both people, up to three per chat', async () => {
  const ana = await register('pn');
  const ben = await register('pn');
  const anaSocket = await connect(ana);
  const benSocket = await connect(ben);
  const ids = [];
  for (const text of ['one', 'two', 'three', 'four']) ids.push(await sendDirect(anaSocket, ben.user.id, text));
  for (const id of ids) {
    assert.equal((await api(`/api/v1/pins/${ben.user.id}/${id}`, { session: ana, method: 'PUT' })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await until(() => benSocket.events.some((event) => event.type === 'pins:changed'), 'pin event');
  const seenByBen = (await api(`/api/v1/pins/${ana.user.id}`, { session: ben })).body.map((pin) => pin.messageId);
  assert.deepEqual(seenByBen, [ids[3], ids[2], ids[1]], 'the oldest pin made way');
  const other = await register('pn');
  assert.equal((await api(`/api/v1/pins/${other.user.id}/${ids[0]}`, { session: ana, method: 'PUT' })).status, 404, 'a message from another chat');
  await api(`/api/v1/pins/${ana.user.id}/${ids[3]}`, { session: ben, method: 'DELETE' });
  assert.equal((await api(`/api/v1/pins/${ben.user.id}`, { session: ana })).body.length, 2);
  // A pinned message deleted for everyone stops being listed.
  anaSocket.send(JSON.stringify({ type: 'message:delete', messageId: ids[2], scope: 'everyone' }));
  await until(() => benSocket.events.some((event) => event.type === 'message:deleted' && event.messageId === ids[2]), 'deletion');
  assert.deepEqual((await api(`/api/v1/pins/${ana.user.id}`, { session: ben })).body.map((pin) => pin.messageId), [ids[1]]);
});

test('group admins manage roles, removals, permissions; only admins send when restricted', async () => {
  const ana = await register('ga');
  const ben = await register('ga');
  const cy = await register('ga');
  const groupId = await createGroup(ana, [ben, cy]);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${cy.user.id}/role`, { session: ben, method: 'PUT', body: { role: 'admin' } })).status, 403);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${ben.user.id}/role`, { session: ana, method: 'PUT', body: { role: 'admin' } })).status, 200);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${ana.user.id}/role`, { session: ben, method: 'PUT', body: { role: 'member' } })).status, 403, 'the creator stays admin');
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${ben.user.id}/role`, { session: ana, method: 'PUT', body: { role: 'member' } })).status, 200);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${ana.user.id}/role`, { session: ana, method: 'PUT', body: { role: 'member' } })).status, 409, 'at least one admin');

  assert.equal((await api(`/api/v1/groups/${groupId}/permissions`, { session: ben, method: 'PUT', body: { onlyAdminsSend: true } })).status, 403);
  const permissions = await api(`/api/v1/groups/${groupId}/permissions`, { session: ana, method: 'PUT', body: { onlyAdminsSend: true, onlyAdminsEdit: true } });
  assert.deepEqual(permissions.body, { onlyAdminsSend: true, onlyAdminsEdit: true, approveJoins: false });
  assert.equal((await api(`/api/v1/groups/${groupId}/messages`, { session: ben, method: 'POST', body: { content: 'hi' } })).status, 403);
  assert.equal((await api(`/api/v1/groups/${groupId}/messages`, { session: ana, method: 'POST', body: { content: 'announcement' } })).status, 201);
  assert.equal((await api(`/api/v1/groups/${groupId}/info`, { session: ben, method: 'PUT', body: { name: 'Mine now' } })).status, 403);
  const info = await api(`/api/v1/groups/${groupId}/info`, { session: ana, method: 'PUT', body: { name: 'Team HQ', description: 'Weekly plans' } });
  assert.deepEqual(info.body, { name: 'Team HQ', description: 'Weekly plans' });
  const details = (await api(`/api/v1/groups/${groupId}`, { session: ben })).body;
  assert.equal(details.description, 'Weekly plans');
  assert.equal(details.onlyAdminsSend, true);
  assert.equal(details.inviteCode, undefined, 'members do not see the invite code');

  assert.equal((await api(`/api/v1/groups/${groupId}/members/${cy.user.id}`, { session: ben, method: 'DELETE' })).status, 403);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${ana.user.id}`, { session: ana, method: 'DELETE' })).status, 400);
  assert.equal((await api(`/api/v1/groups/${groupId}/members/${cy.user.id}`, { session: ana, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/v1/groups/${groupId}`, { session: cy })).status, 404, 'removed member loses access');

  // The last admin may leave: the longest-standing member becomes admin.
  assert.equal((await api(`/api/v1/groups/${groupId}/membership`, { session: ana, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/v1/groups/${groupId}`, { session: ben })).body.role, 'admin');
});

test('invite links: preview, join, approval requests, reset', async () => {
  const ana = await register('in');
  const ben = await register('in');
  const cy = await register('in');
  const groupId = await createGroup(ana, [], 'Book club');
  const { inviteCode } = (await api(`/api/v1/groups/${groupId}/invite`, { session: ana, method: 'POST' })).body;
  assert.match(inviteCode, /^[A-Za-z0-9_-]{16,}$/);
  const preview = (await api(`/api/v1/invites/${inviteCode}`, { session: ben })).body;
  assert.equal(preview.name, 'Book club');
  assert.equal(preview.member, false);
  assert.deepEqual((await api(`/api/v1/invites/${inviteCode}/join`, { session: ben, method: 'POST' })).body, { joined: true, groupId });

  await api(`/api/v1/groups/${groupId}/permissions`, { session: ana, method: 'PUT', body: { approveJoins: true } });
  const anaSocket = await connect(ana);
  const requested = await api(`/api/v1/invites/${inviteCode}/join`, { session: cy, method: 'POST' });
  assert.equal(requested.status, 202);
  await until(() => anaSocket.events.some((event) => event.type === 'group:join-request'), 'admin hears of the request');
  assert.equal((await api(`/api/v1/groups/${groupId}`, { session: ana })).body.pendingRequests, 1);
  assert.equal((await api(`/api/v1/groups/${groupId}/requests`, { session: ben })).status, 403);
  const pending = (await api(`/api/v1/groups/${groupId}/requests`, { session: ana })).body;
  assert.deepEqual(pending.map((person) => person.id), [cy.user.id]);
  assert.equal((await api(`/api/v1/groups/${groupId}/requests/${cy.user.id}`, { session: ana, method: 'POST', body: { approve: true } })).status, 200);
  assert.equal((await api(`/api/v1/groups/${groupId}`, { session: cy })).status, 200);

  await api(`/api/v1/groups/${groupId}/invite`, { session: ana, method: 'POST' });
  assert.equal((await api(`/api/v1/invites/${inviteCode}`, { session: cy })).status, 404, 'a reset link stops working');
});

test('communities: announcement group, member sync, adding and joining groups', async () => {
  const ana = await register('cm');
  const ben = await register('cm');
  const cy = await register('cm');
  const groupId = await createGroup(ana, [ben], 'Parents');
  const community = (await api('/api/v1/communities', { session: ana, method: 'POST', body: { name: 'School', description: 'Year 5', groupIds: [groupId] } })).body;
  assert.equal(community.role, 'admin');
  const announcement = community.groups.find((group) => group.isAnnouncement);
  assert.ok(announcement);
  const benView = (await api(`/api/v1/communities/${community.id}`, { session: ben })).body;
  assert.equal(benView.role, 'member');
  assert.equal(benView.groups.find((group) => group.isAnnouncement).role, 'member', 'group members join the announcement group');
  assert.equal((await api(`/api/v1/groups/${announcement.id}/messages`, { session: ben, method: 'POST', body: { content: 'hi all' } })).status, 403);
  assert.equal((await api(`/api/v1/groups/${announcement.id}/messages`, { session: ana, method: 'POST', body: { content: 'Trip on Friday' } })).status, 201);
  assert.equal((await api(`/api/v1/communities/${community.id}`, { session: cy })).status, 404);

  const added = (await api(`/api/v1/communities/${community.id}/groups`, { session: ana, method: 'POST', body: { name: 'Sports day' } })).body;
  const sports = added.groups.find((group) => group.name === 'Sports day');
  assert.equal((await api(`/api/v1/communities/${community.id}/groups/${sports.id}/join`, { session: ben, method: 'POST' })).body.joined, true);
  assert.equal((await api(`/api/v1/communities/${community.id}/groups`, { session: ben, method: 'POST', body: { name: 'x' } })).status, 403);
  assert.deepEqual((await api('/api/v1/communities', { session: ben })).body.map((item) => item.name), ['School']);

  // A person added to a community group becomes a community member.
  await api(`/api/v1/groups/${groupId}/members`, { session: ana, method: 'POST', body: { userId: cy.user.id } });
  assert.equal((await api(`/api/v1/communities/${community.id}`, { session: cy })).body.groups.find((group) => group.isAnnouncement).role, 'member');
  assert.equal((await api(`/api/v1/communities/${community.id}/groups/${announcement.id}`, { session: ana, method: 'DELETE' })).status, 409);
  assert.equal((await api(`/api/v1/communities/${community.id}`, { session: ana, method: 'DELETE' })).status, 204);
  assert.deepEqual((await api('/api/v1/communities', { session: ana })).body, []);
});

test('catalog: items with prices and photos; hidden items stay private; products can be shared', async () => {
  const shop = await register('ca');
  const buyer = await register('ca');
  assert.equal((await api('/api/v1/catalog', { session: shop, method: 'POST', body: { name: 'Cake', price: '12.5' } })).status, 400, 'a price needs a currency');
  assert.equal((await api('/api/v1/catalog', { session: shop, method: 'POST', body: { name: 'Cake', price: 'free', currency: 'USD' } })).status, 400);
  const cake = (await api('/api/v1/catalog', { session: shop, method: 'POST', body: { name: 'Cake', price: '12.50', currency: 'usd', description: 'Chocolate' } })).body;
  assert.equal(cake.currency, 'USD');
  const secret = (await api('/api/v1/catalog', { session: shop, method: 'POST', body: { name: 'Prototype', hidden: true } })).body;
  assert.equal((await api(`/api/v1/catalog/${cake.id}/image`, { session: shop, method: 'PUT', raw: Buffer.from('not an image') })).status, 415);
  const withImage = (await api(`/api/v1/catalog/${cake.id}/image`, { session: shop, method: 'PUT', raw: PNG })).body;
  assert.ok(withImage.image);
  const image = await fetch(baseUrl + withImage.image, { headers: { Authorization: `Bearer ${buyer.token}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual((await api(`/api/v1/users/${shop.user.id}/catalog`, { session: buyer })).body.map((item) => item.name), ['Cake']);
  assert.equal((await api(`/api/v1/users/${shop.user.id}/catalog`, { session: shop })).body.length, 2);
  assert.equal((await api(`/api/v1/catalog/${secret.id}`, { session: buyer })).status, 404);
  assert.equal((await api(`/api/v1/catalog/${cake.id}`, { session: buyer })).body.owner.id, shop.user.id);
  assert.equal((await api(`/api/v1/catalog/${cake.id}`, { session: buyer, method: 'PUT', body: { name: 'Mine' } })).status, 404);
  assert.equal((await api(`/api/v1/catalog/${cake.id}`, { session: shop, method: 'PUT', body: { price: '' } })).body.price, '');
  assert.equal((await api(`/api/v1/catalog/${cake.id}`, { session: shop, method: 'DELETE' })).status, 204);
});

test('labels and quick replies belong to their owner and are validated', async () => {
  const ana = await register('lb');
  const ben = await register('lb');
  const label = (await api('/api/v1/labels', { session: ana, method: 'POST', body: { name: 'New customer', color: 3 } })).body;
  assert.equal((await api('/api/v1/labels', { session: ana, method: 'POST', body: { name: 'new CUSTOMER', color: 1 } })).status, 409);
  assert.equal((await api('/api/v1/labels', { session: ana, method: 'POST', body: { name: 'Bad', color: 99 } })).status, 400);
  await api(`/api/v1/labels/${label.id}/chats/${ben.user.id}`, { session: ana, method: 'PUT', body: { assigned: true } });
  await api(`/api/v1/labels/${label.id}/chats/group:xyz`, { session: ana, method: 'PUT', body: { assigned: true } });
  assert.deepEqual((await api('/api/v1/labels', { session: ana })).body[0].chatKeys.sort(), [ben.user.id, 'group:xyz'].sort());
  assert.equal((await api(`/api/v1/labels/${label.id}`, { session: ben, method: 'PUT', body: { name: 'x' } })).status, 404);
  await api(`/api/v1/labels/${label.id}`, { session: ana, method: 'DELETE' });
  assert.deepEqual((await api('/api/v1/labels', { session: ana })).body, []);

  const reply = (await api('/api/v1/quick-replies', { session: ana, method: 'POST', body: { shortcut: '/Thanks', text: 'Thank you for your order!' } })).body;
  assert.equal(reply.shortcut, 'thanks');
  assert.equal((await api('/api/v1/quick-replies', { session: ana, method: 'POST', body: { shortcut: 'thanks', text: 'again' } })).status, 409);
  assert.equal((await api('/api/v1/quick-replies', { session: ana, method: 'POST', body: { shortcut: 'two words', text: 'x' } })).status, 400);
  assert.equal((await api(`/api/v1/quick-replies/${reply.id}`, { session: ana, method: 'PUT', body: { text: 'Thanks!' } })).body.text, 'Thanks!');
  assert.deepEqual((await api('/api/v1/quick-replies', { session: ben })).body, []);
});

test('greeting and away messages reply automatically, without repeating', async () => {
  const shop = await register('aw');
  const customer = await register('aw');
  assert.equal((await api('/api/v1/business', { session: shop, method: 'PUT', body: { away: { enabled: true, text: '' } } })).status, 400, 'a message is needed to turn it on');
  const saved = (await api('/api/v1/business', { session: shop, method: 'PUT', body: { greeting: { enabled: true, text: 'Welcome to our shop!' }, away: { enabled: true, text: 'We are closed now.', schedule: 'always' } } })).body;
  assert.deepEqual(saved, { away: { enabled: true, text: 'We are closed now.', schedule: 'always', hours: null }, greeting: { enabled: true, text: 'Welcome to our shop!' } });
  const customerSocket = await connect(customer);
  await sendDirect(customerSocket, shop.user.id, 'Hello, are you open?');
  await until(() => customerSocket.events.some((event) => event.type === 'message:new' && event.message.content === 'Welcome to our shop!'), 'greeting');
  await until(() => customerSocket.events.some((event) => event.type === 'message:new' && event.message.content === 'We are closed now.'), 'away message');
  const before = customerSocket.events.filter((event) => event.type === 'message:new' && event.message.senderId === shop.user.id).length;
  await sendDirect(customerSocket, shop.user.id, 'Hello again');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(customerSocket.events.filter((event) => event.type === 'message:new' && event.message.senderId === shop.user.id).length, before, 'no repeats');

  // "When offline": not sent while the business has the app open.
  const shop2 = await register('aw');
  await api('/api/v1/business', { session: shop2, method: 'PUT', body: { away: { enabled: true, text: 'Back soon', schedule: 'offline' } } });
  await connect(shop2);
  await sendDirect(customerSocket, shop2.user.id, 'Hi');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(customerSocket.events.some((event) => event.message?.content === 'Back soon'), false);
});

test('two-step verification: a 6-digit PIN set with the password and asked at sign-in, with throttled guesses', async () => {
  const ana = await register('ts');
  assert.equal((await api('/api/v1/me/two-step', { session: ana, method: 'PUT', body: { pin: '123456', password: 'wrong' } })).status, 403);
  assert.equal((await api('/api/v1/me/two-step', { session: ana, method: 'PUT', body: { pin: '1234', password: PASSWORD } })).status, 400);
  assert.equal((await api('/api/v1/me/two-step', { session: ana, method: 'PUT', body: { pin: '246810', password: PASSWORD } })).body.enabled, true);
  assert.equal((await api('/api/v1/me/two-step', { session: ana })).body.enabled, true);

  const login = (pin) => api('/api/v1/auth/login', { method: 'POST', body: { identity: ana.username, password: PASSWORD, ...(pin === undefined ? {} : { pin }) } });
  const asked = await login();
  assert.equal(asked.status, 401);
  assert.equal(asked.body.twoStepRequired, true);
  assert.equal((await login('000000')).body.wrongPin, true);
  const signedIn = await login('246810');
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.body.token);

  assert.equal((await api('/api/v1/me/two-step/verify', { session: ana, method: 'POST', body: { pin: '246810' } })).body.correct, true);
  assert.equal((await api('/api/v1/me/two-step/verify', { session: ana, method: 'POST', body: { pin: '111111' } })).status, 400);

  for (let attempt = 0; attempt < 5; attempt += 1) await login('999999');
  const throttled = await login('246810');
  assert.equal(throttled.status, 429, 'even the right PIN waits after repeated failures');
  assert.ok(throttled.body.retryAfterMs > 0);

  assert.equal((await api('/api/v1/me/two-step', { session: ana, method: 'DELETE', body: { password: PASSWORD } })).body.enabled, false);
});

test('repeated wrong passwords are throttled per account', async () => {
  const ana = await register('th');
  const attempt = (password) => api('/api/v1/auth/login', { method: 'POST', body: { identity: ana.username, password } });
  for (let index = 0; index < 5; index += 1) assert.equal((await attempt('nope-nope')).status, 401);
  assert.equal((await attempt(PASSWORD)).status, 429);
});

test('business hours: away messages only outside opening hours, in the business time zone', async () => {
  const { parseBusinessHours, withinBusinessHours } = await import('./parity.mjs');
  const hours = parseBusinessHours({ timeZone: 'Asia/Dhaka', days: { 1: [540, 1080] } });
  // Monday 2026-11-09 10:00 in Dhaka (UTC+6) = 04:00 UTC; 19:00 Dhaka = 13:00 UTC; Sunday is closed.
  assert.equal(withinBusinessHours(hours, Date.UTC(2026, 10, 9, 4, 0)), true);
  assert.equal(withinBusinessHours(hours, Date.UTC(2026, 10, 9, 13, 0)), false);
  assert.equal(withinBusinessHours(hours, Date.UTC(2026, 10, 8, 4, 0)), false);
  assert.equal(parseBusinessHours(null), null);
  assert.equal(parseBusinessHours({ timeZone: 'Mars/Base', days: {} }), undefined);
  assert.equal(parseBusinessHours({ timeZone: 'UTC', days: { 1: [600, 500] } }), undefined, 'closing must follow opening');
  assert.equal(parseBusinessHours({ timeZone: 'UTC', days: { 9: [1, 2] } }), undefined);
});

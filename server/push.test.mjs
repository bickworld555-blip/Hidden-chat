// Firebase push (WhatsApp-style): a phone with no app on screen is woken by an encrypted push for messages,
// reactions and calls; a call offer is kept for a phone that connects after the push; sign-out forgets the phone.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createPushSender, encryptForDevice, loadServiceAccount, pushBody, validDeviceKey } from './push.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const sent = [];
const fakePush = { send: async (token, data, options) => { sent.push({ token, data, options }); return token.startsWith('gone-') ? { ok: false, invalidToken: true } : { ok: true }; } };
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-push-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: fakePush });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function register(prefix) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  return body;
}
function connect(session, protocols = []) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1', ...protocols]);
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
function decrypt(key, data) {
  const blob = Buffer.from(data.enc, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString('utf8'));
}
async function pair() {
  const a = await register('pusha');
  const b = await register('pushb');
  await api('/api/v1/contacts', { session: a, method: 'POST', body: { userId: b.user.id } });
  await api('/api/v1/contacts', { session: b, method: 'POST', body: { userId: a.user.id } });
  const key = randomBytes(32).toString('base64');
  const token = `fcm-${randomBytes(12).toString('hex')}`;
  // Registered by a current app (wire version 3): its push handler confirms calls.
  const response = await fetch(baseUrl + '/api/v1/push/devices', { method: 'POST', headers: { 'X-HM-Client': '3', Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key, platform: 'android' }) });
  const registered = { status: response.status, body: await response.json() };
  assert.equal(registered.status, 200);
  assert.deepEqual(registered.body, { push: true }, 'the phone learns this server sends pushes');
  return { a, b, key, token };
}
const pushesTo = (token) => sent.filter((item) => item.token === token);

test('a message to a phone with no app on screen is pushed, encrypted for that phone only', async () => {
  const { a, b, key, token } = await pair();
  const sender = await connect(a);
  await until(() => sender.events.some((event) => event.type === 'connection:ready'), 'ready');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'push-msg-1', receiverId: b.user.id, content: 'Hello 👋 secret' } }));
  const push = await until(() => pushesTo(token).find((item) => decrypt(key, item.data).t === 'msg'), 'message push');
  assert.equal(push.options.collapseKey, undefined, 'no collapse key: Firebase keeps only 4 collapse keys for an offline phone, but up to 100 plain pushes');
  assert.ok(!JSON.stringify(push.data).includes('secret'), 'Google sees no message text');
  assert.deepEqual(Object.keys(push.data).sort(), ['enc', 'iv'], 'nor the push type or any id: only the ciphertext');
  const body = decrypt(key, push.data);
  // Content-free: a wake-up with the ids only. The phone shows the name it keeps locally; even our server's push
  // key (known to the server) opens no text, name or photo.
  assert.deepEqual(body, { t: 'msg', id: 'push-msg-1', from: a.user.id });

  // Two ticks from the push, over HTTP (no socket needed on the phone).
  const delivered = await api('/api/v1/messages/delivered', { session: b, method: 'POST', body: { messageIds: ['push-msg-1'] } });
  assert.deepEqual(delivered.body, { delivered: 1 });
  await until(() => sender.events.some((event) => event.type === 'message:status' && event.messageId === 'push-msg-1' && event.status === 'delivered'), 'two ticks');

  // With the app on screen there is no push.
  const open = await connect(b);
  await until(() => open.events.some((event) => event.type === 'connection:ready'), 'b ready');
  const before = pushesTo(token).length;
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'push-msg-2', receiverId: b.user.id, content: 'hello' } }));
  await until(() => open.events.some((event) => event.type === 'message:new' && event.message.id === 'push-msg-2'), 'live message');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pushesTo(token).length, before, 'no push while the app is on screen');
  // In the background (frozen apps cannot be trusted to show it) the push comes back.
  open.send(JSON.stringify({ type: 'client:state', visibility: 'hidden', idle: false }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'push-msg-3', receiverId: b.user.id, content: 'later' } }));
  await until(() => pushesTo(token).some((item) => decrypt(key, item.data).t === 'msg' && decrypt(key, item.data).id === 'push-msg-3'), 'background push');
  open.close();
  sender.close();
});

test('a call rings a sleeping phone by push; the phone connecting later still gets the offer; the end is pushed too', async () => {
  const { a, b, key, token } = await pair();
  const caller = await connect(a);
  await until(() => caller.events.some((event) => event.type === 'connection:ready'), 'ready');
  const callId = `push-call-${Date.now()}`;
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId, mode: 'video', signalId: 's1', signal: { type: 'offer', sdp: 'v=0 fake' } }));
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId, mode: 'video', signalId: 's2', signal: { type: 'ice', candidate: { candidate: 'c1' } } }));
  const push = await until(() => pushesTo(token).find((item) => decrypt(key, item.data).t === 'call'), 'call push');
  const body = decrypt(key, push.data);
  assert.deepEqual(body, { t: 'call', callId, from: a.user.id, mode: 'video' }, 'no caller name or photo: the phone names the caller itself');
  assert.equal(push.options.ttlSeconds, 45, 'a call push is useless after the ring');
  // Firebase accepting the push proves nothing (it queues for phones that are offline): no "Ringing" yet.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!caller.events.some((event) => event.type === 'call:signal' && event.callId === callId && event.signal.type === 'ringing'), 'not ringing before the phone confirms');
  // The phone's push handler confirms it rang (PushService): now the caller hears ringing.
  assert.equal((await api(`/api/v1/calls/${callId}/ringing`, { session: b, method: 'POST' })).status, 204);
  await until(() => caller.events.some((event) => event.type === 'call:signal' && event.callId === callId && event.signal.type === 'ringing'), 'the caller hears ringing');

  // The phone, woken by the push, connects its background socket: the kept offer and candidate arrive.
  const phone = await connect(b, ['relay.background']);
  const offer = await until(() => phone.events.find((event) => event.type === 'call:signal' && event.callId === callId && event.signal.type === 'offer'), 'held offer');
  assert.equal(offer.fromUser?.id, a.user.id);
  await until(() => phone.events.some((event) => event.type === 'call:signal' && event.callId === callId && event.signal.type === 'ice'), 'held candidate');

  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId, mode: 'video', signalId: 's3', signal: { type: 'end', reason: 'ended' } }));
  const end = await until(() => pushesTo(token).find((item) => decrypt(key, item.data).t === 'call_end'), 'call end push');
  assert.equal(decrypt(key, end.data).callId, callId);
  phone.close();

  // Declined from the push-rung call screen before any socket connected: the caller hears it straight away.
  const second = `push-call-2-${Date.now()}`;
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: second, mode: 'audio', signalId: 't1', signal: { type: 'offer', sdp: 'v=0' } }));
  await until(() => pushesTo(token).some((item) => decrypt(key, item.data).t === 'call' && decrypt(key, item.data).callId === second), 'second call push');
  assert.equal((await api(`/api/v1/calls/${second}/decline`, { session: b, method: 'POST' })).status, 204);
  await until(() => caller.events.some((event) => event.type === 'call:signal' && event.callId === second && event.signal.type === 'end'), 'caller hears the decline');
  assert.equal((await api(`/api/v1/calls/${second}/decline`, { session: a, method: 'POST' })).status, 404, 'only the callee can decline');
  caller.close();
});

test('reactions to my message are pushed; a phone the app is gone from is forgotten; sign-out forgets the phone', async () => {
  const { a, b, key, token } = await pair();
  const reader = await connect(a);
  const author = await connect(b);
  await until(() => author.events.some((event) => event.type === 'connection:ready'), 'b ready');
  author.send(JSON.stringify({ type: 'message:send', message: { id: 'push-react-target', receiverId: a.user.id, content: 'photo time' } }));
  await until(() => reader.events.some((event) => event.type === 'message:new' && event.message.id === 'push-react-target'), 'delivered');
  author.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  reader.send(JSON.stringify({ type: 'message:reaction', messageId: 'push-react-target', emoji: '❤️' }));
  const push = await until(() => pushesTo(token).find((item) => decrypt(key, item.data).t === 'react'), 'reaction push');
  assert.deepEqual(decrypt(key, push.data), { t: 'react', id: 'push-react-target', from: a.user.id }, 'no emoji, no quoted text');

  // An uninstalled app's token is dropped on the first failed send.
  const gone = `gone-${randomBytes(8).toString('hex')}`;
  await api('/api/v1/push/devices', { session: b, method: 'POST', body: { token: gone, key, platform: 'android' } });
  reader.send(JSON.stringify({ type: 'message:send', message: { id: 'push-gone-1', receiverId: b.user.id, content: 'x' } }));
  await until(() => pushesTo(gone).length === 1, 'tried the gone token');
  reader.send(JSON.stringify({ type: 'message:send', message: { id: 'push-gone-2', receiverId: b.user.id, content: 'y' } }));
  await until(() => pushesTo(token).some((item) => decrypt(key, item.data).t === 'msg' && decrypt(key, item.data).id === 'push-gone-2'), 'second push');
  assert.equal(pushesTo(gone).length, 1, 'never tried again');

  // Signing out of that session forgets the phone.
  assert.equal((await api('/api/v1/auth/logout', { session: b, method: 'POST' })).status, 204);
  const before = pushesTo(token).length;
  reader.send(JSON.stringify({ type: 'message:send', message: { id: 'push-after-logout', receiverId: b.user.id, content: 'z' } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pushesTo(token).length, before);
  reader.close();
});

test('device registration rejects bad input and needs a session', async () => {
  const user = await register('pushreg');
  assert.equal((await api('/api/v1/push/devices', { method: 'POST', body: { token: 'x'.repeat(30), key: randomBytes(32).toString('base64'), platform: 'android' } })).status, 401);
  assert.equal((await api('/api/v1/push/devices', { session: user, method: 'POST', body: { token: 'x'.repeat(30), key: 'short', platform: 'android' } })).status, 400);
  assert.equal((await api('/api/v1/push/devices', { session: user, method: 'POST', body: { token: 'x'.repeat(30), key: randomBytes(32).toString('base64'), platform: 'ios' } })).status, 400);
  assert.equal(validDeviceKey(randomBytes(32).toString('base64')), true);
  assert.equal(validDeviceKey(randomBytes(16).toString('base64')), false);
});

test('the FCM sender signs in with the service account (RS256 JWT) and sends high-priority data messages', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { project_id: 'hidden-test', client_email: 'push@hidden-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  assert.deepEqual(loadServiceAccount({ FCM_SERVICE_ACCOUNT: JSON.stringify(account) }).project_id, 'hidden-test');
  assert.equal(loadServiceAccount({}), null, 'no account: push stays off');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
    if (JSON.parse(init.body).message.token === 'dead') return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    return new Response('{}', { status: 200 });
  };
  const sender = createPushSender({ serviceAccount: account, fetchImpl });
  assert.deepEqual(await sender.send('tok', { enc: 'x', iv: 'y' }, { collapseKey: 'chat:1' }), { ok: true });
  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const [header, claims, signature] = assertion.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')), 'signed with the account key');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/hidden-test/messages:send');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ya29.test');
  const message = JSON.parse(calls[1].init.body).message;
  assert.deepEqual([message.token, message.android.priority, message.android.ttl, message.android.collapse_key], ['tok', 'HIGH', '2419200s', 'chat:1'], 'kept 4 weeks for an offline phone (it was 60 s: everything was lost after a minute offline)');
  assert.deepEqual(await sender.send('dead', { t: 'msg' }), { ok: false, invalidToken: true });
  assert.equal(calls.filter((call) => call.url.includes('oauth2')).length, 1, 'the access token is reused');

  const key = randomBytes(32).toString('base64');
  const sealed = encryptForDevice(key, pushBody.groupMessage({ id: 'm', groupId: 'g', from: 'u' }));
  assert.deepEqual(decrypt(key, sealed), { t: 'gmsg', id: 'm', groupId: 'g', from: 'u' });
  assert.throws(() => encryptForDevice(key, { t: 'msg', content: 'x'.repeat(9000) }), /too large/, 'a push never carries a payload');
});

test('Android: idle with push (no always-on service), woken by Firebase like WhatsApp; always-on only as a fallback', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const source = (path) => readFile(new URL(path, root), 'utf8');
  const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.PushService"[\s\S]*?<action android:name="com\.google\.firebase\.MESSAGING_EVENT" \/>/);
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'));
  const gradle = await source('android/app/build.gradle');
  assert.ok(gradle.includes("implementation 'com.google.firebase:firebase-messaging'"));
  assert.ok(gradle.includes("rootProject.file('../google-services.json')"), 'google-services.json may sit at the project root');

  const pushService = await java('PushService.java');
  assert.ok(pushService.includes('PushRegistration.decrypt(this, message.getData().get("enc"), message.getData().get("iv"))'), 'payloads are decrypted on the phone');
  assert.match(pushService, /private void onDirectMessage[\s\S]*?Alerts\.showMessage\([\s\S]*?PushRegistration\.markDelivered\(this, id\);/, 'notify straight from the push, then two ticks over HTTP');
  assert.match(pushService, /private void onCall[\s\S]*?Alerts\.showIncomingCall\([\s\S]*?MessagingService\.startSync\(this, CALL_SYNC_MS\);/, 'ring at once, then a short sync collects the offer');
  assert.ok(pushService.includes('case "call_end": onCallEnd(body); break;'));
  // A push-rung call that ends unanswered is a missed call (notification + call log), unless declined on another device.
  assert.match(pushService, /private void onCallEnd[\s\S]*?"declined"\.equals\(body\.optString\("reason"\)\)\) Alerts\.cancelIncomingCall\(this, body\.optString\("callId"\)\);\s*else Alerts\.missedCall\(this\);/);

  const registration = await java('PushRegistration.java');
  assert.ok(registration.includes('Cipher.getInstance("AES/GCM/NoPadding")') && registration.includes('new GCMParameterSpec(128'));
  assert.ok(registration.includes('.url(session.origin + "/api/v1/push/devices")'));
  assert.match(registration, /boolean push = new JSONObject\(response\.body\(\)\.string\(\)\)\.optBoolean\("push", false\);/, 'push mode only when the server sends pushes');

  const service = await java('MessagingService.java');
  // Always-on only without push, or when chosen (P5: Settings, Notifications, Always connected; off unless chosen).
  assert.match(service, /static boolean isLegacy\(Context context\) \{\s*return RelaySession\.read\(context\) != null && \(!PushRegistration\.isActive\(context\) \|\| AlwaysConnected\.enabled\(context\)\);/);
  assert.match(await java('AlwaysConnected.java'), /getBoolean\("on", false\)/, 'off unless chosen');
  assert.match(service, /private static boolean needed\(Context context\) \{\s*return callActive \|\| syncing\(\) \|\| isLegacy\(context\);/, 'no work, no service');
  assert.ok(service.includes('? ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;'), 'a push sync is a short service on Android 14+ (no daily cap), dataSync before');
  assert.match(service, /void settle\(\) \{[\s\S]*?ServiceCompat\.stopForeground\(this, ServiceCompat\.STOP_FOREGROUND_REMOVE\);\s*stopSelf\(\);/);

  const alerts = await java('Alerts.java');
  assert.ok(alerts.includes('if (ringing && !id.isEmpty() && id.equals(ringingCallId)) return true;'), 'the push and the connection ring a call once');
  assert.ok(alerts.includes('if (!firstNotice(messageId)) return true;'), 'a message is notified once however it arrives');
  const receiver = await java('CallActionReceiver.java');
  assert.ok(receiver.includes('PushRegistration.endCall(app, callId)') && receiver.includes('endOnServer(context.getApplicationContext(), callId, "decline")'), 'Decline reaches the server at once, also before the connection is up');
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /public void clearSession\(PluginCall call\) \{[\s\S]*?PushRegistration\.unregister\(getContext\(\)\);\s*RelaySession\.clear/);
});

test('notifications name chats from the phone, not from the push', async () => {
  const { readFile } = await import('node:fs/promises');
  const { notificationNames } = await import('../src/notificationNames.js');
  const names = notificationNames(
    [{ id: 'u1', name: 'Rina', username: 'rina' }, { id: 'u2', username: 'tom', name: 'tom' }, { id: 'g9', name: 'x', isGroup: true }, null],
    [{ id: 'g1', name: '  Family  ' }, { id: 'g2', name: '' }],
  );
  assert.equal(names.users.u1, 'Rina');
  assert.ok(names.users.u2, 'a person with no display name still gets their handle');
  assert.equal(names.users.g9, undefined, 'groups come from the group list');
  assert.deepEqual(names.groups, { g1: 'Family' });
  const root = new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/', import.meta.url);
  const service = await readFile(new URL('PushService.java', root), 'utf8');
  assert.doesNotMatch(service, /senderName|groupName"|callerName|reactorName|optString\("content"\)|optString\("emoji"\)|optString\("avatar"/, 'nothing read from a push but ids');
  assert.match(service, /RelaySession\.userName\(/);
  const session = await readFile(new URL('RelaySession.java', root), 'utf8');
  assert.match(session, /SecureStore\.sealOrKeep\(namesJson\)/, 'the names are sealed with the Keystore');
});

// Seen on the S23 (2026-11-19, a redacted notification dump): five messages back-to-back on the relay showed five
// "🔒 Message" lines, because a "msg" push only ever posts the sealed notice. A phone whose app opens relay messages in
// the background now gets the wake-up ("xwake") instead: the app or its background page fetches, decrypts and
// notifies with the real text (Android shows the sealed notice only if that fails in time).
test('back-to-back messages wake a phone that can open them in the background; older apps still get the sealed push', async () => {
  const { a, b, key, token } = await pair();
  const sender = await connect(a);
  await until(() => sender.events.some((event) => event.type === 'connection:ready'), 'ready');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'relay-wake-0', receiverId: b.user.id, content: 'before' } }));
  assert.deepEqual(decrypt(key, (await until(() => pushesTo(token).find((item) => decrypt(key, item.data).id === 'relay-wake-0'), 'old push')).data),
    { t: 'msg', id: 'relay-wake-0', from: a.user.id }, 'an app that has not said so keeps the old push');

  assert.deepEqual((await api('/api/v1/push/relay-wake', { session: b, method: 'POST', body: { on: true } })).body, { devices: 1 });
  const before = pushesTo(token).length;
  for (let index = 1; index <= 5; index += 1) sender.send(JSON.stringify({ type: 'message:send', message: { id: `relay-wake-${index}`, receiverId: b.user.id, content: `m${index}` } }));
  await until(() => pushesTo(token).length >= before + 5, 'five pushes');
  const bodies = pushesTo(token).slice(before).map((item) => decrypt(key, item.data));
  assert.deepEqual(bodies, Array.from({ length: 5 }, () => ({ t: 'xwake', from: a.user.id })), 'one wake-up per message, naming only the sender');

  // A group message wakes it for that group.
  const group = (await api('/api/v1/groups', { session: a, method: 'POST', body: { name: 'Wake group', memberIds: [b.user.id] } })).body;
  const afterGroup = pushesTo(token).length;
  await api(`/api/v1/groups/${group.id}/messages`, { session: a, method: 'POST', body: { content: 'hello group' } });
  const groupPush = await until(() => pushesTo(token).slice(afterGroup).find((item) => decrypt(key, item.data).groupId === group.id), 'group wake');
  assert.deepEqual(decrypt(key, groupPush.data), { t: 'xwake', from: a.user.id, groupId: group.id });
  sender.close();
});

// Seen on the S23 (third run): in the minute after a call push, the Android service's own connection received the
// messages and could only post "🔒 Message", which then kept the real notification from showing. On a relay-wake phone
// that connection now gets a content-free wake-up instead; the background page's fetch connection gets the messages.
test('a relay-wake phone: its service connection gets wake-ups, not messages; the background fetch gets the messages', async () => {
  const { a, b } = await pair();
  assert.deepEqual((await api('/api/v1/push/relay-wake', { session: b, method: 'POST', body: { on: true } })).body, { devices: 1 });
  const sender = await connect(a);
  await until(() => sender.events.some((event) => event.type === 'connection:ready'), 'ready');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'native-wake-0', receiverId: b.user.id, content: 'waiting' } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const service = await connect(b, ['relay.background']);
  const fetcher = await connect(b, ['relay.background', 'relay.fetch']);
  await until(() => service.events.some((event) => event.type === 'connection:ready') && fetcher.events.some((event) => event.type === 'connection:ready'), 'both ready');
  await until(() => service.events.some((event) => event.type === 'xmpp:wake'), 'a wake-up for what waited');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'native-wake-1', receiverId: b.user.id, content: 'live' } }));
  await until(() => fetcher.events.some((event) => event.type === 'message:new' && event.message.id === 'native-wake-1'), 'the fetch gets it');
  await until(() => service.events.filter((event) => event.type === 'xmpp:wake').length >= 2, 'a wake-up for the live one');
  assert.ok(!service.events.some((event) => event.type === 'message:new'), 'the service connection never gets the message itself');
  assert.deepEqual(service.events.filter((event) => event.type === 'xmpp:wake').map((event) => event.from), [a.user.id, a.user.id], 'content-free: who it is from');
  assert.ok(fetcher.events.some((event) => event.type === 'message:new' && event.message.id === 'native-wake-0'), 'the fetch gets what waited too');
  for (const socket of [service, fetcher, sender]) socket.close();
});

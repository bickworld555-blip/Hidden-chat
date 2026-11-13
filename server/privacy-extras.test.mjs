// About (and who sees it), Silence unknown callers and the Default message timer (schema 25), plus this round's
// client rules: App theme choices, Media upload quality for videos, Network usage › Roaming, the brand mark, the
// app-icon launcher aliases, the Proxy setting and the Terms page.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { parsePrivacyPatch } from './presence.mjs';
import { THEME_CHOICES, resolveDark, startsDark, themeChoice } from '../src/appearance.js';
import { needsVideoCompression, STANDARD_VIDEO } from '../src/videoCompress.js';
import { addUsage, emptyUsage, usageTotals } from '../src/networkUsage.js';
import { APP_ICONS } from '../src/appIcons.js';
import { PUBLIC_PATH } from '../src/site/links.js';
import { groupCallLogs } from '../src/callLogGroups.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-privacy-extras-'));
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
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  socket.waitFor = async (predicate, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const found = socket.events.find(predicate); if (found) return found; await new Promise((r) => setTimeout(r, 20)); }
    return null;
  };
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

test('About: up to 139 characters, shown to the audience its privacy allows', async () => {
  const owner = await register('abo');
  const friend = await register('abf');
  const stranger = await register('abs');
  await api('/api/v1/contacts', { session: owner, method: 'POST', body: { userId: friend.user.id } });
  assert.equal((await api('/api/v1/me/about', { session: owner, method: 'PUT', body: { about: 'x'.repeat(140) } })).status, 400);
  assert.equal((await api('/api/v1/me/about', { session: owner, method: 'PUT', body: { about: '  At   work  ' } })).data.about, 'At work');
  assert.equal((await api('/api/v1/me/about', { session: owner })).data.about, 'At work');
  assert.equal((await api(`/api/v1/users/${owner.user.id}/about`, { session: stranger })).data.about, 'At work', 'everyone by default');

  await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { about: 'contacts' } });
  assert.equal((await api(`/api/v1/users/${owner.user.id}/about`, { session: friend })).data.about, 'At work', 'a saved contact');
  assert.equal((await api(`/api/v1/users/${owner.user.id}/about`, { session: stranger })).data.about, null, 'hidden from others');
  await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { about: 'nobody' } });
  assert.equal((await api(`/api/v1/users/${owner.user.id}/about`, { session: friend })).data.about, null);
  assert.equal((await api(`/api/v1/users/${owner.user.id}/about`, { session: owner })).data.about, 'At work', 'always your own');
  assert.equal((await api('/api/v1/users/nobody-here/about', { session: owner })).status, 404);
});

test('privacy: default message timer and silence unknown callers are validated and saved', async () => {
  assert.deepEqual(parsePrivacyPatch({ defaultTimer: 86400, silenceUnknownCallers: true, about: 'contacts' }).patch, { defaultTimer: 86400, silenceUnknownCallers: true, about: 'contacts' });
  assert.match(parsePrivacyPatch({ defaultTimer: 123 }).error, /24 hours/);
  assert.match(parsePrivacyPatch({ silenceUnknownCallers: 'yes' }).error, /on or off/);
  assert.match(parsePrivacyPatch({ about: 'friends' }).error, /Everyone/);
  const user = await register('tmr');
  const saved = (await api('/api/v1/me/privacy', { session: user, method: 'PUT', body: { defaultTimer: 604800, silenceUnknownCallers: true } })).data;
  assert.equal(saved.defaultTimer, 604800);
  assert.equal(saved.silenceUnknownCallers, true);
  assert.equal((await api('/api/v1/me/privacy', { session: user, method: 'PUT', body: { defaultTimer: 5 } })).status, 400);
});

test('silence unknown callers: a caller the callee has not saved reaches them silenced; a saved contact rings', async () => {
  const ava = await register('sla');
  const ben = await register('slb');
  const cara = await register('slc');
  await api('/api/v1/contacts', { session: ava, method: 'POST', body: { userId: cara.user.id } });
  await api('/api/v1/me/privacy', { session: ava, method: 'PUT', body: { silenceUnknownCallers: true } });
  const avaSocket = await connect(ava);
  const benSocket = await connect(ben);
  const caraSocket = await connect(cara);
  await Promise.all([avaSocket, benSocket, caraSocket].map((socket) => socket.waitFor((event) => event.type === 'connection:ready')));
  // Ben writes first (a chat link, not a saved contact), then calls.
  benSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'sl-1', receiverId: ava.user.id, content: 'hi' } }));
  await benSocket.waitFor((event) => event.type === 'message:ack');
  benSocket.send(JSON.stringify({ type: 'call:signal', callId: 'c-silenced', mode: 'audio', targetId: ava.user.id, signal: { type: 'offer', sdp: 'v=0' } }));
  const silenced = await avaSocket.waitFor((event) => event.type === 'call:signal' && event.callId === 'c-silenced');
  assert.equal(silenced?.silenced, true);
  caraSocket.send(JSON.stringify({ type: 'call:signal', callId: 'c-saved', mode: 'video', targetId: ava.user.id, signal: { type: 'offer', sdp: 'v=0' } }));
  const ringing = await avaSocket.waitFor((event) => event.type === 'call:signal' && event.callId === 'c-saved');
  assert.ok(ringing);
  assert.equal(ringing.silenced, undefined, 'a saved contact rings');
  for (const socket of [avaSocket, benSocket, caraSocket]) socket.close();
});

test('app theme: Light by default, Dark, or System default following the phone', () => {
  const store = (value) => ({ getItem: () => value });
  assert.deepEqual(THEME_CHOICES.map((choice) => choice.id), ['light', 'dark', 'system']);
  assert.equal(themeChoice(store(null)), 'light');
  assert.equal(themeChoice(store('purple')), 'light');
  assert.equal(resolveDark('system', true), true);
  assert.equal(resolveDark('system', false), false);
  assert.equal(startsDark(store('dark'), false), true);
  assert.equal(startsDark(store('system'), true), true);
  assert.equal(startsDark(store('light'), true), false);
});

test('media upload quality: Standard re-encodes big videos in the Android app; HD and browsers send originals', () => {
  const big = STANDARD_VIDEO.minBytes + 1;
  assert.equal(needsVideoCompression({ type: 'video/mp4', size: big, quality: 'standard', native: true }), true);
  assert.equal(needsVideoCompression({ type: 'video/mp4', size: big, quality: 'hd', native: true }), false);
  assert.equal(needsVideoCompression({ type: 'video/mp4', size: 1000, quality: 'standard', native: true }), false);
  assert.equal(needsVideoCompression({ type: 'video/mp4', size: big, quality: 'standard', native: false }), false);
  assert.equal(needsVideoCompression({ type: 'image/jpeg', size: big, quality: 'standard', native: true }), false);
  const plugin = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/VideoCompressor.java', import.meta.url), 'utf8');
  assert.match(plugin, /Presentation\.createForShortSide\(shortSide\)/);
});

test('network usage: Roaming is counted alongside, never added to the totals', () => {
  let usage = addUsage(emptyUsage(1), 'media', { sent: 100, received: 50 });
  usage = addUsage(usage, 'roaming', { sent: 100, received: 50 });
  assert.deepEqual(usageTotals(usage), { sent: 100, received: 50 });
  assert.deepEqual(usage.roaming, { sent: 100, received: 50 });
});

test('silenced calls show as silenced in Calls, never as answered', () => {
  const [row] = groupCallLogs([{ id: 'a', peerId: 'p', direction: 'incoming', status: 'silenced', duration: 0, mode: 'audio', timestamp: '2026-11-13T10:00:00Z' }]);
  assert.equal(row.silenced, true);
  assert.equal(row.answered, false);
});

test('one brand mark everywhere: the in-app mark draws the app icon; the shield is gone', () => {
  const mark = readFileSync(new URL('../src/components/BrandMark.jsx', import.meta.url), 'utf8');
  const icon = readFileSync(new URL('../assets/brand/app-icon.svg', import.meta.url), 'utf8');
  for (const path of icon.match(/ d="[^"]+"/g)) assert.ok(mark.includes(path), `BrandMark draws${path}`);
  for (const file of ['src/components/ChatsList.jsx', 'src/components/Sidebar.jsx', 'src/components/UsernameGate.jsx', 'src/site/PublicSite.jsx', 'src/admin/Dashboard.jsx']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /BrandMark/, file);
    assert.doesNotMatch(source, /ShieldMark/, file);
  }
});

test('app icons: one launcher alias per icon, the default keeps the old component name, the proxy applies at start', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /<activity-alias\s+android:name="\.MainActivity"\s+android:targetActivity="\.AppActivity"[\s\S]*?android:enabled="true"/);
  for (const alias of ['IconMidnight', 'IconTeal']) assert.match(manifest, new RegExp(`android:name="\\.${alias}"[\\s\\S]*?android:enabled="false"`));
  assert.equal((manifest.match(/android\.intent\.category\.LAUNCHER/g) ?? []).length, 3, 'only the aliases are launchers');
  assert.deepEqual(APP_ICONS.map((icon) => icon.id), ['default', 'midnight', 'teal']);
  const plugin = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java', import.meta.url), 'utf8');
  assert.match(plugin, /\{ "default", "MainActivity" \}, \{ "midnight", "IconMidnight" \}, \{ "teal", "IconTeal" \}/);
  const activity = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/AppActivity.java', import.meta.url), 'utf8');
  assert.match(activity, /AppProxy\.apply\(this\);[\s\S]*registerPlugin\(HiddenNativePlugin\.class\)/);
});

test('website: a Terms of Service page', () => {
  assert.ok(PUBLIC_PATH.test('/terms'));
  assert.match(readFileSync(new URL('../src/site/PublicSite.jsx', import.meta.url), 'utf8'), /path\.startsWith\('\/terms'\) \? <Terms \/>/);
});

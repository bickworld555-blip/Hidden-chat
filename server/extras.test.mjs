// Broadcast lists, channels, scheduled messages, status privacy, call links (server/extras.mjs), sealed poll votes
// and sealed reactions — through the real server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createChatServer } from './index.mjs';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, parseEnvelope, routingFor } from '../src/e2e/envelope.js';
import { parseVote } from '../src/e2e/polls.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-extras-'));
  // Link cards the server makes for channel updates (server/linkPreview.mjs fetches the page; here a stand-in).
  const linkPreviews = async (href) => (href.includes('example.org') ? { url: href, provider: '', title: 'Made by the server', description: 'From the page', siteName: 'Example', image: 'https://example.org/cover.jpg', video: false, duration: null } : null);
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, linkPreviews });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
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
async function user(prefix) {
  counter += 1;
  return (await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } })).body;
}
const save = (owner, other) => api('/api/v1/contacts', { token: owner.token, method: 'POST', body: { userId: other.user.id } });
function connect(token) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', [`relay.auth.${token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
};

test('broadcast lists: only recipients who saved the sender can receive', async () => {
  const owner = await user('bco');
  const fan = await user('bcf');
  const stranger = await user('bcs');
  await save(fan, owner);
  const created = await api('/api/v1/broadcasts', { token: owner.token, method: 'POST', body: { name: 'Customers', memberIds: [fan.user.id, stranger.user.id, owner.user.id] } });
  assert.equal(created.status, 201);
  const byId = Object.fromEntries(created.body.members.map((member) => [member.id, member.canReceive]));
  assert.deepEqual(byId, { [fan.user.id]: true, [stranger.user.id]: false }, 'the owner is never a member; strangers are flagged');
  assert.equal((await api('/api/v1/broadcasts', { token: fan.token })).body.length, 0, 'lists are private to their owner');
  assert.equal((await api(`/api/v1/broadcasts/${created.body.id}`, { token: fan.token, method: 'DELETE' })).status, 404);
  const renamed = await api(`/api/v1/broadcasts/${created.body.id}`, { token: owner.token, method: 'PUT', body: { name: 'VIP', memberIds: [fan.user.id] } });
  assert.deepEqual([renamed.body.name, renamed.body.members.length], ['VIP', 1]);
});

test('channels: owner posts, followers get them live, reactions are counted not named', async () => {
  const owner = await user('cho');
  const reader = await user('chr');
  const channel = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Daily News', description: 'Morning headlines' } })).body;
  assert.ok(channel.mine);
  assert.equal((await api('/api/v1/channels/discover?q=daily', { token: reader.token })).body[0].id, channel.id);
  await api(`/api/v1/channels/${channel.id}/follow`, { token: reader.token, method: 'POST' });
  const socket = await connect(reader.token);
  await until(() => socket.events.some((event) => event.type === 'connection:ready'));
  assert.equal((await api(`/api/v1/channels/${channel.id}/posts`, { token: reader.token, method: 'POST', body: { content: 'x' } })).status, 403, 'followers cannot post');
  const post = (await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { content: 'Hello followers' } })).body;
  await until(() => socket.events.find((event) => event.type === 'channel:post' && event.post.id === post.id));
  const reacted = await api(`/api/v1/channels/${channel.id}/posts/${post.id}/reaction`, { token: reader.token, method: 'PUT', body: { emoji: '❤️' } });
  assert.deepEqual(reacted.body.reactions, { '❤️': 1 });
  const view = (await api(`/api/v1/channels/${channel.id}`, { token: owner.token })).body;
  assert.deepEqual([view.followers, view.posts[0].reactions, view.posts[0].myReaction], [1, { '❤️': 1 }, null]);
  assert.equal(JSON.stringify(view).includes(reader.user.id), false, 'followers and reactors stay anonymous');
  socket.close();
});

test('scheduled messages are held and delivered at their time; status privacy limits who sees statuses', async () => {
  const sender = await user('sch');
  const receiver = await user('scr');
  const outsider = await user('sco');
  assert.equal((await api('/api/v1/scheduled', { token: sender.token, method: 'POST', body: { receiverId: receiver.user.id, content: 'hi', sendAt: Date.now() } })).status, 400, 'too soon');
  const scheduled = (await api('/api/v1/scheduled', { token: sender.token, method: 'POST', body: { receiverId: receiver.user.id, content: 'Happy birthday!', sendAt: Date.now() + 60_000 } })).body;
  assert.equal((await api('/api/v1/scheduled', { token: sender.token })).body.length, 1);
  // Not due yet: nothing goes out. Once due, the sweep sends it as the sender's message and forgets it.
  assert.equal(await service.deliverScheduled(Date.now()), 0);
  assert.equal(await service.deliverScheduled(scheduled.sendAt + 1), 1);
  const history = (await api(`/api/v1/messages?peerId=${sender.user.id}`, { token: receiver.token })).body;
  assert.ok(history.some((message) => message.content === 'Happy birthday!' && message.senderId === sender.user.id));
  assert.equal((await api('/api/v1/scheduled', { token: sender.token })).body.length, 0);

  // Status privacy: "only share with" the receiver.
  await save(sender, receiver);
  await save(sender, outsider);
  await api('/api/v1/statuses', { token: sender.token, method: 'POST', body: { content: 'Only for you', background: 'teal' } });
  const sees = async (viewer) => ((await api('/api/v1/statuses', { token: viewer.token })).body.others ?? []).some((entry) => entry.user.id === sender.user.id);
  assert.equal(await sees(outsider), true, 'contacts see statuses by default');
  assert.equal((await api('/api/v1/me/status-privacy', { token: sender.token, method: 'PUT', body: { audience: 'only', userIds: [receiver.user.id] } })).status, 200);
  assert.equal(await sees(receiver), true);
  assert.equal(await sees(outsider), false, 'not shared with');
  await api('/api/v1/me/status-privacy', { token: sender.token, method: 'PUT', body: { audience: 'except', userIds: [receiver.user.id] } });
  assert.deepEqual([await sees(receiver), await sees(outsider)], [false, true]);
});

test('call links: joining links the two people so the call can be placed; revoked links stop working', async () => {
  const owner = await user('clo');
  const guest = await user('clg');
  const link = (await api('/api/v1/call-links', { token: owner.token, method: 'POST', body: { mode: 'video' } })).body;
  assert.match(link.code, /^[A-Za-z0-9_-]{16}$/);
  const preview = (await api(`/api/v1/call-links/${link.code}`, { token: guest.token })).body;
  assert.deepEqual([preview.mode, preview.owner.id, preview.mine], ['video', owner.user.id, false]);
  assert.equal((await api(`/api/v1/call-links/${link.code}/join`, { token: guest.token, method: 'POST' })).status, 200);
  const contacts = (await api('/api/v1/contacts', { token: owner.token })).body;
  assert.ok(contacts.some((contact) => contact.id === guest.user.id), 'now linked, so call signalling is allowed');
  assert.equal((await api(`/api/v1/call-links/${link.code}`, { token: guest.token, method: 'DELETE' })).status, 404, 'only the owner revokes');
  assert.equal((await api(`/api/v1/call-links/${link.code}`, { token: owner.token, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/v1/call-links/${link.code}`, { token: guest.token })).status, 404);
});

function memoryStorage() {
  const map = new Map();
  return { get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); } };
}

test('poll votes and reactions travel sealed: the server stores ciphertext, devices count and read them', async () => {
  const a = await user('pva');
  const b = await user('pvb');
  await save(a, b);
  const device = async (session) => {
    const protocol = createProtocol({ storage: memoryStorage() });
    await api('/api/v1/e2e/keys', { token: session.token, method: 'PUT', body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) });
    return { ...session, protocol, claim: async (userId, deviceIds) => (await api(`/api/v1/e2e/users/${userId}/bundles`, { token: session.token, method: 'POST', body: { deviceIds } })).body.bundles };
  };
  const da = await device(a);
  const db = await device(b);
  const seal = async (from, to, content) => {
    const devices = (await api(`/api/v1/e2e/users/${to.user.id}/devices`, { token: from.token })).body.devices;
    const d = await from.protocol.encryptForDevices({ [to.user.id]: devices }, JSON.stringify({ c: content }), { claimBundles: from.claim });
    return buildEnvelope(routingFor(content), { sd: from.deviceId, d });
  };
  const sa = await connect(da.token);
  await until(() => sa.events.some((event) => event.type === 'connection:ready'));
  const poll = 'poll:{"question":"Lunch?","options":["Pizza","Sushi","Tacos"],"multiple":false}';
  sa.send(JSON.stringify({ type: 'message:send', message: { id: 'poll-1', receiverId: b.user.id, content: await seal(da, db, poll) } }));
  await until(() => sa.events.some((event) => event.type === 'message:ack' && event.message.id === 'poll-1'));

  const vote = await seal(db, da, 'vote:[2]');
  const cast = await api('/api/v1/polls/poll-1/sealed-vote', { token: db.token, method: 'PUT', body: { sealed: vote } });
  assert.equal(cast.status, 200);
  assert.deepEqual(cast.body.votes, {}, 'the server cannot count a sealed vote');
  assert.equal(cast.body.sealedVotes.length, 1);
  const stored = cast.body.sealedVotes[0];
  const opened = JSON.parse(await da.protocol.decryptFromDevice(b.user.id, parseEnvelope(stored.sealed).body.sd, parseEnvelope(stored.sealed).body.d[a.user.id][a.deviceId])).c;
  assert.deepEqual(parseVote(opened, 3, false), [2], 'the poll author’s device reads the vote');
  assert.equal(parseVote('vote:[0,1]', 3, false), null, 'a single-choice poll refuses two options');
  assert.equal(parseVote('vote:[5]', 3, false), null, 'out of range');
  assert.equal((await api('/api/v1/polls/poll-1/sealed-vote', { token: db.token, method: 'PUT', body: { sealed: 'vote:[1]' } })).status, 400, 'a plain value is not a sealed vote');

  // Reactions: the emoji is sealed; the push and the event never carry it in the clear.
  sa.send(JSON.stringify({ type: 'message:reaction', messageId: 'poll-1', emoji: await seal(da, db, 'reaction:🔥') }));
  const sb = await connect(db.token);
  const rows = (await api(`/api/v1/messages?peerId=${a.user.id}`, { token: db.token })).body;
  const reaction = await until(() => rows.find((row) => row.id === 'poll-1')?.reactions?.[0] ?? null).catch(async () => {
    const again = (await api(`/api/v1/messages?peerId=${a.user.id}`, { token: db.token })).body;
    return again.find((row) => row.id === 'poll-1')?.reactions?.[0];
  });
  assert.ok(reaction.emoji.startsWith('e2e2:other|') && !reaction.emoji.includes('🔥'), 'stored sealed');
  const env = parseEnvelope(reaction.emoji);
  assert.equal(JSON.parse(await db.protocol.decryptFromDevice(a.user.id, env.body.sd, env.body.d[b.user.id][b.deviceId])).c, 'reaction:🔥');
  sa.close();
  sb.close();
});

test('channel directory browses by category; the owner adds admins who can post, others cannot', async () => {
  const owner = await user('chown');
  const helper = await user('chadmin');
  const reader = await user('chread');
  const made = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Dhaka Football', description: 'Match day news', category: 'sports' } })).body;
  assert.deepEqual([made.category, made.role, made.canPost], ['sports', 'owner', true]);
  assert.equal((await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'No Category' } })).body.category, 'other', 'unknown or missing category is "other"');
  const sports = (await api('/api/v1/channels/discover?category=sports', { token: reader.token })).body;
  assert.ok(sports.some((item) => item.id === made.id) && sports.every((item) => item.category === 'sports'));
  assert.equal((await api('/api/v1/channels/discover?category=news', { token: reader.token })).body.some((item) => item.id === made.id), false);
  assert.ok((await api('/api/v1/channels/discover?q=match', { token: reader.token })).body.some((item) => item.id === made.id), 'descriptions are searched too');
  assert.equal((await api(`/api/v1/channels/${made.id}`, { token: owner.token, method: 'PUT', body: { category: 'nonsense' } })).status, 400);

  // Only the owner adds admins; admins post and delete updates but cannot manage admins or delete the channel.
  assert.equal((await api(`/api/v1/channels/${made.id}/admins`, { token: reader.token, method: 'POST', body: { username: reader.user.username } })).status, 403);
  assert.equal((await api(`/api/v1/channels/${made.id}/admins`, { token: owner.token, method: 'POST', body: { username: 'nobody_here_x' } })).status, 404);
  assert.equal((await api(`/api/v1/channels/${made.id}/admins`, { token: owner.token, method: 'POST', body: { username: `@${helper.user.username}` } })).status, 201);
  const asAdmin = (await api(`/api/v1/channels/${made.id}`, { token: helper.token })).body;
  assert.deepEqual([asAdmin.role, asAdmin.canPost, asAdmin.mine], ['admin', true, false]);
  assert.ok((await api('/api/v1/channels', { token: helper.token })).body.some((item) => item.id === made.id), 'admins see the channel in their list');
  const post = await api(`/api/v1/channels/${made.id}/posts`, { token: helper.token, method: 'POST', body: { content: 'Kick-off at 7' } });
  assert.equal(post.status, 201);
  assert.equal((await api(`/api/v1/channels/${made.id}/posts`, { token: reader.token, method: 'POST', body: { content: 'spam' } })).status, 403);
  assert.equal((await api(`/api/v1/channels/${made.id}/admins`, { token: helper.token, method: 'POST', body: { username: reader.user.username } })).status, 403);
  assert.equal((await api(`/api/v1/channels/${made.id}`, { token: helper.token, method: 'DELETE' })).status, 403);
  const listed = (await api(`/api/v1/channels/${made.id}/admins`, { token: owner.token })).body;
  assert.deepEqual([listed.owner.id, listed.admins.map((item) => item.id)], [owner.user.id, [helper.user.id]]);
  // An admin can step down; then they can no longer post.
  assert.equal((await api(`/api/v1/channels/${made.id}/admins/${helper.user.id}`, { token: helper.token, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/v1/channels/${made.id}/posts`, { token: helper.token, method: 'POST', body: { content: 'again' } })).status, 403);
});

test('channel updates carry a photo or file: anyone reading the channel opens it, it goes with the post or the channel', async () => {
  const owner = await user('chm_owner');
  const reader = await user('chm_reader');
  const other = await user('chm_other');
  const channel = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Media channel' } })).body;
  const upload = async (by, name) => {
    const response = await fetch(`${base}/api/v1/media?receiverId=${by.user.id}`, { method: 'POST', headers: { Authorization: `Bearer ${by.token}`, 'Content-Type': 'application/pdf', 'X-File-Name': name }, body: Buffer.from('%PDF-1.4 tiny') });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  const mediaId = await upload(owner, 'menu.pdf');
  assert.equal((await fetch(`${base}/api/v1/media/${mediaId}`, { headers: { Authorization: `Bearer ${reader.token}` } })).status, 404, 'not before it is posted');
  assert.equal((await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { mediaId: await upload(other, 'x.pdf') } })).status, 400, 'only your own upload');
  const posted = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { content: 'This week’s menu', mediaId } });
  assert.equal(posted.status, 201);
  assert.deepEqual([posted.body.media.id, posted.body.media.filename, posted.body.media.content], [mediaId, 'menu.pdf', `media:${mediaId}:menu.pdf`]);
  const fileOnly = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { mediaId: await upload(owner, 'map.pdf') } });
  assert.equal(fileOnly.status, 201, 'a file without text');

  const feed = (await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.posts;
  assert.deepEqual(feed.map((item) => [item.content, item.media?.filename]), [['This week’s menu', 'menu.pdf'], ['', 'map.pdf']]);
  const opened = await fetch(`${base}/api/v1/media/${mediaId}`, { headers: { Authorization: `Bearer ${reader.token}` } });
  assert.equal(opened.status, 200, 'a reader (not even a follower) opens it: channels are public');

  assert.equal((await api(`/api/v1/channels/${channel.id}/posts/${posted.body.id}`, { token: owner.token, method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/media/${mediaId}`, { headers: { Authorization: `Bearer ${owner.token}` } })).status, 404, 'gone with its post');
  assert.equal((await api(`/api/v1/channels/${channel.id}`, { token: owner.token, method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/media/${fileOnly.body.media.id}`, { headers: { Authorization: `Bearer ${owner.token}` } })).status, 404, 'and with the channel');
});

test('channel screens: the name opens Channel info with Delete channel; updates show attachments and link cards', async () => {
  const { readFileSync } = await import('node:fs');
  const panels = readFileSync(new URL('../src/components/extras/ExtrasPanels.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const part of [
    'className="hm-channel-title" onClick={() => setShowInfo(true)}',
    'aria-label="Channel info"',
    '<strong>Delete channel</strong>',
    'role="alertdialog"',
    "await request(token, `/api/v1/channels/${channel.id}`, { method: 'DELETE' });",
    '<MediaRenderer mediaRef={item.media.content} sessionToken={token} poster={item.media.poster ?? \'\'} />',
    'aria-label="Attach a photo, video or file"',
    "const { poster } = await videoPreview(file);",
  ]) assert.ok(panels.includes(part), part);
  const info = panels.slice(panels.indexOf('function ChannelInfo'), panels.indexOf('// The owner asks for the channel'));
  assert.match(info, /\{channel\.mine && \(\n\s+<button type="button" className="hm-channel-action is-danger"/, 'only the owner is offered Delete channel');
});

test('a video post keeps its frame (a small JPEG) and refuses anything else as a poster', async () => {
  const owner = await user('chv_owner');
  const channel = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Video channel' } })).body;
  const upload = async (type, name) => (await (await fetch(`${base}/api/v1/media?receiverId=${owner.user.id}`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': type, 'X-File-Name': name }, body: Buffer.from('bytes') })).json()).id;
  const frame = `data:image/jpeg;base64,${Buffer.alloc(20000, 1).toString('base64')}`;
  const video = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { mediaId: await upload('video/mp4', 'clip.mp4'), poster: frame } });
  assert.equal(video.status, 201, 'a 27 kB frame fits the request');
  assert.equal(video.body.media.poster, frame);
  const fake = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { mediaId: await upload('video/mp4', 'b.mp4'), poster: 'javascript:alert(1)' } });
  assert.equal(fake.body.media.poster, null);
  const photo = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { mediaId: await upload('image/png', 'a.png'), poster: frame } });
  assert.equal(photo.body.media.poster, null, 'only videos have a frame');
  assert.equal((await api(`/api/v1/channels/${channel.id}`, { token: owner.token })).body.posts[0].media.poster, frame);
});

test('a picked video shows its own frame before sending (strip and player), from the one decode the sent bubble reuses', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const composer = read('src/components/MediaComposer.jsx');
  const thumbs = read('src/mediaThumb.js');
  assert.ok(composer.includes('poster={frames[item.key]?.image}'), 'the large player shows the frame until played');
  assert.ok(composer.includes('{frames[entry.key] ? <img src={frames[entry.key].image} alt="" />'), 'the strip shows the frame, not a bare <video>');
  assert.ok(!composer.includes('<video src={urls[entry.key]} muted playsInline preload="metadata" />'));
  assert.match(thumbs, /if \(typeof file === 'object' && previews\.has\(file\)\) return previews\.get\(file\);/, 'one decode per file');
  assert.ok(thumbs.includes('video.requestVideoFrameCallback(() => { clearTimeout(fallback); capture(); });'), 'drawn once the frame is presented');
});

test('a link card is stored with the channel update, so every reader sees it; the server makes one when the phone could not', async () => {
  const owner = await user('chl_owner');
  const reader = await user('chl_reader');
  const channel = (await api('/api/v1/channels', { token: owner.token, method: 'POST', body: { name: 'Links channel' } })).body;
  const readerSocket = await connect(reader.token);
  await api(`/api/v1/channels/${channel.id}/follow`, { token: reader.token, method: 'POST' });
  const thumbnail = `data:image/jpeg;base64,${Buffer.alloc(900, 3).toString('base64')}`;
  const href = 'https://www.youtube.com/watch?v=abc123';
  const card = { url: href, provider: 'youtube', title: 'A video', description: 'A channel', siteName: 'YouTube', video: true, duration: null, thumbnail, image: 'https://tracker.example/pixel.gif' };
  const posted = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { content: `Watch ${href}`, linkPreview: card } });
  assert.equal(posted.status, 201);
  const seen = (await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.posts.at(-1);
  assert.deepEqual([seen.linkPreview.title, seen.linkPreview.thumbnail, seen.linkPreview.url], ['A video', thumbnail, href], 'another reader gets the same card, thumbnail included');
  assert.equal(seen.linkPreview.image, undefined, 'a remote picture from the poster is not kept');
  const wrong = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { content: 'no link here', linkPreview: card } });
  assert.equal((await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.posts.find((item) => item.id === wrong.body.id).linkPreview, null, 'only for a link the update contains');

  // The phone sent none: the server makes the card, stores it and tells the readers.
  const later = await api(`/api/v1/channels/${channel.id}/posts`, { token: owner.token, method: 'POST', body: { content: 'Read https://example.org/news' } });
  assert.ok(await until(() => readerSocket.events.find((event) => event.type === 'channel:post-updated' && event.postId === later.body.id)), 'readers hear the card is ready');
  const made = (await api(`/api/v1/channels/${channel.id}`, { token: reader.token })).body.posts.find((item) => item.id === later.body.id).linkPreview;
  assert.deepEqual([made.title, made.image, made.url], ['Made by the server', 'https://example.org/cover.jpg', 'https://example.org/news']);
  readerSocket.close();
});

test('channels list the newest update first, with its preview; the feed keeps time order with the newest last', async () => {
  const me = await user('cho_me');
  const quiet = (await api('/api/v1/channels', { token: me.token, method: 'POST', body: { name: 'Quiet' } })).body;
  const busy = (await api('/api/v1/channels', { token: me.token, method: 'POST', body: { name: 'Busy' } })).body;
  await api(`/api/v1/channels/${quiet.id}/posts`, { token: me.token, method: 'POST', body: { content: 'first' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api(`/api/v1/channels/${busy.id}/posts`, { token: me.token, method: 'POST', body: { content: 'older' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api(`/api/v1/channels/${quiet.id}/posts`, { token: me.token, method: 'POST', body: { content: 'newest   news' } });
  const listed = (await api('/api/v1/channels', { token: me.token })).body.filter((item) => [quiet.id, busy.id].includes(item.id));
  assert.deepEqual(listed.map((item) => [item.name, item.lastPost.preview]), [['Quiet', 'newest news'], ['Busy', 'older']], 'newest update first, with its text');
  const feed = (await api(`/api/v1/channels/${quiet.id}`, { token: me.token })).body.posts;
  assert.deepEqual(feed.map((item) => item.content), ['first', 'newest   news'], 'oldest at the top, newest at the bottom');
});

test('the channel screen shows the stored card, keeps the newest update in view and refreshes live', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const panels = read('src/components/extras/ExtrasPanels.jsx');
  const app = read('src/App.jsx');
  const updates = read('src/components/UpdatesView.jsx');
  for (const part of [
    '<LinkPreview href={firstLink(item.content)} sessionToken={token} preview={item.linkPreview ?? null} />',
    'const linkPreview = href ? await buildLinkPreview(href, token) : null;',
    "useEffect(() => { if (newestId) feedEndRef.current?.scrollIntoView({ block: 'end' }); }, [newestId]);",
    'window.addEventListener(CHANNEL_EVENT, onChannel);',
  ]) assert.ok(panels.includes(part), part);
  assert.ok(app.includes("event.type.startsWith('channel:') && event.channelId) window.dispatchEvent(new CustomEvent(CHANNEL_EVENT"));
  assert.ok(updates.includes('channel.lastPost?.preview') && updates.includes('window.addEventListener(CHANNEL_EVENT, bump);'));
  assert.ok(read('src/components/LinkPreview.jsx').includes("image: given.thumbnail || given.image || ''"));
});

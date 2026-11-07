// Location and contact sharing: payloads, distance maths, nearby places, and the live-location relay.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import {
  LIVE_DURATIONS,
  contactContent,
  formatDistance,
  formatRemaining,
  haversineDistance,
  isLiveExpired,
  liveContent,
  locationContent,
  messageKind,
  normalizePlaces,
  osmTileUrl,
  parseContact,
  parseLive,
  parseLocation,
  shortAddress,
  shouldSendLiveUpdate,
  tileFor,
} from '../src/geo.js';
import { previewFor } from '../src/store.js';

let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-location-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'location.sqlite') });
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
  return response.json();
}

async function link(a, b) {
  await fetch(`${baseUrl}/api/v1/contacts`, { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: b.user.id }) });
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
      setTimeout(poll, 15);
    })();
  });
}

const live = (socket, payload) => socket.send(JSON.stringify({ type: 'location:live', ...payload }));
const liveEvents = (socket, action) => socket.events.filter((event) => event.type === 'location:live' && (!action || event.action === action));

test('distance, formatting and payload round-trips', () => {
  const dhaka = { lat: 23.8103, lon: 90.4125 };
  const chittagong = { lat: 22.3569, lon: 91.7832 };
  const km = haversineDistance(dhaka, chittagong) / 1000;
  assert.ok(km > 210 && km < 220, `Dhaka–Chittagong is about 215 km, got ${km}`);
  assert.equal(haversineDistance(dhaka, dhaka), 0);
  assert.equal(haversineDistance(dhaka, { lat: 95, lon: 0 }), null);
  assert.equal(formatDistance(42.4), '42 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(12_345), '12 km');
  assert.equal(formatRemaining(61 * 60_000), '1 h 1 min');
  assert.equal(formatRemaining(14.2 * 60_000), '15 min');
  assert.equal(formatRemaining(0), 'ended');

  const location = locationContent({ lat: 23.81031234567, lon: 90.4125, accuracy: 12.6, name: 'Dhaka University', address: 'Nilkhet Rd' });
  assert.ok(location.startsWith('location:{'));
  assert.deepEqual(parseLocation(location), { lat: 23.810312, lon: 90.4125, accuracy: 13, name: 'Dhaka University', address: 'Nilkhet Rd' });
  assert.equal(parseLocation('location:{"lat":200,"lon":0}'), null);
  assert.equal(parseLocation('location:not json'), null);
  assert.throws(() => locationContent({ lat: NaN, lon: 1 }));

  const session = liveContent({ sessionId: 's1', durationMs: LIVE_DURATIONS[0].ms, startedAt: '2026-11-06T10:00:00.000Z' });
  assert.deepEqual(parseLive(session), { sessionId: 's1', durationMs: 900_000, startedAt: '2026-11-06T10:00:00.000Z', comment: '' });
  const withComment = liveContent({ sessionId: 's2', durationMs: LIVE_DURATIONS[1].ms, startedAt: '2026-11-06T10:00:00.000Z', comment: '  Meet me   at the gate \n' });
  assert.equal(parseLive(withComment).comment, 'Meet me at the gate', 'comments are trimmed and whitespace-collapsed');
  assert.equal(parseLive(liveContent({ sessionId: 's3', durationMs: 1, startedAt: null, comment: 'x'.repeat(500) })).comment.length, 200, 'comments are capped');
  assert.equal(parseLive(liveContent({ sessionId: 's4', durationMs: 1, startedAt: null, comment: '   ' })).comment, '', 'blank comments are dropped');
  assert.ok(!liveContent({ sessionId: 's4', durationMs: 1, startedAt: null, comment: '' }).includes('comment'), 'no comment key when empty');
  assert.deepEqual(LIVE_DURATIONS.map((duration) => duration.label), ['15 minutes', '1 hour', '8 hours']);
  assert.equal(isLiveExpired(parseLive(session), Date.parse('2026-11-06T10:14:59.000Z')), false);
  assert.equal(isLiveExpired(parseLive(session), Date.parse('2026-11-06T10:15:00.000Z')), true);

  const contact = contactContent({ id: 'u1', name: 'Alice', username: 'alice', initials: 'AL', color: 'green', avatar: '/api/v1/users/u1/avatar?v=1' });
  assert.deepEqual(parseContact(contact), { id: 'u1', name: 'Alice', username: 'alice', initials: 'AL', color: 'green', avatar: '/api/v1/users/u1/avatar?v=1' });
  assert.equal(parseContact(contactContent({ name: 'Bob' })).initials, 'BO');
  assert.equal(parseContact('contact:{}'), null);
  assert.deepEqual([location, session, contact, 'hi'].map(messageKind), ['location', 'live', 'contact', 'text']);
  assert.equal(previewFor(location), '📍 Dhaka University');
  assert.equal(previewFor(locationContent({ lat: 1, lon: 2 })), '📍 Location');
  assert.equal(previewFor(session), '📍 Live location');
  assert.equal(previewFor(contact), '👤 Alice');
});

test('live updates are throttled by time and distance, and map tiles are computed correctly', () => {
  const start = { lat: 23.8103, lon: 90.4125, at: 10_000 };
  assert.equal(shouldSendLiveUpdate(null, start, 10_000), true);
  assert.equal(shouldSendLiveUpdate(start, { lat: 23.8103, lon: 90.4125 }, 11_000), false, 'too soon');
  assert.equal(shouldSendLiveUpdate(start, { lat: 23.8103, lon: 90.4125 }, 14_000), false, 'did not move');
  assert.equal(shouldSendLiveUpdate(start, { lat: 23.8104, lon: 90.4125 }, 14_000), true, 'moved about 11 m');
  assert.equal(shouldSendLiveUpdate(start, { lat: 23.8103, lon: 90.4125 }, 30_000), true, 'a heartbeat after a while even when still');

  const tile = tileFor(23.8103, 90.4125, 15);
  assert.deepEqual([tile.zoom, tile.x, tile.y], [15, 24613, 14151]);
  assert.ok(tile.offsetX >= 0 && tile.offsetX < 256 && tile.offsetY >= 0 && tile.offsetY < 256);
  assert.equal(osmTileUrl(tile), 'https://tile.openstreetmap.org/15/24613/14151.png');
});

test('nearby places are normalised, de-duplicated and sorted by distance; addresses are shortened', () => {
  const origin = { lat: 23.7340, lon: 90.3929 };
  const overpass = { elements: [
    { type: 'node', id: 1, lat: 23.7345, lon: 90.3930, tags: { amenity: 'cafe', name: 'Corner Café', 'addr:street': 'Mirpur Rd', 'addr:housenumber': '12' } },
    { type: 'way', id: 2, center: { lat: 23.7300, lon: 90.3929 }, tags: { amenity: 'university', name: 'Dhaka University' } },
    { type: 'node', id: 3, lat: 23.7345, lon: 90.3930, tags: { amenity: 'cafe', name: 'corner café' } },
    { type: 'node', id: 4, lat: 23.7341, lon: 90.3931, tags: { shop: 'supermarket', name: 'Fresh Mart' } },
    { type: 'node', id: 5, lat: 23.7341, lon: 90.3931, tags: { shop: 'bakery' } },
  ] };
  const places = normalizePlaces(overpass, origin);
  assert.deepEqual(places.map((place) => place.name), ['Fresh Mart', 'Corner Café', 'Dhaka University']);
  assert.equal(places[1].address, '12 Mirpur Rd');
  assert.equal(places[1].category, 'Café');
  assert.equal(places[2].category, 'University');
  assert.ok(places[2].distance > 400 && places[2].distance < 500);
  assert.deepEqual(normalizePlaces(null, origin), []);
  assert.equal(shortAddress({ address: { house_number: '5', road: 'Green Rd', suburb: 'Dhanmondi', city: 'Dhaka' } }), '5 Green Rd, Dhanmondi, Dhaka');
  assert.equal(shortAddress({ display_name: 'Somewhere' }), 'Somewhere');
});

test('live location is relayed only inside an accepted session, to all of the peer’s devices, and ends cleanly', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const mallory = await register('mallory');
  await link(alice, bob);
  const a = await connect(alice);
  const bPhone = await connect(bob);
  const bLaptop = await connect(bob);
  const m = await connect(mallory);

  live(m, { action: 'request', sessionId: 'evil', peerId: bob.user.id, durationMs: LIVE_DURATIONS[0].ms });
  await until(() => m.events.some((event) => event.type === 'error'), 'stranger rejected');
  live(a, { action: 'request', sessionId: 'bad-duration', peerId: bob.user.id, durationMs: 1234 });
  await until(() => a.events.some((event) => event.type === 'error' && /duration/.test(event.message)), 'duration rejected');

  live(a, { action: 'request', sessionId: 'live-1', peerId: bob.user.id, durationMs: LIVE_DURATIONS[1].ms });
  await until(() => liveEvents(bPhone, 'request').length === 1 && liveEvents(bLaptop, 'request').length === 1, 'request on both devices');
  assert.equal(liveEvents(bPhone, 'request')[0].durationMs, LIVE_DURATIONS[1].ms);
  assert.equal(liveEvents(bPhone, 'request')[0].from, alice.user.id);

  // Positions before acceptance are dropped on the floor.
  live(a, { action: 'update', sessionId: 'live-1', peerId: bob.user.id, lat: 23.81, lon: 90.41 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(liveEvents(bPhone, 'update').length, 0);

  // Only the recipient can accept; the initiator trying it is ignored.
  live(a, { action: 'accept', sessionId: 'live-1', peerId: bob.user.id });
  live(bPhone, { action: 'accept', sessionId: 'live-1', peerId: alice.user.id });
  await until(() => liveEvents(a, 'accept').length === 1, 'initiator sees acceptance');
  await until(() => liveEvents(bLaptop, 'accept').length === 1, 'other device learns it was accepted');

  live(a, { action: 'update', sessionId: 'live-1', peerId: bob.user.id, lat: 23.8103, lon: 90.4125, accuracy: 8.4 });
  live(bPhone, { action: 'update', sessionId: 'live-1', peerId: alice.user.id, lat: 23.8110, lon: 90.4130 });
  const toBob = await until(() => liveEvents(bPhone, 'update')[0], 'alice position reaches bob');
  assert.deepEqual([toBob.lat, toBob.lon, toBob.accuracy, toBob.from], [23.8103, 90.4125, 8, alice.user.id]);
  await until(() => liveEvents(bLaptop, 'update').length === 1, 'and his other device');
  const toAlice = await until(() => liveEvents(a, 'update')[0], 'bob position reaches alice');
  assert.equal(toAlice.from, bob.user.id);
  assert.ok(Math.abs(haversineDistance(toBob, toAlice) - 94) < 10, 'about 94 m apart');
  live(a, { action: 'update', sessionId: 'live-1', peerId: bob.user.id, lat: 123, lon: 0 });
  live(m, { action: 'update', sessionId: 'live-1', peerId: bob.user.id, lat: 1, lon: 1 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(liveEvents(bPhone, 'update').length, 1, 'invalid and foreign updates are ignored');

  live(bPhone, { action: 'stop', sessionId: 'live-1', peerId: alice.user.id });
  await until(() => liveEvents(a, 'stop').length === 1 && liveEvents(bLaptop, 'stop').length === 1, 'stop reaches everyone else');
  assert.equal(liveEvents(a, 'stop')[0].reason, 'stopped');
  assert.equal(service.liveSessions.has('live-1'), false);
  live(a, { action: 'update', sessionId: 'live-1', peerId: bob.user.id, lat: 23.8, lon: 90.4 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(liveEvents(bPhone, 'update').length, 1, 'nothing flows after stop');

  // Decline and expiry end the session for both.
  live(a, { action: 'request', sessionId: 'live-2', peerId: bob.user.id, durationMs: LIVE_DURATIONS[0].ms });
  await until(() => liveEvents(bPhone, 'request').length === 2, 'second request');
  live(bPhone, { action: 'decline', sessionId: 'live-2', peerId: alice.user.id });
  await until(() => liveEvents(a, 'stop').some((event) => event.sessionId === 'live-2' && event.reason === 'declined'), 'declined');
  live(a, { action: 'request', sessionId: 'live-3', peerId: bob.user.id, durationMs: LIVE_DURATIONS[2].ms });
  await until(() => liveEvents(bPhone, 'request').length === 3, 'third request');
  service.expireLiveSession('live-3');
  await until(() => liveEvents(a, 'stop').some((event) => event.sessionId === 'live-3' && event.reason === 'expired') && liveEvents(bPhone, 'stop').some((event) => event.sessionId === 'live-3'), 'expired both sides');
  assert.equal(service.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE 'location%' OR content LIKE 'live%'").get().n, 0, 'positions are never stored');
  for (const socket of [a, bPhone, bLaptop, m]) socket.close();
});

test('the chat wires location, live location and contact sharing end to end', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const chatWindow = await read('../src/components/ChatWindow.jsx');
  const picker = await read('../src/components/LocationPicker.jsx');
  const bubbles = await read('../src/components/LocationMessages.jsx');
  const app = await read('../src/App.jsx');
  const store = await read('../src/store.js');
  assert.ok(picker.includes('Send your current location') && picker.includes('Share live location') && picker.includes('Nearby places'), 'the picker has the three WhatsApp actions');
  assert.ok(picker.includes("import L from 'leaflet'") && picker.includes('fetchNearbyPlaces('), 'an interactive map with OSM nearby places');
  assert.ok(picker.includes('OSM_ATTRIBUTION'), 'OpenStreetMap is credited');
  assert.ok(chatWindow.includes('locationContent(') && chatWindow.includes('contactContent(') && chatWindow.includes('liveContent('), 'all three payloads are sent from the chat');
  assert.ok(chatWindow.includes("action: 'request', sessionId, peerId: chatId, durationMs") && chatWindow.includes('const sessionId = crypto.randomUUID()'), 'live sharing starts with a consent request');
  assert.ok(chatWindow.includes('liveContent({ sessionId, durationMs, startedAt, comment })') && chatWindow.includes('handleShareLive(durationMs, comment'), 'the optional comment travels with the live card');
  assert.ok(picker.includes('role="radiogroup"') && picker.includes('Add comment (optional)') && picker.includes('onShareLive(durationId.ms, comment)') && picker.includes('className="loc-live-send"'), 'the live sheet has duration chips, a comment field and a send button');
  assert.ok(bubbles.includes('live.comment'), 'the live card shows the comment');
  assert.ok(bubbles.includes('Accept') && bubbles.includes('Decline') && bubbles.includes('Stop sharing') && bubbles.includes('formatDistance('), 'the live card asks for consent and shows live distance');
  assert.ok(bubbles.includes('osmTileUrl(') && bubbles.includes('Message'), 'static map thumbnails and a contact card with a Message button');
  assert.ok(app.includes("event.type === 'location:live'") && app.includes('applyLiveEvent('), 'live events update the session store');
  assert.ok(store.includes('liveSessions:') && store.includes('watchPosition'), 'the store owns live sessions and device tracking');
});

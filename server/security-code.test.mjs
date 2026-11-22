// The Encryption screen of a chat (src/e2e/securityCode.js): the 60-digit code, or exactly why there is none. One
// line used to blame the contact's app for every case, under a fixed "does not use end-to-end encryption" text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createProtocol } from '../src/e2e/protocol.js';
import { SECURITY_CODE_STATES, resolveSecurityCode, securityCodeMessage } from '../src/e2e/securityCode.js';

const memory = () => { const map = new Map(); return { get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function twoAccounts() {
  const a = createProtocol({ storage: memory() });
  const b = createProtocol({ storage: memory() });
  const device = async (protocol, id) => ({ deviceId: id, identity: await protocol.publicIdentity() });
  return { a, b, mine: [await device(a, 'a1')], theirs: [await device(b, 'b1')] };
}

test('both sides have devices: the same 60 digits on both phones', async () => {
  const { a, b, mine, theirs } = await twoAccounts();
  const lists = { me: { devices: mine, listed: 1 }, peer: { devices: theirs, listed: 1 } };
  const forA = await resolveSecurityCode({ hasSession: true, ownId: 'me', peerId: 'peer', report: async (id) => lists[id], safetyNumber: (x, y) => a.safetyNumber(x, y) });
  const forB = await resolveSecurityCode({ hasSession: true, ownId: 'peer', peerId: 'me', report: async (id) => lists[id], safetyNumber: (x, y) => b.safetyNumber(x, y) });
  assert.equal(forA.status, 'ok');
  assert.equal(forA.code.replace(/\s/g, '').length, 60);
  assert.match(forA.code.replace(/\s/g, ''), /^\d{60}$/);
  assert.equal(forA.code, forB.code, 'the contact sees the same code');
});

test('every other case is told apart instead of blaming the contact\'s app', async () => {
  const { a, mine, theirs } = await twoAccounts();
  const resolve = (lists, extra = {}) => resolveSecurityCode({ hasSession: true, ownId: 'me', peerId: 'peer', report: async (id) => { if (lists[id] instanceof Error) throw lists[id]; return lists[id]; }, safetyNumber: (x, y) => a.safetyNumber(x, y), ...extra });
  const ok = { devices: mine, listed: 1 };
  assert.deepEqual(await resolve({ me: ok, peer: { devices: [], listed: 0 } }), { status: 'peer-no-keys' }, 'the contact really has no device with keys');
  assert.deepEqual(await resolve({ me: ok, peer: { devices: [], listed: 2 } }), { status: 'peer-unverified' }, 'devices listed, none passed this device\'s checks');
  assert.deepEqual(await resolve({ me: { devices: [], listed: 1 }, peer: { devices: theirs, listed: 1 } }), { status: 'own-unverified' }, 'this device is not on its own account\'s list');
  assert.deepEqual(await resolve({ me: { devices: [], listed: 0 }, peer: { devices: theirs, listed: 1 } }), { status: 'own-no-keys' });
  assert.deepEqual(await resolve({ me: ok, peer: new Error('network') }), { status: 'offline' }, 'a failed lookup is not "no keys"');
  assert.deepEqual(await resolve({ me: new Error('503'), peer: { devices: theirs, listed: 1 } }), { status: 'offline' });
  assert.deepEqual(await resolve({ me: ok, peer: { devices: theirs, listed: 1 } }, { hasSession: false }), { status: 'starting' });
  assert.deepEqual(await resolve({ me: ok, peer: { devices: theirs, listed: 1 } }, { safetyNumber: async () => { throw new Error('x'); } }), { status: 'offline' });
});

test('each state has its own wording; only a real code says "end-to-end encrypted"', () => {
  const texts = new Map(SECURITY_CODE_STATES.map((status) => [status, securityCodeMessage(status, 'মিলন HD')]));
  assert.equal(texts.get('ok').encrypted, true);
  for (const status of SECURITY_CODE_STATES.filter((item) => item !== 'ok')) assert.equal(texts.get(status).encrypted, false, status);
  assert.match(texts.get('peer-no-keys').text, /মিলন HD has no device with encryption keys right now/);
  assert.match(texts.get('peer-no-keys').text, /Nothing is sent unencrypted/);
  assert.match(texts.get('offline').text, /could not be reached/);
  assert.ok(!/মিলন HD/.test(texts.get('offline').text), 'a failed lookup does not name the contact as the cause');
  assert.ok(!/মিলন HD/.test(texts.get('own-unverified').text));
  assert.match(texts.get('peer-unverified').text, /did not pass its signature check/);
  assert.equal(new Set([...texts.values()].map((item) => item.text)).size, SECURITY_CODE_STATES.length - 1, 'only the two own-device states share a text');
  assert.equal(securityCodeMessage('something-new', 'X').encrypted, false, 'an unknown state never claims encryption');
});

test('the screen shows the state it was given, with no fixed "does not use end-to-end encryption" text', () => {
  const drawer = read('src/components/ContactInfoDrawer.jsx');
  assert.ok(!drawer.includes('does not use end-to-end encryption'), 'the text from before encryption existed is gone');
  assert.ok(!drawer.includes('appears once {peerName} opens an updated'), 'no single line for every failure');
  assert.match(drawer, /securityCodeState\(peerId\)\s+\.then\(\(next\) => \{ if \(!cancelled\) setState\(next\); \}\)\s+\.catch\(\(\) => \{ if \(!cancelled\) setState\(\{ status: 'offline' \}\); \}\);/);
  assert.match(drawer, /\{message\.encrypted \? <Lock size=\{48\} \/> : <LockOpen size=\{48\} \/>\}/, 'a closed lock only when it is encrypted');
  assert.match(drawer, /\{state\.status === 'ok' && \(\s+<div className="wa-security-code">/);
  assert.match(drawer, /state\.status === 'offline' \|\| state\.status === 'starting'\) && \(\s+<button type="button" className="wa-info-retry"/);
  const client = read('src/e2e/client.js');
  assert.match(client, /deviceLists\.set\(userId, \{ at: Date\.now\(\), devices: trusted, listed: Array\.isArray\(devices\) \? devices\.length : 0 \}\);/);
  assert.match(client, /export async function securityCodeState\(peerId\) \{[\s\S]{0,500}const devices = await refreshDevices\(userId\);/, 'fresh lists, and a failed fetch rejects');
});

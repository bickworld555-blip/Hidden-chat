// Signed device lists (src/e2e/deviceList.js, option B): the account key signs the account's devices; contacts pin it
// and encrypt only to listed devices. A device linked by QR is admitted by the phone that linked it; a password
// sign-in on a new phone makes a new account key (contacts see a security code change); the old phone is excluded.
// Each device below is its own instance of the app's client module, against a real server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { canonicalDeviceList, createAccountKey, pinDecision, signDeviceList, verifyDeviceList } from '../src/e2e/deviceList.js';
import { toBase64 } from '../src/e2e/primitives.js';

let service;
let directory;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-device-lists-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  for (const client of started) client.stopE2e();
  await service?.close();
  rmSync(directory, { recursive: true, force: true });
});

const memory = () => { const map = new Map(); return { get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); }, map }; };
async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { 'X-HM-Client': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => null) };
}
const PASSWORD = 'Correct-Horse-Battery-42!';
async function register(username) { return (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-01-01', password: PASSWORD } })).data; }
async function login(username) { return (await api('/api/v1/auth/login', { method: 'POST', body: { identity: username, password: PASSWORD } })).data; }

let instances = 0;
const started = [];
/** One device running the app's client module (a fresh module instance each). */
async function device(session, { canHold, linkStore = memory(), intercept = null } = {}) {
  const client = await import(`../src/e2e/client.js?device=${instances += 1}`);
  started.push(client);
  const events = [];
  client.onE2eEvent((event) => events.push(event));
  const fetchImpl = (path, options) => (intercept ? intercept(path, options, (p, o) => fetch(baseUrl + p, o)) : fetch(baseUrl + path, options));
  await client.startE2e({ token: session.token, userId: session.user.id, deviceId: session.deviceId, storage: memory(), records: memory(), linkStore, canHoldAccountKey: canHold, fetchImpl });
  return { client, events, session, startup: await client.deviceListStatus() };
}
const ids = (devices) => devices.map((item) => item.deviceId).sort();

test('the list format: canonical, bound to its account and key, pinned with rollback refusal', async () => {
  const key = await createAccountKey();
  const signed = await signDeviceList(key, { userId: 'u1', counter: 2, devices: [{ deviceId: 'b', identity: { dh: 'B'.repeat(87) + '=', sig: 'b'.repeat(87) + '=' } }, { deviceId: 'a', identity: { dh: 'A'.repeat(87) + '=', sig: 'a'.repeat(87) + '=' } }] });
  const verified = await verifyDeviceList(signed, 'u1');
  assert.deepEqual([...verified.devices.keys()], ['a', 'b'], 'sorted: one list, one encoding');
  await assert.rejects(verifyDeviceList(signed, 'u2'), /Invalid device list/, 'another account');
  await assert.rejects(verifyDeviceList({ ...signed, list: signed.list.replace('"n":2', '"n":3') }, 'u1'), /signature is invalid/);
  const reordered = JSON.parse(signed.list); reordered.d.reverse();
  await assert.rejects(verifyDeviceList({ ...signed, list: JSON.stringify(reordered) }, 'u1'), /Invalid device list/, 'not canonical');
  assert.equal(canonicalDeviceList(JSON.parse(signed.list)), signed.list);
  assert.equal(pinDecision(null, verified), 'pin');
  assert.equal(pinDecision({ accountKey: key.publicKey, counter: 3 }, verified), 'rollback');
  assert.equal(pinDecision({ accountKey: key.publicKey, counter: 2 }, verified), 'same');
  assert.equal(pinDecision({ accountKey: 'other', counter: 9 }, verified), 'changed');
});

test('option B lifecycle: create, pin, link by QR, ghost device ignored, rollback refused, new phone rotates, old phone excluded', async () => {
  // Alice's phone creates the account key; Bob's phone pins it.
  const alicePhoneSession = await register('dlalice');
  const alicePhone = await device(alicePhoneSession, { canHold: true });
  assert.equal(alicePhone.startup, 'created');
  assert.equal(await alicePhone.client.syncDeviceList(), 'holder', 'holder since');
  const bob = await device(await register('dlbob'), { canHold: true });
  const seen = await bob.client.contactEncrypted(alicePhoneSession.user.id);
  assert.equal(seen, true);

  const listBeforeBrowser = (await api(`/api/v1/e2e/users/${alicePhoneSession.user.id}/devices`, { token: bob.session.token })).data.signedList;

  // Alice links a browser by QR: the phone remembers the browser's link key; the browser proves its keys with it.
  const link = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const linkPublic = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', link.publicKey)));
  const request = (await api('/api/v1/link/requests', { method: 'POST', body: { publicKey: linkPublic, deviceName: 'Browser' } })).data;
  assert.equal((await api(`/api/v1/link/requests/${request.id}/approve`, { token: alicePhoneSession.token, method: 'POST', body: { secret: request.secret } })).status, 200);
  await alicePhone.client.rememberLinkApproval(linkPublic);
  const approved = (await api(`/api/v1/link/requests/${request.id}?secret=${request.secret}`)).data;
  assert.equal(approved.approver, alicePhoneSession.deviceId, 'the browser learns which device approved');
  const linkStore = memory();
  await linkStore.set('hm:link-claim', { privateKey: link.privateKey, publicKey: linkPublic, approver: approved.approver, userId: alicePhoneSession.user.id });
  const browser = await device(approved.session, { canHold: false, linkStore });
  assert.equal(browser.startup, 'claimed');
  assert.equal(await alicePhone.client.syncDeviceList(), 'holder');
  assert.equal(await browser.client.syncDeviceList(), 'member', 'the phone admitted it');
  assert.equal(linkStore.map.has('hm:link-claim'), false, 'the link key is gone once admitted');
  const listed = await api(`/api/v1/e2e/users/${alicePhoneSession.user.id}/devices`, { token: bob.session.token });
  assert.deepEqual(ids(listed.data.devices), [alicePhoneSession.deviceId, approved.session.deviceId].sort());

  // A forged claim (MAC not from the link key the phone saw) is never admitted.
  const intruderSession = await login('dlalice');
  const intruder = await device(intruderSession, { canHold: false });
  await api('/api/v1/e2e/link-claims', { token: intruderSession.token, method: 'POST', body: { linkKey: linkPublic, mac: toBase64(new Uint8Array(32)), approver: alicePhoneSession.deviceId } });
  await alicePhone.client.syncDeviceList();
  assert.ok(!ids((await api(`/api/v1/e2e/users/${alicePhoneSession.user.id}/devices`, { token: bob.session.token })).data.devices).includes(intruderSession.deviceId), 'not listed, so not advertised');

  // A server that slips in a ghost device, replays the older list (before the browser) or strips the list after the
  // pin: Carol's app encrypts to none of it.
  let mode = 'normal';
  const carol = await device(await register('dlcarol'), { canHold: true, intercept: async (path, options, real) => {
    const response = await real(path, options);
    if (!path.startsWith(`/api/v1/e2e/users/${alicePhoneSession.user.id}/devices`) || mode === 'normal') return response;
    const body = await response.json();
    if (mode === 'ghost') body.devices.push({ deviceId: 'ghost', identity: { dh: 'G'.repeat(87) + '=', sig: 'g'.repeat(87) + '=' } });
    if (mode === 'rollback') body.signedList = listBeforeBrowser;
    if (mode === 'stripped') delete body.signedList;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(await carol.client.contactEncrypted(alicePhoneSession.user.id), true, 'pins the list with the browser (counter 2)');
  mode = 'ghost';
  assert.equal(await carol.client.contactEncrypted(alicePhoneSession.user.id, { fresh: true }), true, 'the ghost is dropped, the real devices stay');
  mode = 'rollback';
  assert.equal(await carol.client.contactEncrypted(alicePhoneSession.user.id, { fresh: true }), false, 'an older list under the pinned key is refused');
  mode = 'stripped';
  assert.equal(await carol.client.contactEncrypted(alicePhoneSession.user.id, { fresh: true }), false, 'no list after a pin: nothing to encrypt to');
  mode = 'normal';
  assert.equal(await carol.client.contactEncrypted(alicePhoneSession.user.id, { fresh: true }), true);

  // Alice signs in with her password on a new phone: a new account key naming only it.
  const newPhoneSession = await login('dlalice');
  const newPhone = await device(newPhoneSession, { canHold: true });
  assert.equal(newPhone.startup, 'rotated');
  bob.events.length = 0;
  const afterRotation = await api(`/api/v1/e2e/users/${alicePhoneSession.user.id}/devices`, { token: bob.session.token });
  assert.deepEqual(ids(afterRotation.data.devices), [newPhoneSession.deviceId], 'only the new phone is advertised');
  assert.equal(await bob.client.contactEncrypted(alicePhoneSession.user.id, { fresh: true }), true);
  assert.ok(bob.events.some((event) => event.type === 'identity-changed' && event.userId === alicePhoneSession.user.id && event.deviceId === null), 'Bob is told the security code changed');
  assert.equal(await alicePhone.client.syncDeviceList(), 'excluded', 'the old phone no longer receives');
  assert.ok(alicePhone.events.some((event) => event.type === 'device-list-excluded'));
  assert.equal(await browser.client.syncDeviceList(), 'waiting', 'the linked browser needs linking again too');
});

test('a forged signature gives no devices; the list filter keeps only listed identities', async () => {
  const owner = await register('dlowner');
  const ownerPhone = await device(owner, { canHold: true });
  await ownerPhone.client.syncDeviceList();
  let forged = false;
  const watcher = await device(await register('dlwatch'), { canHold: true, intercept: async (path, options, real) => {
    const response = await real(path, options);
    if (!forged || !path.startsWith(`/api/v1/e2e/users/${owner.user.id}/devices`)) return response;
    const body = await response.json();
    body.signedList = { ...body.signedList, signature: toBase64(new Uint8Array(64)) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  forged = true;
  assert.equal(await watcher.client.contactEncrypted(owner.user.id), false);
  forged = false;
  assert.equal(await watcher.client.contactEncrypted(owner.user.id, { fresh: true }), true);
  const { listedDevices } = await import('../src/e2e/deviceList.js');
  const signed = (await api(`/api/v1/e2e/users/${owner.user.id}/devices`, { token: owner.token })).data;
  const verified = await verifyDeviceList(signed.signedList, owner.user.id);
  const swapped = { deviceId: owner.deviceId, identity: { ...signed.devices[0].identity, dh: 'S'.repeat(87) + '=' } };
  assert.deepEqual(listedDevices([...signed.devices, swapped, { deviceId: 'ghost', identity: swapped.identity }], verified).length, 1, 'a swapped identity or an unknown device is dropped');
});

test('the server stores only lists signed by the key they name, naming the uploader, never older than the stored one', async () => {
  const owner = await register('dlserver');
  const phone = await device(owner, { canHold: true });
  await phone.client.syncDeviceList();
  const stored = (await api(`/api/v1/e2e/users/${owner.user.id}/devices`, { token: owner.token })).data.signedList;
  const tampered = { list: stored.list.replace(/"at":\d+/, '"at":1'), signature: stored.signature };
  assert.equal((await api('/api/v1/e2e/device-list', { token: owner.token, method: 'PUT', body: tampered })).status, 400);
  assert.equal((await api('/api/v1/e2e/device-list', { token: owner.token, method: 'PUT', body: stored })).status, 409, 'same counter under the same key');
  const stranger = await register('dlstranger');
  await device(stranger, { canHold: true });
  assert.equal((await api('/api/v1/e2e/device-list', { token: stranger.token, method: 'PUT', body: stored })).status, 400, 'another account’s list');
});

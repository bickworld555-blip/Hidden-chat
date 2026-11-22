// The native-app protocol (src/e2e/bridgeProtocol.js) is a drop-in for createProtocol: every method is exercised
// through an adapter that mirrors the native NativeBridge over a real JS createProtocol, so a message sealed by a
// bridge protocol opens on another and the method/argument/result shapes match the contract. (The native core itself
// is proven byte-for-byte in the Kotlin core.* tests; this covers the JS wiring.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProtocol } from '../src/e2e/protocol.js';
import { createBridgeProtocol } from '../src/e2e/bridgeProtocol.js';
import { sha256Hex } from '../src/e2e/primitives.js';

const api = globalThis.crypto;
const memStorage = () => { const map = new Map(); return { get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };

// Mirrors android .../core/NativeBridge.kt over a JS protocol, so the bridge protocol talks to a real implementation.
function adapter(protocol) {
  const bundlesClaim = (bundles) => (userId, ids) => (bundles?.[userId] ?? []).filter((bundle) => ids.includes(bundle.deviceId));
  return async (method, args) => {
    try {
      switch (method) {
        case 'prepareUpload': return { result: await protocol.prepareUpload({ serverPreKeyCount: args.serverPreKeyCount ?? 0, now: args.now }) };
        case 'publicIdentity': return { result: await protocol.publicIdentity() };
        case 'missingSessions': { const out = {}; for (const [u, list] of Object.entries(args.devices)) out[u] = list.map((d) => d.deviceId); return { result: out }; }
        case 'encryptForDevices': return { result: await protocol.encryptForDevices(args.devices, args.plaintext, { claimBundles: bundlesClaim(args.bundles) }) };
        case 'decryptFromDevice': return { result: await protocol.decryptFromDevice(args.userId, args.deviceId, args.entry) };
        case 'forgetSession': await protocol.forgetSession(args.userId, args.deviceId); return { ok: true };
        case 'encryptGroup': return { result: await protocol.encryptGroup(args.groupId, { userId: args.meUserId, deviceId: args.meDeviceId }, args.memberDevices, args.plaintext, { claimBundles: bundlesClaim(args.bundles), digest: (t) => sha256Hex(t) }) };
        case 'confirmGroupSend': await protocol.confirmGroupSend(args.groupId, args.keyId); return { ok: true };
        case 'decryptGroup': return { result: await protocol.decryptGroup(args.groupId, { userId: args.meUserId, deviceId: args.meDeviceId }, args.userId, args.deviceId, args.body) };
        case 'safetyNumber': return { result: await protocol.safetyNumber(args.mine, args.theirs) };
        case 'signPreviewKey': return { result: await protocol.signPreviewKey(args.previewKey) };
        default: return { error: 'unknown-method' };
      }
    } catch (error) {
      return { error: error.code ?? error.message };
    }
  };
}

const aliceUser = '1111111111', aliceDev = 'alice-dev', bobUser = '2222222222', bobDev = 'bob-dev';

function pair() {
  const alice = createProtocol({ storage: memStorage(), api });
  const bob = createProtocol({ storage: memStorage(), api });
  return { alice: createBridgeProtocol(adapter(alice)), bob: createBridgeProtocol(adapter(bob)), rawBob: bob };
}

test('bridge protocol: a direct message round-trips through two bridge protocols', async () => {
  const { alice, bob } = pair();
  const upload = await bob.prepareUpload({ serverPreKeyCount: 0 });
  let next = 0;
  const claimBundles = async (userId, ids) => ids.map((deviceId) => ({ deviceId, identity: upload.identity, signedPreKey: upload.signedPreKey, preKey: upload.preKeys[next++] }));
  const entries = await alice.encryptForDevices({ [bobUser]: [{ deviceId: bobDev }] }, 'hi through the bridge — বাংলা', { claimBundles });
  const entry = entries[bobUser][bobDev];
  assert.equal(await bob.decryptFromDevice(aliceUser, aliceDev, entry), 'hi through the bridge — বাংলা');
});

test('bridge protocol: a group message round-trips', async () => {
  const { alice, bob } = pair();
  const upload = await bob.prepareUpload({ serverPreKeyCount: 0 });
  let next = 0;
  const claimBundles = async (userId, ids) => ids.map((deviceId) => ({ deviceId, identity: upload.identity, signedPreKey: upload.signedPreKey, preKey: upload.preKeys[next++] }));
  const members = { [aliceUser]: [aliceDev], [bobUser]: [bobDev] };
  const sealed = await alice.encryptGroup('grp', { userId: aliceUser, deviceId: aliceDev }, members, 'group through the bridge', { claimBundles });
  const body = { sd: aliceDev, ...sealed.body };
  assert.equal(await bob.decryptGroup('grp', { userId: bobUser, deviceId: bobDev }, aliceUser, aliceDev, body), 'group through the bridge');
});

test('bridge protocol: safety number and errors', async () => {
  const { alice, bob } = pair();
  const id = await alice.publicIdentity();
  assert.match(await alice.safetyNumber([id], [id]), /^(\d{5} ){11}\d{5}$/);
  // A message not addressed to bob comes back as an error code (thrown with .code), not a crash.
  await assert.rejects(() => bob.decryptFromDevice(aliceUser, aliceDev, { h: { dh: 'x', pn: 0, n: 0 }, c: 'AAAA' }));
});

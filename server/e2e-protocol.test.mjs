// The end-to-end protocol (src/e2e/): X3DH, the Double Ratchet, Sender Keys and multi-device fan-out, run between
// simulated devices with in-memory key storage and a simulated key directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, effectiveRouting, membersHash, parseEnvelope, routingFor, withRoutedMedia } from '../src/e2e/envelope.js';
import { MAX_SKIP } from '../src/e2e/ratchet.js';

function memoryStorage() {
  const map = new Map();
  return { map, get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); } };
}

// A key directory like the server's: published bundles, one-time prekeys handed out once.
function directory() {
  const devices = new Map();
  return {
    async publish(userId, deviceId, upload) {
      const key = `${userId}/${deviceId}`;
      // Like the server: a new identity for the device replaces its keys, one-time prekeys included.
      const existing = devices.get(key);
      const current = existing && existing.identity.dh === upload.identity.dh ? existing : { preKeys: [] };
      devices.set(key, { identity: upload.identity, signedPreKey: upload.signedPreKey, preKeys: [...current.preKeys, ...upload.preKeys] });
    },
    count(userId, deviceId) { return devices.get(`${userId}/${deviceId}`)?.preKeys.length ?? 0; },
    claimBundles: async (userId, deviceIds) => deviceIds.map((deviceId) => {
      const entry = devices.get(`${userId}/${deviceId}`);
      if (!entry) return null;
      const preKey = entry.preKeys.shift();
      return { deviceId, identity: entry.identity, signedPreKey: entry.signedPreKey, ...(preKey ? { preKey } : {}) };
    }).filter(Boolean),
    entry(userId, deviceId) { return devices.get(`${userId}/${deviceId}`); },
  };
}

async function device(dir, userId, deviceId) {
  const protocol = createProtocol({ storage: memoryStorage() });
  await dir.publish(userId, deviceId, await protocol.prepareUpload({ serverPreKeyCount: 0 }));
  return { userId, deviceId, protocol };
}

const send = (from, to, text, dir) => from.protocol.encryptForDevices({ [to.userId]: [{ deviceId: to.deviceId }] }, text, { claimBundles: dir.claimBundles })
  .then((map) => map[to.userId][to.deviceId]);
const open = (at, from, entry) => at.protocol.decryptFromDevice(from.userId, from.deviceId, entry);

test('X3DH + Double Ratchet: first message, replies both ways and the prekey header until answered', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  assert.equal(dir.count('bob', 'b1'), 100);

  const first = await send(alice, bob, 'hello bob', dir);
  assert.ok(first.p?.ek && first.p.opk !== undefined, 'first message carries the X3DH header with a one-time prekey');
  assert.equal(dir.count('bob', 'b1'), 99, 'the one-time prekey was handed out once');
  const second = await send(alice, bob, 'still there?', dir);
  assert.ok(second.p, 'until Bob answers, every message carries the header');
  assert.equal(await open(bob, alice, first), 'hello bob');
  assert.equal(await open(bob, alice, second), 'still there?');

  const reply = await send(bob, alice, 'hi alice', dir);
  assert.equal(reply.p, undefined, 'the responder never sends a prekey header');
  assert.equal(await open(alice, bob, reply), 'hi alice');
  const third = await send(alice, bob, 'great', dir);
  assert.equal(third.p, undefined, 'answered: the header is dropped');
  assert.equal(await open(bob, alice, third), 'great');
  for (let round = 0; round < 5; round += 1) {
    assert.equal(await open(alice, bob, await send(bob, alice, `b${round}`, dir)), `b${round}`);
    assert.equal(await open(bob, alice, await send(alice, bob, `a${round}`, dir)), `a${round}`);
  }
});

test('Double Ratchet: out-of-order delivery works, replays and tampering are rejected without harming the session', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  await open(bob, alice, await send(alice, bob, 'open', dir));
  await open(alice, bob, await send(bob, alice, 'ok', dir));
  const messages = [];
  for (let index = 0; index < 6; index += 1) messages.push(await send(alice, bob, `m${index}`, dir));
  for (const index of [3, 0, 5, 1, 4, 2]) assert.equal(await open(bob, alice, messages[index]), `m${index}`);
  await assert.rejects(open(bob, alice, messages[2]), 'a replayed message cannot be decrypted twice');

  const genuine = await send(alice, bob, 'genuine', dir);
  const tampered = { ...genuine, c: genuine.c.slice(0, -4) + (genuine.c.endsWith('AAA=') ? 'BBB=' : 'AAA=') };
  await assert.rejects(open(bob, alice, tampered));
  const forgedHeader = { ...genuine, h: { ...genuine.h, n: genuine.h.n + 3 } };
  await assert.rejects(open(bob, alice, forgedHeader));
  assert.equal(await open(bob, alice, genuine), 'genuine', 'failed attempts did not change the session');
  await assert.rejects(open(bob, alice, { ...genuine, h: { ...genuine.h, n: genuine.h.n + MAX_SKIP + 5 } }), 'a huge skip is refused');
});

test('A one-time prekey is used once and the X3DH header cannot open a second session', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  const first = await send(alice, bob, 'one', dir);
  assert.equal(await open(bob, alice, first), 'one');
  // The same header again (Alice re-sent before Bob answered) matches the existing session by its base key.
  assert.equal(await open(bob, alice, await send(alice, bob, 'two', dir)), 'two');
  // A different initiator reusing the same one-time prekey id is refused: Bob deleted it.
  const mallory = await device(dir, 'mallory', 'm1');
  const forged = await send(mallory, bob, 'x', dir);
  forged.p = { ...forged.p, opk: first.p.opk };
  await assert.rejects(open(bob, mallory, forged), /already used|could not|decrypt/i);
});

test('Simultaneous first messages: both sides end up able to talk', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  const fromAlice = await send(alice, bob, 'hi from alice', dir);
  const fromBob = await send(bob, alice, 'hi from bob', dir);
  assert.equal(await open(bob, alice, fromAlice), 'hi from alice');
  assert.equal(await open(alice, bob, fromBob), 'hi from bob');
  for (let round = 0; round < 3; round += 1) {
    assert.equal(await open(bob, alice, await send(alice, bob, `a${round}`, dir)), `a${round}`);
    assert.equal(await open(alice, bob, await send(bob, alice, `b${round}`, dir)), `b${round}`);
  }
});

test('Trust on first use: a changed identity for a known device is refused', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  assert.equal(await open(bob, alice, await send(alice, bob, 'hello', dir)), 'hello');
  // Someone replaces Bob's published keys under the same device id (a malicious key server).
  const impostor = createProtocol({ storage: memoryStorage() });
  await dir.publish('bob', 'b1', await impostor.prepareUpload({ serverPreKeyCount: 0 }));
  const fresh = createProtocol({ storage: memoryStorage() });
  // A device that already knew Bob's key refuses the new one…
  const knownStorage = memoryStorage();
  const careful = createProtocol({ storage: knownStorage });
  await dir.publish('carol', 'c1', await careful.prepareUpload({ serverPreKeyCount: 0 }));
  const entry = dir.entry('bob', 'b1');
  const { identityBytes, parseIdentity } = await import('../src/e2e/ratchet.js');
  const { toBase64 } = await import('../src/e2e/primitives.js');
  knownStorage.map.set('known:bob/b1', toBase64(identityBytes(parseIdentity((await bob.protocol.publicIdentity())))));
  await assert.rejects(careful.encryptForDevices({ bob: [{ deviceId: 'b1' }] }, 'x', { claimBundles: dir.claimBundles }), /security key changed/);
  // …while a device meeting Bob for the first time cannot tell (that is what the safety number is for).
  assert.ok(entry.identity.dh !== (await bob.protocol.publicIdentity()).dh);
  await fresh.prepareUpload();
});

test('Multi-device fan-out: one message encrypted for every recipient device and the sender’s other devices', async () => {
  const dir = directory();
  const alicePhone = await device(dir, 'alice', 'phone');
  const aliceLaptop = await device(dir, 'alice', 'laptop');
  const bobPhone = await device(dir, 'bob', 'phone');
  const bobTablet = await device(dir, 'bob', 'tablet');
  const map = await alicePhone.protocol.encryptForDevices({
    bob: [{ deviceId: 'phone' }, { deviceId: 'tablet' }],
    alice: [{ deviceId: 'laptop' }],
  }, 'to all of you', { claimBundles: dir.claimBundles });
  assert.deepEqual(Object.keys(map).sort(), ['alice', 'bob']);
  assert.equal(await open(bobPhone, alicePhone, map.bob.phone), 'to all of you');
  assert.equal(await open(bobTablet, alicePhone, map.bob.tablet), 'to all of you');
  assert.equal(await open(aliceLaptop, alicePhone, map.alice.laptop), 'to all of you');
  // Each device's ciphertext is its own: another device cannot open it.
  await assert.rejects(open(bobTablet, alicePhone, map.bob.phone));
  assert.notEqual(map.bob.phone.c, map.bob.tablet.c);
});

test('Sender Keys: groups encrypt once, distribute keys pairwise, and rotate when membership changes', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  const carol = await device(dir, 'carol', 'c1');
  const digest = alice.protocol.digest;
  const members = { alice: ['a1'], bob: ['b1'], carol: ['c1'] };
  const opts = { claimBundles: dir.claimBundles, digest };
  const me = (d) => ({ userId: d.userId, deviceId: d.deviceId });

  const first = await alice.protocol.encryptGroup('g1', me(alice), members, 'hello group', opts);
  assert.ok(first.body.x?.bob?.b1 && first.body.x?.carol?.c1 && !first.body.x?.alice, 'the key goes to every other member device');
  assert.equal(first.body.mh, await membersHash(['alice/a1', 'bob/b1', 'carol/c1'], digest));
  assert.equal(await bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', first.body), 'hello group');
  // Not confirmed yet: the next message still carries the distribution (the first may not have been stored).
  const second = await alice.protocol.encryptGroup('g1', me(alice), members, 'second', opts);
  assert.ok(second.body.x);
  await alice.protocol.confirmGroupSend('g1', first.keyId);
  const third = await alice.protocol.encryptGroup('g1', me(alice), members, 'third', opts);
  assert.equal(third.body.x, undefined, 'confirmed: later messages are one ciphertext for everyone');
  assert.equal(third.body.g.kid, first.body.g.kid);
  // Carol gets the key with the first message, then reads the others out of order; Bob reads the rest; a replay fails.
  assert.equal(await carol.protocol.decryptGroup('g1', me(carol), 'alice', 'a1', first.body), 'hello group');
  assert.equal(await carol.protocol.decryptGroup('g1', me(carol), 'alice', 'a1', third.body), 'third');
  assert.equal(await carol.protocol.decryptGroup('g1', me(carol), 'alice', 'a1', second.body), 'second');
  assert.equal(await bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', second.body), 'second');
  await assert.rejects(bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', second.body));
  // A forged signature is refused.
  const forged = { ...third.body, g: { ...third.body.g, s: second.body.g.s } };
  await assert.rejects(bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', forged), /signature/);
  assert.equal(await bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', third.body), 'third');

  // Carol leaves: Alice's next message uses a brand-new key that Carol never receives.
  const after = await alice.protocol.encryptGroup('g1', me(alice), { alice: ['a1'], bob: ['b1'] }, 'carol is gone', opts);
  assert.notEqual(after.body.g.kid, first.body.g.kid);
  assert.ok(after.body.x?.bob?.b1 && !after.body.x?.carol);
  assert.equal(await bob.protocol.decryptGroup('g1', me(bob), 'alice', 'a1', after.body), 'carol is gone');
  await assert.rejects(carol.protocol.decryptGroup('g1', me(carol), 'alice', 'a1', after.body), /Waiting for this message/);
});

test('Signed prekeys rotate weekly and one-time prekeys are refilled only when low', async () => {
  const protocol = createProtocol({ storage: memoryStorage() });
  const first = await protocol.prepareUpload({ serverPreKeyCount: 0, now: 1_000 });
  assert.equal(first.preKeys.length, 100);
  const again = await protocol.prepareUpload({ serverPreKeyCount: 80, now: 2_000 });
  assert.equal(again.preKeys.length, 0);
  assert.equal(again.signedPreKey.id, first.signedPreKey.id);
  const low = await protocol.prepareUpload({ serverPreKeyCount: 10, now: 3_000 });
  assert.equal(low.preKeys.length, 90);
  assert.ok(Math.min(...low.preKeys.map((key) => key.id)) > Math.max(...first.preKeys.map((key) => key.id)), 'ids are never reused');
  const later = await protocol.prepareUpload({ serverPreKeyCount: 90, now: 1_000 + 8 * 24 * 60 * 60 * 1000 });
  assert.notEqual(later.signedPreKey.id, first.signedPreKey.id);
  assert.deepEqual(later.identity, first.identity, 'the identity never changes');
});

test('Envelope: routing tells the server only what it needs; everything else is ciphertext', () => {
  assert.equal(routingFor('hello'), 'text');
  assert.equal(routingFor('media:abc:photo.jpg'), 'media:abc');
  assert.equal(routingFor('emedia:abc:xyz:photo.jpg'), 'media:abc');
  assert.equal(routingFor('voice:v1:12.5'), 'voice:v1:12.5');
  assert.equal(routingFor('voice:v1:7:once'), 'voice:v1:7:once');
  assert.equal(routingFor('poll:{"question":"q","options":["a","b","c"],"multiple":true}'), 'poll:3:1');
  assert.equal(routingFor('location:{"lat":1}'), 'other');
  assert.equal(routingFor('note: plain words'), 'text');
  const envelope = buildEnvelope('voice:v1:7:once', { sd: 'dev1', d: { bob: { b1: { h: { dh: 'x', pn: 0, n: 0 }, c: 'y' } } } });
  assert.equal(effectiveRouting(envelope), 'voice:v1:7:once');
  assert.deepEqual(parseEnvelope(envelope).route, { kind: 'voice', mediaId: 'v1', seconds: '7', once: true });
  assert.equal(parseEnvelope('e2e2:text|{"v":2,"sd":"d","d":{},"g":{},"mh":"x"}'), null, 'direct and group bodies are exclusive');
  assert.equal(parseEnvelope('e2e2:bogus|{}'), null);
  assert.equal(withRoutedMedia('emedia:old:desc:photo.jpg', { mediaId: 'copy' }), 'emedia:copy:desc:photo.jpg');
  assert.equal(withRoutedMedia('voice:old:3', { mediaId: 'copy' }), 'voice:copy:3');
});

test('A contact device with reset keys: the app accepts the new key, reports it, and talks again', async () => {
  const dir = directory();
  const changes = [];
  const alice = { userId: 'alice', deviceId: 'a1', protocol: createProtocol({ storage: memoryStorage(), onIdentityChange: (userId, deviceId) => changes.push(`${userId}/${deviceId}`) }) };
  await dir.publish('alice', 'a1', await alice.protocol.prepareUpload({ serverPreKeyCount: 0 }));
  const bob = await device(dir, 'bob', 'b1');
  assert.equal(await open(bob, alice, await send(alice, bob, 'before', dir)), 'before');
  // Bob's app data is wiped: same device id, new keys published.
  const reset = await device(dir, 'bob', 'b1');
  const listed = { bob: [{ deviceId: 'b1', identity: dir.entry('bob', 'b1').identity }] };
  const entry = (await alice.protocol.encryptForDevices(listed, 'after', { claimBundles: dir.claimBundles })).bob.b1;
  assert.ok(entry.p, 'a fresh session to the new key');
  assert.equal(await open(reset, alice, entry), 'after');
  assert.deepEqual(changes, ['bob/b1'], 'the change is reported once');
});

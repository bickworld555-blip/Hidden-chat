#!/usr/bin/env node
// Records a transcript of the web app's end-to-end protocol (src/e2e/) for the native core's conformance tests
// (android/app/src/test/.../E2eVectorsTest.kt): every random value the JavaScript drew (generated key pairs, random
// bytes) is captured per party, so an implementation that is fed the same values must produce the same ciphertexts,
// headers and signatures-to-verify byte for byte. Writes android/app/src/test/resources/e2e-vectors.json.
//
//   node scripts/e2e-native-vectors.mjs
//
// Nothing here is secret: the keys are made for this file and never used anywhere else.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateDhPair, generateSigningPair, toBase64, fromBase64, sha256Hex } from '../src/e2e/primitives.js';
import { initInitiator, initResponder, publicIdentity, ratchetDecrypt, ratchetEncrypt, signPreKey, x3dhInitiate, x3dhRespond, KDF_INFO } from '../src/e2e/ratchet.js';
import { acceptDistribution, createSenderKey, senderKeyDecrypt, senderKeyEncrypt } from '../src/e2e/senderKeys.js';
import { openPreview, sealPreview, previewText, PREVIEW_INFO } from '../src/e2e/preview.js';
import { createAccountKey, linkClaimMac, signDeviceList, verifyDeviceList, DEVICE_LIST_CONTEXT, LINK_CLAIM_CONTEXT } from '../src/e2e/deviceList.js';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, parseEnvelope, routingFor, membersHash } from '../src/e2e/envelope.js';

const real = globalThis.crypto;
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const hexUrl = (b64url) => Buffer.from(b64url, 'base64url').toString('hex');
const text = (s) => new TextEncoder().encode(s);

/**
 * A party's view of Web Crypto: every generated key pair is made extractable and its private scalar and public point
 * recorded in order; every random draw is recorded in order. The protocol code sees an ordinary `api`.
 */
function party() {
  const generated = [];
  const randoms = [];
  const subtle = new Proxy(real.subtle, {
    get(target, prop) {
      if (prop === 'generateKey') {
        return (algorithm, _extractable, usages) => target.generateKey(algorithm, true, usages).then(async (pair) => {
          const jwk = await target.exportKey('jwk', pair.privateKey);
          generated.push({ alg: algorithm.name, d: hexUrl(jwk.d), pub: `04${hexUrl(jwk.x)}${hexUrl(jwk.y)}` });
          return pair;
        });
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const api = { subtle, getRandomValues: (array) => { real.getRandomValues(array); randoms.push(hex(array)); return array; } };
  return { api, generated, randoms };
}

const b64 = (bytes) => toBase64(bytes);

async function ratchetTranscript() {
  const alice = party();
  const bob = party();
  const bobIdentity = { dh: await generateDhPair(bob.api), sig: await generateSigningPair(bob.api) };
  const spk = await generateDhPair(bob.api);
  const spkSignature = await signPreKey(bobIdentity, spk.publicKey, bob.api);
  const opk = await generateDhPair(bob.api);
  const aliceIdentity = { dh: await generateDhPair(alice.api), sig: await generateSigningPair(alice.api) };
  const bundle = { identity: publicIdentity(bobIdentity), signedPreKey: { id: 7, key: b64(spk.publicKey), signature: b64(spkSignature) }, preKey: { id: 42, key: b64(opk.publicKey) } };

  // The fixed sequence (E2eVectorsTest replays exactly this): Alice sends m1..m3; Bob opens m1, m3, m2 (a skipped
  // key); Bob replies r1, r2 (a DH turn for Alice); Alice opens r1, r2; Alice sends m4 (a DH turn for Bob); Bob opens m4.
  const steps = [];
  const agreed = await x3dhInitiate(aliceIdentity, bundle, alice.api);
  let a = await initInitiator(agreed.secret, agreed.remoteSignedPreKey, agreed.ad, alice.api);
  const send = async (who, state, name, plaintext) => {
    const sealed = await ratchetEncrypt(state, text(plaintext), who === 'alice' ? alice.api : bob.api);
    steps.push({ name, from: who, plaintext, header: sealed.header, ciphertext: sealed.ciphertext });
    return sealed.state;
  };
  const byName = (name) => steps.find((step) => step.name === name);
  a = await send('alice', a, 'm1', 'hello bob');
  a = await send('alice', a, 'm2', 'second message, skipped at first');
  a = await send('alice', a, 'm3', 'তৃতীয় বার্তা — third, with UTF-8');
  const responded = await x3dhRespond(bobIdentity, agreed.preKeyHeader, spk, opk, bob.api);
  let b = await initResponder(responded.secret, spk, responded.ad, bob.api);
  const open = async (who, state, name) => {
    const step = byName(name);
    const opened = await ratchetDecrypt(state, step.header, step.ciphertext, who === 'alice' ? alice.api : bob.api);
    if (new TextDecoder().decode(opened.plaintext) !== step.plaintext) throw new Error(`transcript broke at ${name}`);
    return opened.state;
  };
  b = await open('bob', b, 'm1');
  b = await open('bob', b, 'm3');
  b = await open('bob', b, 'm2');
  b = await send('bob', b, 'r1', 'hi alice, got all three');
  b = await send('bob', b, 'r2', 'and one more from bob');
  a = await open('alice', a, 'r1');
  a = await open('alice', a, 'r2');
  a = await send('alice', a, 'm4', 'new chain after your reply');
  b = await open('bob', b, 'm4');
  const order = ['send m1', 'send m2', 'send m3', 'bob opens m1', 'bob opens m3', 'bob opens m2', 'send r1', 'send r2', 'alice opens r1', 'alice opens r2', 'send m4', 'bob opens m4'];
  return {
    alice: { identity: { dh: alice.generated[0], sig: alice.generated[1] }, generated: alice.generated.slice(2), randoms: alice.randoms },
    bob: { identity: { dh: bob.generated[0], sig: bob.generated[1] }, signedPreKey: { id: 7, ...bob.generated[2], signature: b64(spkSignature) }, preKey: { id: 42, ...bob.generated[3] }, generated: bob.generated.slice(4), randoms: bob.randoms },
    bundle,
    preKeyHeader: agreed.preKeyHeader,
    ad: { aliceSide: hex(agreed.ad), bobSide: hex(responded.ad) },
    sharedSecret: hex(agreed.secret),
    steps,
    order,
  };
}

async function senderKeyTranscript() {
  const alice = party();
  const bob = party();
  const groupId = 'group-vector-1';
  const digest = (value) => sha256Hex(value);
  const mh = await membersHash(['1111111111/dev-a', '2222222222/dev-b', '2222222222/dev-c'], digest);
  const senderAddress = '1111111111/dev-a';
  const created = await createSenderKey(groupId, mh, alice.api);
  let state = created.state;
  const messages = [];
  for (const plaintext of ['group hello', 'second group line', 'third, opened before the second']) {
    const sealed = await senderKeyEncrypt(state, senderAddress, text(plaintext), alice.api);
    messages.push({ plaintext, message: sealed.message });
    state = sealed.state;
  }
  let receiving = await acceptDistribution(created.distribution, groupId, bob.api);
  for (const index of [0, 2, 1]) {
    const opened = await senderKeyDecrypt(receiving, senderAddress, messages[index].message, bob.api);
    if (new TextDecoder().decode(opened.plaintext) !== messages[index].plaintext) throw new Error('sender key transcript broke');
    receiving = opened.state;
  }
  return { groupId, membersHash: mh, senderAddress, alice: { generated: alice.generated, randoms: alice.randoms }, distribution: created.distribution, messages, bobOrder: [0, 2, 1] };
}

async function previewVector() {
  const phone = party();
  const sender = party();
  const recipient = await generateDhPair(phone.api);
  const long = 'A'.repeat(160);
  const sealed = await sealPreview(b64(recipient.publicKey), '  Hello   there,\n preview  ', '3333333333', { api: sender.api, now: 1700000000000 });
  const opened = await openPreview(sealed, { privateKey: recipient.privateKey, publicKey: recipient.publicKey }, '3333333333', phone.api);
  if (!opened) throw new Error('preview did not open');
  return {
    info: PREVIEW_INFO,
    recipient: phone.generated[0],
    sender: { generated: sender.generated, randoms: sender.randoms },
    text: '  Hello   there,\n preview  ', previewText: previewText('  Hello   there,\n preview  '), longText: long, longPreview: previewText(long),
    senderId: '3333333333', now: 1700000000000, sealed, opened,
  };
}

async function deviceListVector(ratchet) {
  const owner = party();
  const accountKey = await createAccountKey(owner.api);
  const devices = [
    { deviceId: 'dev-b', identity: ratchet.bundle.identity },
    { deviceId: 'dev-a', identity: ratchet.preKeyHeader.ik },
  ];
  const signed = await signDeviceList(accountKey, { userId: '2222222222', counter: 3, devices, at: 1700000000123 }, owner.api);
  await verifyDeviceList(signed, '2222222222', owner.api);
  const shared = Uint8Array.from({ length: 32 }, (_, index) => index * 7 % 256);
  const mac = await linkClaimMac(shared.slice(), { userId: '2222222222', deviceId: 'dev-a', identity: ratchet.preKeyHeader.ik }, owner.api);
  return {
    context: DEVICE_LIST_CONTEXT, linkClaimContext: LINK_CLAIM_CONTEXT,
    accountKey: owner.generated[0], userId: '2222222222', counter: 3, at: 1700000000123, devices,
    list: signed.list, signature: signed.signature,
    linkClaim: { shared: hex(shared), userId: '2222222222', deviceId: 'dev-a', identity: ratchet.preKeyHeader.ik, mac },
  };
}

async function safetyNumberVector(ratchet) {
  const protocol = createProtocol({ storage: { get: async () => undefined, set: async () => {}, del: async () => {} } });
  const mine = [ratchet.preKeyHeader.ik];
  const theirs = [ratchet.bundle.identity, ratchet.preKeyHeader.ik];
  return { mine, theirs, expected: await protocol.safetyNumber(mine, theirs), reversed: await protocol.safetyNumber(theirs, mine) };
}

function envelopeVectors(ratchet) {
  const contents = ['hello', 'media:abc123:photo', 'viewonce:emedia:xyz_9:1', 'voice:v1:12.5:once', 'vnote:media:n1', 'poll:{"options":["a","b"]}', 'location:1,2', 'reaction:👍', 'call:ended'];
  const sd = 'dev-a';
  const entry = { p: ratchet.preKeyHeader, h: ratchet.steps[0].header, c: ratchet.steps[0].ciphertext };
  const built = buildEnvelope('text', { sd, d: { '2222222222': { 'dev-b': entry } } });
  const parsed = parseEnvelope(built);
  return { routing: contents.map((content) => [content, routingFor(content)]), built, parsed: { routing: parsed.routing, route: parsed.route, sd: parsed.body.sd } };
}

const ratchet = await ratchetTranscript();
const vectors = {
  generatedAt: new Date().toISOString(),
  kdfInfo: KDF_INFO,
  ratchet,
  senderKeys: await senderKeyTranscript(),
  preview: await previewVector(),
  deviceList: await deviceListVector(ratchet),
  safetyNumber: await safetyNumberVector(ratchet),
  envelope: envelopeVectors(ratchet),
};
const out = fileURLToPath(new URL('../android/app/src/test/resources/e2e-vectors.json', import.meta.url));
writeFileSync(out, JSON.stringify(vectors, null, 1) + '\n');
console.log(`wrote ${out}: ${ratchet.steps.length} ratchet steps, ${vectors.senderKeys.messages.length} group messages`);

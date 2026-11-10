// Group messages: Sender Keys, the scheme Signal and WhatsApp use for groups. Each sending device has, per group,
// a chain key (an HMAC hash ratchet) and a signing key. It hands both to every member device once, through the
// pairwise Double Ratchet sessions (a "distribution"), then encrypts each group message once for everyone.
// Membership changes (anyone joins, leaves, or adds a device) make the sender start a new sender key, so a removed
// member cannot read what follows and a new one cannot read what came before.
//
// Pure functions: states are never modified, new ones are returned (committed only after success).
import { aeadDecrypt, aeadEncrypt, checkPublicKey, concat, fromBase64, generateSigningPair, hmac, hmacKey, messageCipher, randomBytes, sign, toBase64, utf8, verify } from './primitives.js';

export const MAX_GROUP_SKIP = 2000;
const MESSAGE_INFO = 'HiddenMessenger SenderKey message v1';

const groupAd = (groupId, senderAddress, keyId, n) => utf8(JSON.stringify(['hm-sk-v1', groupId, senderAddress, keyId, n]));

async function step(chainKey, api) {
  const [messageKey, next] = await Promise.all([hmac(chainKey, new Uint8Array([1]), api), hmac(chainKey, new Uint8Array([2]), api)]);
  return [await hmacKey(next, api), messageKey];
}

/**
 * A new sender key for this device in `groupId`, bound to the group's current device set (`membersHash`).
 * Resolves { state, distribution }: the distribution is what every member device receives (pairwise encrypted).
 */
export async function createSenderKey(groupId, membersHash, api) {
  const keyId = toBase64(randomBytes(12, api));
  const chainBytes = randomBytes(32, api);
  const distribution = { type: 'skdm', g: groupId, kid: keyId, ck: toBase64(chainBytes) };
  const signing = await generateSigningPair(api);
  distribution.sp = toBase64(signing.publicKey);
  const state = { groupId, keyId, membersHash, n: 0, chain: await hmacKey(chainBytes, api), signing, createdAt: Date.now() };
  return { state, distribution };
}

/** Encrypts one group message: resolves { state, message: { kid, n, c, s } }. */
export async function senderKeyEncrypt(current, senderAddress, plaintext, api) {
  const [chain, messageKey] = await step(current.chain, api);
  const n = current.n;
  const ad = groupAd(current.groupId, senderAddress, current.keyId, n);
  const ciphertext = await aeadEncrypt(await messageCipher(messageKey, MESSAGE_INFO, api), plaintext, ad, api);
  const signature = await sign(current.signing.privateKey, concat(ad, ciphertext), api);
  return {
    state: { ...current, chain, n: n + 1 },
    message: { kid: current.keyId, n, c: toBase64(ciphertext), s: toBase64(signature) },
  };
}

/** A received distribution → the receiving state for that sender key (iteration 0). */
export async function acceptDistribution(distribution, expectedGroupId, api) {
  if (distribution?.type !== 'skdm' || distribution.g !== expectedGroupId || typeof distribution.kid !== 'string') throw new Error('Invalid sender key distribution.');
  const chainBytes = fromBase64(distribution.ck);
  if (chainBytes.length !== 32) throw new Error('Invalid sender key distribution.');
  return {
    groupId: expectedGroupId,
    keyId: distribution.kid,
    signingPublic: checkPublicKey(fromBase64(distribution.sp)),
    n: 0,
    chain: await hmacKey(chainBytes, api),
    skipped: {},
  };
}

/** Decrypts with a receiving state: resolves { state, plaintext }; rejects with the state untouched. */
export async function senderKeyDecrypt(current, senderAddress, message, api) {
  if (!message || message.kid !== current.keyId || !Number.isInteger(message.n) || message.n < 0) throw new Error('Invalid group message.');
  const ciphertext = fromBase64(message.c);
  const ad = groupAd(current.groupId, senderAddress, current.keyId, message.n);
  if (!(await verify(current.signingPublic, fromBase64(message.s), concat(ad, ciphertext), api))) throw new Error('Group message signature is invalid.');
  const state = { ...current, skipped: { ...current.skipped } };
  const stored = state.skipped[message.n];
  if (stored) {
    delete state.skipped[message.n];
    return { state, plaintext: await aeadDecrypt(stored, ciphertext, ad, api) };
  }
  if (message.n < state.n) throw new Error('This group message was already read.');
  if (message.n - state.n > MAX_GROUP_SKIP) throw new Error('Too many skipped group messages.');
  while (state.n < message.n) {
    const [chain, messageKey] = await step(state.chain, api);
    state.chain = chain;
    state.skipped[state.n] = await messageCipher(messageKey, MESSAGE_INFO, api);
    state.n += 1;
  }
  const ids = Object.keys(state.skipped);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_GROUP_SKIP))) delete state.skipped[id];
  const [chain, messageKey] = await step(state.chain, api);
  state.chain = chain;
  state.n += 1;
  return { state, plaintext: await aeadDecrypt(await messageCipher(messageKey, MESSAGE_INFO, api), ciphertext, ad, api) };
}

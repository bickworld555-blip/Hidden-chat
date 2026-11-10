// X3DH key agreement and the Double Ratchet, following Signal's published specifications
// (signal.org/docs/specifications/x3dh and /doubleratchet), on P-256 (see primitives.js).
//
// Every function here is pure with respect to its inputs: state objects are never modified, a new state is
// returned. Callers commit the new state only after a message decrypted successfully, so a forged or corrupted
// message cannot damage a session (the specification's "transactional" requirement).
import {
  aeadDecrypt, aeadEncrypt, checkPublicKey, concat, dh, equalBytes, fromBase64, generateDhPair, hkdf, hkdfWithKeySalt,
  hmac, hmacKey, messageCipher, sign, toBase64, utf8, verify,
} from './primitives.js';

export const MAX_SKIP = 1000;
export const MAX_STORED_SKIPPED = 2000;
const X3DH_INFO = 'HiddenMessenger X3DH P-256 v1';
const ROOT_INFO = 'HiddenMessenger DoubleRatchet root v1';
const MESSAGE_INFO = 'HiddenMessenger DoubleRatchet message v1';
const SPK_CONTEXT = utf8('HiddenMessenger signed prekey v1');

// --- Identities and prekeys ------------------------------------------------------------------------

/** The public half of an identity as published: { dh, sig } base64. */
export function publicIdentity(identity) {
  return { dh: toBase64(identity.dh.publicKey), sig: toBase64(identity.sig.publicKey) };
}

/** Parses a published identity into bytes (throws when malformed). */
export function parseIdentity(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid identity.');
  return { dh: checkPublicKey(fromBase64(value.dh)), sig: checkPublicKey(fromBase64(value.sig)) };
}

export const identityBytes = (identity) => concat(identity.dh, identity.sig);

export async function signPreKey(identity, publicKey, api) {
  return sign(identity.sig.privateKey, concat(SPK_CONTEXT, publicKey), api);
}

export async function verifyPreKey(identitySig, publicKey, signature, api) {
  return verify(identitySig, signature, concat(SPK_CONTEXT, publicKey), api);
}

// --- X3DH ----------------------------------------------------------------------------------------

async function deriveSharedSecret(parts, api) {
  const secret = await hkdf(concat(new Uint8Array(32).fill(0xff), ...parts), new Uint8Array(32), X3DH_INFO, 32, api);
  for (const part of parts) part.fill(0);
  return secret;
}

/**
 * Initiator side. `bundle` is the responder's published { identity, signedPreKey: { id, key, signature },
 * preKey?: { id, key } }. Resolves { secret, ad, remoteIdentity, remoteSignedPreKey, preKeyHeader }.
 */
export async function x3dhInitiate(identity, bundle, api) {
  const remoteIdentity = parseIdentity(bundle?.identity);
  const spk = checkPublicKey(fromBase64(bundle?.signedPreKey?.key ?? ''));
  const spkSignature = fromBase64(bundle?.signedPreKey?.signature ?? '');
  if (!(await verifyPreKey(remoteIdentity.sig, spk, spkSignature, api))) throw new Error('The contact’s signed prekey has an invalid signature.');
  const opk = bundle.preKey ? checkPublicKey(fromBase64(bundle.preKey.key)) : null;
  const ephemeral = await generateDhPair(api);
  const parts = [
    await dh(identity.dh.privateKey, spk, api),
    await dh(ephemeral.privateKey, remoteIdentity.dh, api),
    await dh(ephemeral.privateKey, spk, api),
  ];
  if (opk) parts.push(await dh(ephemeral.privateKey, opk, api));
  const secret = await deriveSharedSecret(parts, api);
  return {
    secret,
    ad: concat(identityBytes({ dh: identity.dh.publicKey, sig: identity.sig.publicKey }), identityBytes(remoteIdentity)),
    remoteIdentity,
    remoteSignedPreKey: spk,
    preKeyHeader: {
      ik: publicIdentity(identity),
      ek: toBase64(ephemeral.publicKey),
      spk: bundle.signedPreKey.id,
      ...(opk ? { opk: bundle.preKey.id } : {}),
    },
  };
}

/** Responder side, from the initiator's prekey header and this device's prekey pairs. */
export async function x3dhRespond(identity, header, signedPreKeyPair, preKeyPair, api) {
  const remoteIdentity = parseIdentity(header?.ik);
  const ephemeral = checkPublicKey(fromBase64(header?.ek ?? ''));
  const parts = [
    await dh(signedPreKeyPair.privateKey, remoteIdentity.dh, api),
    await dh(identity.dh.privateKey, ephemeral, api),
    await dh(signedPreKeyPair.privateKey, ephemeral, api),
  ];
  if (preKeyPair) parts.push(await dh(preKeyPair.privateKey, ephemeral, api));
  const secret = await deriveSharedSecret(parts, api);
  return {
    secret,
    ad: concat(identityBytes(remoteIdentity), identityBytes({ dh: identity.dh.publicKey, sig: identity.sig.publicKey })),
    remoteIdentity,
  };
}

// --- Double Ratchet ----------------------------------------------------------------------------------

async function kdfRoot(rootKey, dhOutput, api) {
  const okm = await hkdfWithKeySalt(rootKey, dhOutput, ROOT_INFO, 64, api);
  dhOutput.fill(0);
  const [nextRoot, chain] = await Promise.all([hmacKey(okm.slice(0, 32), api), hmacKey(okm.slice(32, 64), api)]);
  okm.fill(0);
  return [nextRoot, chain];
}

async function kdfChain(chainKey, api) {
  const [messageKey, nextChain] = await Promise.all([hmac(chainKey, new Uint8Array([1]), api), hmac(chainKey, new Uint8Array([2]), api)]);
  return [await hmacKey(nextChain, api), messageKey];
}

const headerBytes = (header) => utf8(JSON.stringify([header.dh, header.pn, header.n]));
const skippedId = (dhBase64, n) => `${dhBase64}|${n}`;
const copyState = (state) => ({ ...state, skipped: { ...state.skipped } });

/** Initiator's first state, after X3DH: it can send at once. */
export async function initInitiator(secret, remoteSignedPreKey, ad, api) {
  const rootKey = await hmacKey(secret, api);
  const dhs = await generateDhPair(api);
  const [rk, cks] = await kdfRoot(rootKey, await dh(dhs.privateKey, remoteSignedPreKey, api), api);
  return { rk, dhs, dhr: remoteSignedPreKey, cks, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad };
}

/** Responder's first state: it can send only after the first incoming message turns the ratchet. */
export async function initResponder(secret, signedPreKeyPair, ad, api) {
  return { rk: await hmacKey(secret, api), dhs: signedPreKeyPair, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad };
}

/** Encrypts one message: resolves { state, header: { dh, pn, n }, ciphertext (base64) }. */
export async function ratchetEncrypt(current, plaintext, api) {
  if (!current.cks) throw new Error('This session cannot send yet.');
  const state = copyState(current);
  const [cks, messageKey] = await kdfChain(state.cks, api);
  const header = { dh: toBase64(state.dhs.publicKey), pn: state.pn, n: state.ns };
  state.cks = cks;
  state.ns += 1;
  const cipher = await messageCipher(messageKey, MESSAGE_INFO, api);
  const ciphertext = await aeadEncrypt(cipher, plaintext, concat(state.ad, headerBytes(header)), api);
  return { state, header, ciphertext: toBase64(ciphertext) };
}

async function skipMessageKeys(state, until, api) {
  if (!state.ckr) return;
  if (until - state.nr > MAX_SKIP) throw new Error('Too many skipped messages.');
  const dhBase64 = toBase64(state.dhr);
  while (state.nr < until) {
    const [ckr, messageKey] = await kdfChain(state.ckr, api);
    state.ckr = ckr;
    state.skipped[skippedId(dhBase64, state.nr)] = await messageCipher(messageKey, MESSAGE_INFO, api);
    state.nr += 1;
  }
  const ids = Object.keys(state.skipped);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_STORED_SKIPPED))) delete state.skipped[id];
}

function parseHeader(header) {
  if (!header || typeof header.dh !== 'string' || !Number.isInteger(header.pn) || !Number.isInteger(header.n) || header.pn < 0 || header.n < 0) {
    throw new Error('Invalid message header.');
  }
  return checkPublicKey(fromBase64(header.dh));
}

/** Decrypts one message: resolves { state, plaintext: Uint8Array }; rejects (state untouched) when it fails. */
export async function ratchetDecrypt(current, header, ciphertextBase64, api) {
  const remoteDh = parseHeader(header);
  const ciphertext = fromBase64(ciphertextBase64);
  const ad = concat(current.ad, headerBytes(header));
  const state = copyState(current);
  const skipped = state.skipped[skippedId(header.dh, header.n)];
  if (skipped) {
    delete state.skipped[skippedId(header.dh, header.n)];
    return { state, plaintext: await aeadDecrypt(skipped, ciphertext, ad, api) };
  }
  if (!state.dhr || !equalBytes(remoteDh, state.dhr)) {
    await skipMessageKeys(state, header.pn, api);
    state.pn = state.ns;
    state.ns = 0;
    state.nr = 0;
    state.dhr = remoteDh;
    [state.rk, state.ckr] = await kdfRoot(state.rk, await dh(state.dhs.privateKey, state.dhr, api), api);
    state.dhs = await generateDhPair(api);
    [state.rk, state.cks] = await kdfRoot(state.rk, await dh(state.dhs.privateKey, state.dhr, api), api);
  }
  await skipMessageKeys(state, header.n, api);
  const [ckr, messageKey] = await kdfChain(state.ckr, api);
  state.ckr = ckr;
  state.nr += 1;
  const plaintext = await aeadDecrypt(await messageCipher(messageKey, MESSAGE_INFO, api), ciphertext, ad, api);
  return { state, plaintext };
}

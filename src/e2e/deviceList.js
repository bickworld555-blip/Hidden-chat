// Signed device lists (docs/security/ENCRYPTION-AUDIT.md §3.11): an account key (ECDSA P-256, created on one of the
// account's devices and never leaving it) signs the list of the account's device identities. Contacts pin the
// account key on first sight and encrypt only to devices the signed list names, so the server cannot add a device to
// someone's account unseen. A new account key (a fresh sign-in on a new phone) is shown as "security code changed".
//
// One owner of the format, used by the app (sign, verify, pin, filter) and by the server (check before storing).
import { checkPublicKey, concat, fromBase64, generateSigningPair, sign, toBase64, utf8, verify } from './primitives.js';

export const DEVICE_LIST_CONTEXT = 'HiddenMessenger device list v1';
export const MAX_LISTED_DEVICES = 64;
const KEY = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The list as signed: fixed key order, devices sorted by id, so one list has one encoding. */
export function canonicalDeviceList({ u, ak, n, at, d }) {
  const devices = [...d].map((device) => ({ id: device.id, dh: device.dh, sig: device.sig })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ v: 1, u, ak, n, at, d: devices });
}

/** A new account key: { privateKey (non-extractable), publicKey (base64) }. */
export async function createAccountKey(api) {
  const pair = await generateSigningPair(api);
  return { privateKey: pair.privateKey, publicKey: toBase64(pair.publicKey) };
}

/** Signs a list: resolves { list (canonical JSON), signature (base64) }. */
export async function signDeviceList(accountKey, { userId, counter, devices, at = Date.now() }, api) {
  const list = canonicalDeviceList({ u: userId, ak: accountKey.publicKey, n: counter, at, d: devices.map((device) => ({ id: device.deviceId ?? device.id, dh: device.identity?.dh ?? device.dh, sig: device.identity?.sig ?? device.sig })) });
  return { list, signature: toBase64(await sign(accountKey.privateKey, concat(utf8(DEVICE_LIST_CONTEXT), utf8(list)), api)) };
}

/**
 * Parses and verifies a signed list for `userId`. Resolves { userId, accountKey, counter, at, devices: Map(id → {dh, sig}) }
 * or rejects: a list that is malformed, not canonical, for another account, or not signed by the key it names.
 */
export async function verifyDeviceList(signed, userId, api) {
  if (!signed || typeof signed.list !== 'string' || typeof signed.signature !== 'string' || signed.list.length > 32_768) throw new Error('Invalid device list.');
  let value;
  try { value = JSON.parse(signed.list); } catch { throw new Error('Invalid device list.'); }
  if (!value || value.v !== 1 || value.u !== userId || !KEY.test(value.ak ?? '') || !Number.isSafeInteger(value.n) || value.n < 1
    || !Number.isSafeInteger(value.at) || !Array.isArray(value.d) || value.d.length < 1 || value.d.length > MAX_LISTED_DEVICES) throw new Error('Invalid device list.');
  if (!value.d.every((device) => device && DEVICE_ID.test(device.id ?? '') && KEY.test(device.dh ?? '') && KEY.test(device.sig ?? ''))) throw new Error('Invalid device list.');
  if (canonicalDeviceList(value) !== signed.list) throw new Error('Invalid device list.');
  const ids = new Set(value.d.map((device) => device.id));
  if (ids.size !== value.d.length) throw new Error('Invalid device list.');
  const ok = await verify(checkPublicKey(fromBase64(value.ak)), fromBase64(signed.signature), concat(utf8(DEVICE_LIST_CONTEXT), utf8(signed.list)), api);
  if (!ok) throw new Error('The device list signature is invalid.');
  return { userId, accountKey: value.ak, counter: value.n, at: value.at, devices: new Map(value.d.map((device) => [device.id, { dh: device.dh, sig: device.sig }])) };
}

/** The devices (as the server lists them: { deviceId, identity }) that the verified list names with the same identity. */
export function listedDevices(devices, verified) {
  return (devices ?? []).filter((device) => {
    const entry = verified.devices.get(device.deviceId);
    return Boolean(entry && entry.dh === device.identity?.dh && entry.sig === device.identity?.sig);
  });
}

/**
 * What a contact's app does with a verified list given its pin ({ accountKey, counter } or null):
 *   'pin'      first sight: pin it;
 *   'same'     the pinned key, same or newer list: accept (and move the pin forward);
 *   'rollback' the pinned key with an older counter: refuse (an old list replayed by the server);
 *   'changed'  another account key: accept, pin the new one, and tell the person the security code changed.
 */
export function pinDecision(pin, verified) {
  if (!pin) return 'pin';
  if (pin.accountKey !== verified.accountKey) return 'changed';
  return verified.counter < pin.counter ? 'rollback' : 'same';
}

// --- Link claims: a device linked by QR proves its keys to the phone that linked it ------------------------------
// The phone took the new device's link key from the scanned QR (or from the security code the person confirmed), so
// it trusts that key. The new device MACs its identity with a key from ECDH(its link key, the phone's identity key);
// only that phone can recompute it. The server relays the claim and cannot forge one.
export const LINK_CLAIM_CONTEXT = 'HiddenMessenger link claim v1';
const claimText = (userId, deviceId, identity) => utf8(JSON.stringify([LINK_CLAIM_CONTEXT, userId, deviceId, identity.dh, identity.sig]));

/** base64 HMAC-SHA-256 over the claim, keyed by HKDF(shared ECDH secret). Wipes the shared secret. */
export async function linkClaimMac(shared, { userId, deviceId, identity }, api) {
  const subtle = (api ?? globalThis.crypto).subtle;
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  shared.fill(0);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(LINK_CLAIM_CONTEXT) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return toBase64(new Uint8Array(await subtle.sign('HMAC', key, claimText(userId, deviceId, identity))));
}

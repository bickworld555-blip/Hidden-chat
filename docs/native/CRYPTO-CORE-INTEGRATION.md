# Implementing the native encryption core (`CryptoCore`)

This is the drop-in guide for whoever implements the Kotlin end-to-end encryption core — a vetted crypto library
binding or an engineer. The scaffold around it already exists and is committed (Phase 1, `8b93f55`):

- the interface to implement: [`CryptoCore`](../../android/app/src/main/java/io/github/bickworld555/hiddenchat/core/crypto/CryptoCore.kt);
- the record store it persists to: [`NativeStore`](../../android/app/src/main/java/io/github/bickworld555/hiddenchat/core/store/NativeStore.kt) (a `KeyRecords`);
- JSON that is byte-identical to JavaScript: [`Json`](../../android/app/src/main/java/io/github/bickworld555/hiddenchat/core/Json.kt);
- the fixed protocol strings: [`ProtocolConstants`](../../android/app/src/main/java/io/github/bickworld555/hiddenchat/core/crypto/ProtocolConstants.kt);
- the conformance transcript and its test: [`e2e-vectors.json`](../../android/app/src/test/resources/e2e-vectors.json), [`E2eVectorsTest`](../../android/app/src/test/java/io/github/bickworld555/hiddenchat/core/crypto/E2eVectorsTest.kt).

**The hard rule.** Other phones, the desktop app and the website keep running the web implementation in
[`src/e2e/`](../../src/e2e/). A native core is correct only if it is **byte-for-byte interoperable** with that code:
the same ciphertexts, headers, signatures, safety numbers and wire JSON. The web code in `src/e2e/` is the
specification; this document maps it to the Kotlin interface. Do not change any KDF string, associated-data layout,
JSON key order or base64 form — each is part of the wire format and breaks every existing device.

## Curve and primitives

NIST **P-256** for ECDH and ECDSA (not X25519 — older Android WebViews lacked it). Signatures travel as **r‖s, 64
bytes** (the Web Crypto form); convert the JVM provider's DER at the edge. Public keys travel as the **65-byte
uncompressed point** (`0x04 ‖ x ‖ y`) and must be validated on-curve before use. Source: [`src/e2e/primitives.js`](../../src/e2e/primitives.js).

| Primitive | Definition (must match exactly) |
|---|---|
| `dh(priv, pub)` | ECDH → 32 bytes (the raw x-coordinate, as Web Crypto `deriveBits` returns). |
| `hkdf(ikm, salt, info, len)` | HKDF-SHA-256 (RFC 5869). An **empty salt is 32 zero bytes**. `info` is UTF-8. |
| `hkdfWithKeySalt(saltKey, ikm, info, len)` | Extract = `HMAC-SHA256(saltKey, ikm)`, then RFC 5869 expand. Used by the root KDF. |
| `messageCipher(mk, info)` | `okm = HKDF(mk, salt=0×32, info, 44)`; AES-256-GCM key = `okm[0:32]`, nonce = `okm[32:44]`. Wipes `mk`. |
| `aeadEncrypt/Decrypt({key,iv}, data, ad)` | AES-256-GCM, 128-bit tag, with associated data `ad`. |
| base64 | **canonical padded** base64 (`A-Za-z0-9+/`, `=` padding); reject non-canonical. |

Verified by the published-standard vectors already in [`server/e2e-vectors.test.mjs`](../../server/e2e-vectors.test.mjs)
(RFC 5869, RFC 5903 §8.1 P-256 ECDH, RFC 6979 A.2.5 ECDSA) — reuse those to check your primitives first.

## KDF / context strings (`ProtocolConstants`)

```
X3DH         = "HiddenMessenger X3DH P-256 v1"
ROOT         = "HiddenMessenger DoubleRatchet root v1"
MESSAGE      = "HiddenMessenger DoubleRatchet message v1"
SIGNED_PREKEY= "HiddenMessenger signed prekey v1"
SenderKey    = "HiddenMessenger SenderKey message v1"
preview      = "hm-preview-v1",  preview-key statement prefix "hm-preview-key-v1|"
device list  = "HiddenMessenger device list v1"
link claim   = "HiddenMessenger link claim v1"
```

## X3DH and the Double Ratchet

Source: [`src/e2e/ratchet.js`](../../src/e2e/ratchet.js). Signal's X3DH and Double Ratchet on P-256.

- **X3DH shared secret**: `SK = HKDF(ikm = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4], salt = 0×32, info = X3DH, 32)`.
  DH1..DH4 exactly as the spec (initiator: IK↔SPK, EK↔IK, EK↔SPK, EK↔OPK). The leading `0xFF×32` is required.
- **Associated data** `ad = IK_initiator(dh‖sig, 65+65) ‖ IK_responder(dh‖sig)` — initiator's identity first, both as
  the 65-byte points, on both sides.
- **Root KDF**: `HKDF(salt = root key, ikm = DH, info = ROOT, 64)` → `[next root (32), chain (32)]`.
- **Chain KDF**: message key = `HMAC(chain, 0x01)`, next chain = `HMAC(chain, 0x02)`.
- **Message header** `{ dh, pn, n }`; its bytes for the AEAD are `JSON.stringify([dh, pn, n])` (use `Json.stringify`).
  AEAD associated data = `ratchet.ad ‖ headerBytes`.
- **Skipped keys**: up to `MAX_SKIP = 1000` per step, store up to `MAX_STORED_SKIPPED = 2000`, keyed `"<dhBase64>|<n>"`.
- **Transactional**: never mutate a state in place; return a new one and let the caller commit only after success.

Pinned by `e2e-vectors.json → ratchet`: a 12-step transcript (Alice m1–m3; Bob opens m1, m3, m2 [skipped key]; Bob
replies r1, r2 [DH turn]; Alice opens r1, r2; Alice m4 [DH turn]; Bob opens m4). Each `step` records `header` and
`ciphertext`; fed the recorded `generated` keys and `randoms` per party, your core must reproduce them exactly.

## Sender Keys (groups)

Source: [`src/e2e/senderKeys.js`](../../src/e2e/senderKeys.js). Per sending device per group: a chain key (HMAC
ratchet, same `0x01`/`0x02` step) and an ECDSA signing key. Message `{ kid, n, c, s }`; `s` signs `ad ‖ ciphertext`
where `ad = JSON.stringify(["hm-sk-v1", groupId, senderAddress, keyId, n])`. Distribution `{ type:"skdm", g, kid,
ck, sp }`. `MAX_GROUP_SKIP = 2000`. Pinned by `e2e-vectors.json → senderKeys`.

## The interface, method by method

`CryptoCore` operates at the level of [`src/e2e/protocol.js`](../../src/e2e/protocol.js) `createProtocol`. Values cross
as parsed JSON (`Json`), in the wire shapes of [`src/e2e/envelope.js`](../../src/e2e/envelope.js). Persist via
`KeyRecords` using the **same record keys** the web `storage` uses, so the formats line up:
`identity`, `meta`, `spk:<id>`, `opk:<id>`, `known:<user>/<device>`, `session:<user>/<device>`, `sk-own:<group>`,
`sk-in:<group>:<user>/<device>`, `list-join-pending`.

| `CryptoCore` method | `src/e2e` source | Notes / wire shape |
|---|---|---|
| `prepareUpload(serverPreKeyCount, now)` | `protocol.js` `prepareUpload` | Returns `{ identity:{dh,sig}, signedPreKey:{id,key,signature}, preKeys:[{id,key}] }`. Rotate the signed prekey weekly (`SIGNED_PREKEY_ROTATION_MS`), keep the last few; refill one-time prekeys to `PREKEY_BATCH=100` when the server holds `< PREKEY_LOW_WATER=25`. |
| `publicIdentity()` | `protocol.js` `publicIdentity` | `{ dh, sig }` base64. |
| `encryptForDevices(devices, plaintext, claimBundles)` | `protocol.js` `encryptForDevices`/`encryptCore` | `devices = { userId: [ {deviceId, identity?} ] }`. For devices with no session, `claimBundles(userId, deviceIds)` returns `[{deviceId, identity, signedPreKey, preKey?}]`; run X3DH, pin identity trust-on-first-use (remember only after success). Returns `{ userId: { deviceId: { p?, h, c } } }` — `p` = X3DH prekey header until the peer replies. **Pinned by `directInterface`.** |
| `decryptFromDevice(userId, deviceId, entry)` | `protocol.js` `decryptFromDevice`/`respondTo` | `entry = { p?, h, c }`. With `p`, respond via the stored signed/one-time prekey (consume the OPK). Try current then previous sessions; commit only on success. **Pinned by `directInterface`.** |
| `forgetSession(userId, deviceId)` | `protocol.js` `forgetSession` | Move current session to `previous`; next message starts fresh X3DH. |
| `encryptGroup(groupId, me…, memberDevices, plaintext, claimBundles)` | `protocol.js` `encryptGroup` | New sender key when the member set hash changes; attach distribution (`x`, pairwise-sealed) until confirmed. Returns `{ body:{mh,g,x?}, keyId }`. |
| `confirmGroupSend` / `resetGroup` / `decryptGroup` | `protocol.js` same names | Group receive stores `sk-in:*`; `decryptGroup` accepts the distribution then `senderKeyDecrypt`. |
| `safetyNumber(mine, theirs)` | `protocol.js` `safetyNumber` | 60 digits, 12 groups of 5. `flatten(list)=sort("dh.sig")`, `[a,b]=sort([flatten(mine),flatten(theirs)])`, SHA-256 **1024×** over `"a|b"`, then 12 groups from fixed byte offsets. **Pinned by `safetyNumber`.** |
| `signPreviewKey(previewKeyBase64)` | `protocol.js` `signPreviewKey`, `preview.js` | ECDSA over `"hm-preview-key-v1|" ‖ previewKeyBytes`. **Pinned by `preview`.** |
| `identityAgreement(pub)` | `protocol.js` `identityAgreement` | ECDH of this device's identity DH key with `pub` (a linked device's link key). |
| `wipe()` | sign-out | `NativeStore.wipe()` clears every record. |

Signed device lists and link claims ([`src/e2e/deviceList.js`](../../src/e2e/deviceList.js)) are pinned by
`e2e-vectors.json → deviceList`; notification previews ([`src/e2e/preview.js`](../../src/e2e/preview.js)) by `preview`.
The envelope framing (`e2e2:<routing>|<json>`) is pinned by `envelope`.

## Errors

Throw `ProtocolError(code, message)` with the codes the app already handles
([`src/e2e/client.js`](../../src/e2e/client.js) `RESET_SESSION_ERRORS` and the messaging layer):
`no-bundle`, `no-session`, `decrypt-failed`, `stale-prekey`, `identity-mismatch`, `no-sender-key`, `not-addressed`.

## How to verify as you build

1. Regenerate the transcript if `src/e2e/` changed: `node scripts/e2e-native-vectors.mjs`.
2. Complete the replay body of `E2eVectorsTest.coreConformanceWhenInstalled`: build a `Rng` that returns the recorded
   `generated` key pairs and `randoms` in order (per party), install the core (`CryptoCores.install`), replay each
   transcript and assert every `header`, `ciphertext`, entry and plaintext **byte for byte**. It currently throws if a
   core is installed but the replay is incomplete, so it cannot silently pass.
3. Run `:app:testDebugUnitTest --tests "io.github.bickworld555.hiddenchat.core.*"` (needs free RAM; see
   [native-migration notes] in the repo for the memory-safe Gradle recipe).
4. Only once green does the core go near a phone. Then Phase 2's integration (native `relay.fetch` decrypt-on-push,
   switching `BackgroundHost`/`PushService` off the WebView `background.html`) can proceed.

## Implementation status (2026-11-22)

The X3DH / Double Ratchet / Sender Keys state machines are in `core/crypto/` (`Support.kt`, `X3dh.kt`,
`DoubleRatchet.kt`, `SenderKeys.kt`), with the author-provided `Primitives.kt`. Test status (`core.*`, 21/21):

- **1:1 messaging — conformant byte-for-byte.** `RatchetConformanceTest` replays the recorded web-protocol
  transcript (shared secret, associated data, every header and ciphertext across the 12-step X3DH + Double Ratchet
  scenario) through `ReplayRng` and they match exactly. `ProtocolTest` additionally proves self-consistency
  (out-of-order delivery, DH turn, replay/tamper rejection, persistence, skip limit).
- **Groups (Sender Keys) — conformant byte-for-byte.** `SenderKeys.kt` was aligned to `src/e2e/senderKeys.js`:
  `kid` is a `String` (base64 of 12 random bytes, drawn before the chain key), carried as that string on the wire and
  in the Sender Key AD. `RatchetConformanceTest.senderKeysMatchWebProtocolByteForByte` checks both directions: the
  distribution and each ciphertext come out identical to the recording, and the web-sealed group messages (with their
  real randomized-ECDSA signatures) open here in the recorded out-of-order sequence.

- **`CryptoCore` interface — implemented and conformant.** `HmCryptoCore` (core/crypto/HmCryptoCore.kt) implements
  the whole interface over `KeyRecords`, following `src/e2e/protocol.js`: identity/prekey management, sessions
  (current + previous), trust-on-first-use, X3DH session set-up, the `{p,h,c}` envelope entries, groups (sender keys
  with the distribution sealed over the direct sessions), `safetyNumber`, `signPreviewKey`, `identityAgreement`,
  `wipe`. `CryptoCoreConformanceTest` replays the recorded `directInterface` transcript through two cores and the
  per-device entries come out byte-for-byte; a full group round trip, the recorded safety number, and the preview
  signature all pass. `core.*` is 26/26.
  - One production note: `HmCryptoCore` nests `records.exclusive {}` (e.g. `encryptGroup` → `encryptForDevices`). The
    test `MapRecords` uses a reentrant lock, but `NativeStore.exclusive` opens a real SQLite transaction — confirm
    nested `beginTransaction()` is acceptable (Android flattens them) or make the core take the lock once at the top.

Minor cleanup (non-blocking): `Support.kt` duplicates the KDF strings (`Ctx`) and a JSON stringifier (`JsJson`) that
already exist as `ProtocolConstants` and `core/Json`. The values are proven equal by the passing conformance test;
de-duplicating later avoids drift.

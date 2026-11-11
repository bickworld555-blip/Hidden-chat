# Hidden Messenger end-to-end encryption: audit brief

This document is for an independent reviewer of Hidden Messenger's end-to-end encryption. It describes what the
code does today, where it lives, how to test it, and where it knowingly differs from the Signal designs it
follows. Line references are to the `chat-app/` tree at the commit the reviewer receives.

Hidden Messenger implements its own X3DH key agreement, Double Ratchet and Sender Keys on the Web Crypto API.
No third-party Signal library is used. The protocol code has not been audited before.

## 1. Scope

In scope (about 1,500 lines of JavaScript):

| Area | Files |
|---|---|
| Primitives (P-256 ECDH/ECDSA, HKDF, HMAC, AES-256-GCM) | `src/e2e/primitives.js` |
| X3DH and Double Ratchet | `src/e2e/ratchet.js` |
| Sender Keys (groups) | `src/e2e/senderKeys.js` |
| Per-device state, prekeys, sessions, safety numbers | `src/e2e/protocol.js` |
| Envelope format and server routing | `src/e2e/envelope.js` |
| Client glue: key directory, sealing, opening, plaintext memory | `src/e2e/client.js`, `src/e2e/messaging.js` |
| Encrypted polls, notices | `src/e2e/polls.js`, `src/e2e/notices.js` |
| Media encryption (chunked AES-GCM) | `src/mediaCrypto.js` |
| Encrypted chat backups (PBKDF2) | `src/backup.js` |
| Linked-device history transfer | `src/linking.js`, `server/linking.mjs` |
| Large group calls (LiveKit E2EE key distribution) | `src/groupRelayCall.js`, `src/components/call/GroupRelayCall.jsx` |
| Server-side key directory and fan-out checks | `server/e2e.mjs` |
| Strict mode (no readable fallback) | `src/e2e/client.js` (`PeerKeysMissing`, `GroupKeysMissing`), `src/e2e/messaging.js`, `src/groupPending.js` |

Out of scope unless agreed: WebRTC media for one-to-one calls (standard DTLS-SRTP), the LiveKit SFU itself,
Android OS storage, Firebase Cloud Messaging transport, and the web server's account authentication.

## 2. Threat model

- **The server is untrusted for content.** It stores and routes ciphertext and must not be able to read
  messages, media, statuses, polls, reactions, group call media or linked-device history.
- **The server is trusted for availability and routing metadata.** It sees who talks to whom, when, message
  sizes, device lists and group membership. It also distributes public keys. Users can detect a substituted key
  by comparing security codes; there is no key transparency log.
- **Devices are trusted while unlocked.** Private keys are non-extractable `CryptoKey`s in IndexedDB (browser)
  or the Android WebView's IndexedDB. An optional app lock gates the UI, not the storage.
- **Network attackers** see TLS-protected traffic only.

## 3. Protocol summary

### 3.1 Identities and prekeys (`ratchet.js`, `protocol.js`)

- Curve: NIST P-256. Web Crypto in all target WebViews lacks X25519.
- Each device has two identity keys: an ECDH key (`dh`) and a separate ECDSA P-256/SHA-256 signing key (`sig`).
  Signal uses one XEdDSA key; we use two because Web Crypto has no XEdDSA.
- Signed prekey: ECDH key signed by `sig` over `"HiddenMessenger signed prekey v1" ‖ publicKey`. Rotated weekly
  (`SIGNED_PREKEY_ROTATION_MS`); the last 3 are kept for in-flight messages.
- One-time prekeys: batches of 100 (`PREKEY_BATCH`), refilled below 25 (`PREKEY_LOW_WATER`). Each is used once;
  a second session from the same prekey header is refused (`stale-prekey`).

### 3.2 X3DH (`ratchet.js` `x3dhInitiate` / `x3dhRespond`)

- DH1 = DH(IK_A, SPK_B), DH2 = DH(EK_A, IK_B), DH3 = DH(EK_A, SPK_B), DH4 = DH(EK_A, OPK_B) when present.
- SK = HKDF-SHA-256(IKM = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4], salt = 0×32, info = `"HiddenMessenger X3DH P-256 v1"`, 32 bytes).
- DH outputs are wiped after use.
- AD = identityBytes(A) ‖ identityBytes(B), where identityBytes covers both the `dh` and `sig` public keys.
- The signed prekey signature is verified before any DH; an invalid signature aborts.

### 3.3 Double Ratchet (`ratchet.js`)

- Root KDF: HKDF with the root key as an HMAC salt (`hkdfWithKeySalt`), info `"HiddenMessenger DoubleRatchet root v1"`, 64 bytes → new root key ‖ chain key.
- Chain KDF: HMAC-SHA-256(chain key, 0x01) = message key, HMAC(chain key, 0x02) = next chain key.
- Message encryption: HKDF(message key, info `"HiddenMessenger DoubleRatchet message v1"`, 44 bytes) → AES-256-GCM key (32) + nonce (12). Message keys are wiped after use.
- Headers (DH ratchet key, PN, N) are authenticated as GCM additional data together with the X3DH AD. **Headers are not encrypted.**
- Skipped message keys: at most `MAX_SKIP` = 1000 per chain, `MAX_STORED_SKIPPED` = 2000 stored.
- Transactional: functions return new state; callers save it only after successful decryption. A forged or
  replayed message cannot damage the session (tests in §6).

### 3.4 Multi-device fan-out (`protocol.js` `encryptForDevices`, `client.js` `sealDirect`)

A direct message is encrypted once per recipient device and once per sender's other devices, each over its own
pairwise session. The server checks that the sender covered exactly the current device lists (`server/e2e.mjs`)
and refuses otherwise (`e2e-devices`); the client re-seals.

### 3.5 Sender Keys for groups (`senderKeys.js`)

- Per sending device and group: a chain key (HMAC hash ratchet as above) and an ECDSA signing key.
- The distribution message travels through the pairwise Double Ratchet sessions.
- Each group message is encrypted once with info `"HiddenMessenger SenderKey message v1"` and signed. Its AD is `["hm-sk-v1", groupId, senderAddress, keyId, n]`.
- The key is bound to a hash of the group's device set (`membersHash`). Any membership or device change starts a
  new sender key, so removed members can't read later messages and new members can't read earlier ones.
- Up to `MAX_GROUP_SKIP` = 2000 skipped keys; up to 4 receiving keys per sender are kept (`KEEP_RECEIVING_SENDER_KEYS`), and 4 previous pairwise sessions per device (`KEEP_PREVIOUS_SESSIONS`).

### 3.6 Envelope (`envelope.js`)

`e2e2:<routing>|<json>`. The routing part tells the server only what it must act on (message kind for push
wording, media ids to authorise downloads). Everything else, including the plaintext kind of a media message, is
inside the ciphertext. Tests: `server/e2e-protocol.test.mjs` "Envelope: routing tells the server only what it needs".

### 3.7 Security codes (`protocol.js` `safetyNumber`)

The sorted identity keys of all devices of both accounts are hashed with 1024 rounds of SHA-256, giving 60
decimal digits (12 groups of 5). Both sides see the same code.

### 3.8 Trust on first use and key changes

A changed identity for a known device is refused for that session ("Trust on first use" test). When a contact's
device is reset, the app accepts the new key, shows a notice in the chat, and continues (test "A contact device
with reset keys"). **Reviewers should assess whether this notice-only behaviour is acceptable** or whether
sending should pause until the user acknowledges the change.

### 3.9 Strict mode: no readable fallback

When a contact or a group member has no device with keys (an app older than encryption), nothing the user writes
is sent readable:

- Direct: `sealDirect` throws `PeerKeysMissing`. `transmitDirect` keeps the message in the outbox marked
  `waiting`, retries every 30 s with a fresh device list, and sends it sealed once keys exist. The same applies
  before the device's own session has started.
- Groups: `sendGroupContent` throws `GroupKeysMissing`. The message is kept on the device (`src/groupPending.js`)
  and sent sealed once every member has keys.
- Only system records (call logs, "voice played" markers, local notices) may travel unsealed (`isUserContent`).
- Messages arriving readable from old apps are still shown, labelled "Not encrypted".

Tests: `server/e2e-strict.test.mjs`, and the browser check "after they update, it arrives end-to-end encrypted".

### 3.10 Other encrypted payloads

| Payload | Scheme | Where |
|---|---|---|
| Media | random key → HKDF → AES-256-GCM in 1 MiB chunks; per-chunk nonce; the "last chunk" flag is in the AD; SHA-256 of the ciphertext in the message | `src/mediaCrypto.js` |
| Statuses | sealed per audience device like a direct message | `client.js` `sealStatus` |
| Chat backups | PBKDF2-SHA-256 (600,000 rounds) → AES-256-GCM | `src/backup.js` |
| Linked-device history | browser key in the QR → ECDH P-256 → HKDF → AES-256-GCM, streamed in parts. The typed-code path requires users to compare a 20-digit fingerprint (about 66 bits) of the browser key | `src/linking.js` |
| Large group calls | a random 32-byte call key sent in an E2E group message; LiveKit E2EE (insertable streams) with that key. The call refuses to start unless the group is fully encrypted, and won't join from a card that arrived unencrypted | `src/groupRelayCall.js` |
| Push payloads | AES-GCM with a per-phone key registered with our server (hidden from Google, not from our server; see §7) | `android/.../PushRegistration.java` |

## 4. Data at rest on devices

- Private keys and chain keys: non-extractable `CryptoKey`s in IndexedDB (`idb-keyval`, store per device).
- **Plaintext memory**: the client keeps the plaintext of messages it sealed or opened, keyed by the SHA-256 of
  the envelope body (`hm:plain:<deviceId>:<hash>`), so history can be shown after the ratchet has moved on. This
  is plaintext at rest on the device. The device's app lock and OS protections are its only defence.
- Chats, call logs and preferences are stored per account in IndexedDB.

## 5. Metadata visible to the server

Sender, recipient and device ids; timestamps; envelope and media sizes; group membership and device lists; reaction
targets; delivery and read receipts (unless disabled); push routing; channel content (channels are public by
design and are not end-to-end encrypted).

## 6. How to run the tests

```
cd chat-app
npm ci
node --test server/e2e-protocol.test.mjs server/e2e-server.test.mjs server/e2e-strict.test.mjs server/call-e2e.test.mjs server/linking.test.mjs
npm test            # the whole suite
```

`server/e2e-protocol.test.mjs` covers:
- first message, replies and the prekey header;
- out-of-order delivery, replay and tampering;
- one-time prekey reuse;
- simultaneous first messages;
- trust on first use;
- multi-device fan-out;
- Sender Keys rotation on membership change;
- prekey rotation;
- the envelope routing contents;
- device reset.

There are no published test vectors yet; reviewers may want them added for each KDF step.

## 7. Known deviations and open questions for the reviewer

1. **P-256 everywhere** instead of X25519 and XEdDSA (a Web Crypto constraint). There are separate DH and
   signing identity keys, and both are bound into AD and security codes.
2. **Headers are not encrypted** (no header-encryption variant). Ratchet public keys and counters are visible.
3. **Identity change handling** is notice-only (§3.8).
4. **Plaintext memory at rest** (§4).
5. **Group call key lifetime**: one key for the whole call. Members who leave are not re-keyed out, and anyone with
   the call card can rejoin within 6 hours.
6. **Push payload key** is known to the server. Check whether pushes carry only the already-sealed envelope (they
   are intended to) or any readable text.
7. **Security codes and fingerprint lengths**: 60-digit safety numbers; 66-bit fingerprint on the linking
   typed-code path.
8. **Server-distributed keys** with no key transparency.
9. **No independent randomness test** beyond `crypto.getRandomValues`.

## 8. Suggested audit focus

- `ratchet.js` and `senderKeys.js` against the Signal specifications (state handling, skipped keys, AD binding).
- `client.js` sealing and opening paths, especially every place that could send or store plaintext.
- `server/e2e.mjs` checks that a malicious client can't make others accept wrong device lists.
- Linked-device history transfer and the typed-code fingerprint comparison.
- LiveKit E2EE key distribution and the fail-closed checks.

# Native e2e cutover — design for review (option C: native is the sole key owner)

Status: **proposal, not built.** This is the design to review before wiring `PushService`/`BackgroundHost` and
cutting over. The cryptographic layer it depends on is already built, conformant and committed (see
[CRYPTO-CORE-INTEGRATION.md](CRYPTO-CORE-INTEGRATION.md)): `HmCryptoCore`, `NativeStore`, `DeviceList`,
`NativeRegistration`, `NativeInbox`, `NativeFetchHandler`, `NativeRelayFetch` — all dormant behind the
`NativeBackground` flag.

## The problem this solves

Enabling the native path is **not** parallel to the WebView's encryption — it is a full cutover:

1. **One identity per device.** The server ties published keys to the session's device id. The moment native
   publishes its identity, contacts seal to the native keys (in `NativeStore`); the WebView app, holding a different
   identity in IndexedDB, can no longer decrypt, and the two would fight over the published identity (each
   republishes its own on a timer).
2. **Decrypted messages must reach the UI.** `NativeRelayFetch` decrypts and notifies, but the WebView renders the
   app. If native acks a message without storing it where the WebView reads, it vanishes from the app.

So there must be exactly one key owner, and the two surfaces (foreground WebView, background native) must share it.

## The design

**Native (`NativeStore` + `HmCryptoCore`) becomes the single key owner.** The WebView keeps owning the UI and the
message database; it stops holding e2e keys and instead performs every crypto operation through the native core over
the Capacitor bridge. Background delivery (no WebView) uses the same native core directly.

```
          FOREGROUND (app open)                         BACKGROUND (push, no screen)
   WebView UI + message DB (hm-local)              NativeBackgroundService (foreground service)
            │  protocol calls                               │
            ▼  (Capacitor bridge)                           ▼
   HiddenNativePlugin.crypto* ──►  HmCryptoCore  ◄── NativeRelayFetch ──► decrypt ──► native inbox
                                      │   (one identity, NativeStore)           │
                                      ▼                                         ▼
                                  NativeStore (keys)                    WebView imports on open
```

### 1. Bridge the WebView's protocol to the native core

`src/e2e/client.js` already funnels all crypto through one `protocol` object (`createProtocol`). Add a
**bridge-backed protocol** used only in the native app: each method (`prepareUpload`, `publicIdentity`,
`encryptForDevices`, `decryptFromDevice`, `forgetSession`, `encryptGroup`, `confirmGroupSend`, `resetGroup`,
`decryptGroup`, `safetyNumber`, `signPreviewKey`, `identityAgreement`) calls a new `HiddenNativePlugin` method that
delegates to `CryptoCore`. Values cross as the JSON shapes both sides already use (`{p,h,c}` entries, device maps,
group bodies) — the `directInterface`/group conformance already proves the native core produces exactly what the web
protocol expects. In a browser (no native), `createProtocol` stays as today.

- New plugin methods on `HiddenNativePlugin` (Java → Kotlin `CryptoCores.current()`), e.g. `cryptoEncryptForDevices`,
  `cryptoDecryptFromDevice`, … `claimBundles` is a callback in the Kotlin signature; over the bridge it is resolved
  by the JS side passing the already-claimed bundles in, or by the plugin calling back into JS. Simplest: JS claims
  bundles first (it already talks to the server) and passes them in, so the plugin method is pure.
- `startE2e` installs the native core (`NativeBackground.install`) and uses the bridge protocol; `browserKeyStorage`
  and the WebView's own key records are no longer used in the native app.

### 2. One identity, one registration (the chosen migration)

On first native run: `HmCryptoCore` generates a fresh identity in `NativeStore`; `NativeRegistration` publishes keys
and a signed device list (fresh account key). Contacts see "security code changed" once. The WebView's old IndexedDB
identity is abandoned (the user accepted wipe/reset). The WebView must **not** republish its old identity — its key
publishing is disabled in the native app (it now goes through the native core, which publishes the native identity).

### 3. Persistence-for-display

- **Foreground:** unchanged — the WebView decrypts via the bridge and stores in its message DB exactly as today.
- **Background:** `NativeRelayFetch` decrypts, then **seals each opened event into a native background inbox** (an
  `EncryptedSharedPreferences`/SQLCipher list keyed by message id, Keystore-sealed), and posts the notification. The
  WebView imports this inbox on next open through the existing `importInbox` flow (`src/backgroundInbox.js`) — add a
  bridge method that hands the sealed events to JS and clears them after import. Only after the event is in the inbox
  does native send `message:delivered` and `queue:ack`, so nothing is lost (the same ordering `HeadlessRunner` uses).

### 4. Wiring `PushService` / `BackgroundHost`

- `PushService` (no screen, flag on): start a new `NativeBackgroundService` (a short foreground service like
  `BackgroundHost`) that installs the core, ensures registration, runs `NativeRelayFetch`, and stops when done.
- Flag off: start `BackgroundHost` (the WebView `HeadlessRunner`) exactly as today — the untouched fallback.
- `AppActivity.onCreate` (flag on): `NativeBackground.install` before the bridge, and stop any native fetch when the
  screen opens (mirrors `BackgroundHost.stopForApp`). Flag off: no change.
- `HeadlessRunner`/`background.html` stay in the build until the native path is verified on the S23, then are removed.

## What gets reused vs built

- **Reused:** the whole native crypto layer (done); the server (no changes — same `/e2e/*` endpoints, same
  `relay.fetch` socket); the WebView UI and message DB; `importInbox`; `Alerts`/`NotificationChannels`;
  `RelaySession`.
- **Built:** the bridge plugin methods + the JS bridge-backed protocol; disabling WebView key publishing in the
  native app; the native background inbox + its import bridge; `NativeBackgroundService`; the `PushService`/`AppActivity`
  gates; the one-time migration trigger.

## Risks and mitigations

- **Interop drift:** every message must stay byte-compatible with web/desktop/website. Mitigated by the existing
  byte-for-byte conformance; add an app-level test that a bridge round trip equals a direct-core round trip.
- **Message loss on cutover:** in-flight sessions reset (new identity). Mitigated by the server's "new identity →
  forget device" path and senders re-establishing via prekeys; acceptable per the chosen migration.
- **Two owners during rollout:** the flag must flip *both* "use native core" and "disable WebView key publishing"
  together, or the identities fight. Mitigated by a single flag gating both.
- **Foreground latency:** every foreground crypto op is now a bridge hop. Expected fine (operations are sub-ms), but
  measure chat-open and send on the S23.
- **Background service limits:** Android 14 short-service quota — reuse the `BackgroundHost` service type and timing.

## Rollout / verification

1. Land the above behind the flag (still off), unit-tested (bridge round trip, inbox seal/import).
2. On a **throwaway account** on the S23, turn the flag on: register, send/receive direct + group both foreground and
   from background (app closed), confirm notifications show real text, messages appear in the app, and a web/desktop
   client interoperates (security-code-changed shown once, then messages flow).
3. Measure latency vs the WebView path; check the FGS quota and battery.
4. Only then consider defaulting the flag on and removing `background.html`/`HeadlessRunner`.

## Open questions for you

- **Scope of the bridge:** route *all* WebView crypto through native (cleanest, one owner), or only key storage +
  background? Recommendation: all crypto, so there is exactly one identity and one ratchet per device.
- **Account continuity:** confirm the one-time "security code changed" for every contact is acceptable (it is the
  chosen migration), vs. the larger effort of migrating the existing WebView identity into `NativeStore` to avoid it.
- **Desktop/web:** these keep the WebView e2e (no native). The native app becoming a new identity is just a new
  device from their point of view — fine, but worth confirming you don't want a shared identity across surfaces.

# Native e2e path — S23 verification checklist

Use this before defaulting the native path on or removing `background.html` / `HeadlessRunner`. The native side is
built and unit-tested (44 `core.*` tests, all conformant); this verifies the whole cutover on a real device.

**Prerequisite — the JS side must land first.** Enabling the flag does nothing useful until `src/e2e/client.js`
routes its crypto through the native bridge, imports the native inbox, and stops the WebView's own key publishing
(see NATIVE-CUTOVER-DESIGN.md §1, §3). Do not run this checklist before that; until then the flag is inert and the
WebView path runs as today.

**Test with a throwaway account only.** Enabling the native path publishes a fresh device identity, which makes the
WebView's old identity unusable and shows contacts "security code changed". Never run first verification on the real
account.

## Build (memory-safe, this PC)

1. Close heavy apps (Chrome, VS Code) — the Android+Kotlin build needs the RAM.
2. `cd chat-app && node scripts/e2e-native-vectors.mjs` (regenerate vectors if `src/e2e/` changed).
3. `cd android && ./gradlew --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1200m :app:testDebugUnitTest --tests "io.github.bickworld555.hiddenchat.core.*"` — must be green.
4. Build the signed release APK with the established recipe (JDK 21, Gradle 8.14.3 direct, serial CMake, keystore from EAS; see the build notes in memory). Verify the cert SHA-256 and `adb -s R5CW90HMM2B install -r`.

## Turn the flag on (device, throwaway account)

- No Settings toggle ships yet; set the pref directly for the test:
  `adb -s R5CW90HMM2B shell "run-as io.github.bickworld555.hiddenchat ..."` is blocked on a release build, so add a
  temporary debug affordance, or call `NativeBackground.setEnabled(context, true)` from a debug entry point. Record how
  you set it so you can clear it.
- Confirm registration: after the next push or app open, `GET /api/v1/e2e/keys` for the account shows the device
  `published: true` and a device list signed by the new account key (check the server, or a second client).

## Test matrix (each: expected result)

| Case | Expected |
|---|---|
| Register (first native run) | keys + signed device list published; contacts see "security code changed" once |
| Direct message, app in foreground | sent/received through the native bridge; appears in the chat |
| Direct message, app closed (push) | `NativeBackgroundService` runs; notification shows **real text** fast; message is in the app when opened |
| Group message, foreground and closed | same, for a group |
| Interop: web/desktop ⇄ S23 | after the one-time security-code-changed, messages flow both ways, decrypt correctly |
| Undecryptable / wrong device | sealed "🔒 Message" notice; not acked; no crash |
| Multiple messages / burst | all delivered once, none lost, none duplicated |
| Media / voice note | attachments still resolve (routing unchanged) |
| Flag OFF (rollback) | `BackgroundHost`/`HeadlessRunner` path runs exactly as before; no native service |

## Non-functional

- **Latency:** chat open, send, and notification time vs the WebView path (bench/ harness). Expect parity or better.
- **FGS quota (Android 14):** `NativeBackgroundService` uses `shortService`; confirm it is not refused after other
  services run (the dataSync quota issue that bit `BackgroundHost`).
- **Battery / wakelocks:** the fetch ends on quiet; confirm no lingering service.
- **No secrets at rest:** the native inbox entries are Keystore-sealed; the account key is Keystore-sealed in
  `NativeStore`.

## Data-integrity gates (must all hold)

- A message is sealed into the native inbox **before** `queue:ack` — kill the service mid-fetch and confirm the
  message still arrives (on the server, re-delivered to the app).
- Turning the flag off and on does not double-deliver or drop messages.
- `wipe()` on sign-out clears `NativeStore` (identity, sessions, account key, inbox).

## Only after every gate passes

1. Default the flag on (staged: a few devices first).
2. Then remove `background.html`, `HeadlessRunner`, `BackgroundHost`, and the WebView key/protocol code paths.
3. Keep this checklist green on each release until the WebView path is gone.

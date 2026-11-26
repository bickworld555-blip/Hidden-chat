# Hidden Messenger — Handover (Windows reset / fresh clone)

> **Audience:** a future agent (or developer) resuming this project after a Windows
> reinstall + C: format and a fresh `git clone`. This file is the single source of
> truth for "where things stand" — read it top to bottom before doing anything.
> Local agent memory, build tools, and the signing keystore do **not** survive the
> format; this document replaces that context.

---

## 0. ⚠️ BACK UP BEFORE YOU FORMAT C:  (do this first, it is not in git)

These live on `C:` and are **permanently lost** on format. Copy them to external
storage / cloud **now**:

| What | Path | Why it matters |
|---|---|---|
| **Release keystore + credentials** | `C:\Users\shakil\HiddenChatSigning\` (`hidden-chat-release.jks`, `credentials.txt`) | **CRITICAL.** This key signs the public Android APK. Its SHA-256 is `12:2C:FF:C8:EF:14:84:4C:4A:2D:B0:6C:A9:FA:0B:7D:8B:9D:03:B2:C2:29:56:53:87:ED:98:6B:24:D6:4B:11`. Lose it and you can never ship an in-place update again (users must uninstall/reinstall). The password is inside `credentials.txt` — **never commit it**; this repo is public. |
| **Internal audit docs** | `chat-app/docs/*.md` (13 files, untracked) | WhatsApp comparisons, production audits, gap analyses. Deliberately **not** pushed (public repo). Back up separately if you want to keep them. |
| **Server env / secrets** | VPS + Hostinger panels (not on this PC) | The `hiddenmessenger.com` backend is on the VPS; its env files are there, not here. Nothing to back up locally, but know they exist. |

Everything else (code) is safe on GitHub. The JDK, Android SDK, Node, Gradle are
all re-installable.

---

## 1. Project overview & core theme

**Hidden Messenger** — *"No email, no number, only privacy — with a WhatsApp-like feel."*
A private messenger: no phone numbers / no email; accounts are 10-digit IDs; full
end-to-end encryption; WhatsApp-parity UX (chats, groups, calls, media, voice notes,
status, etc.).

**Stack today:** a React/Zustand/Vite web app (`src/`) running inside a Capacitor
Android WebView, being migrated **feature-by-feature to native Kotlin / Jetpack
Compose**. There is also a Windows desktop app (`desktop/`) and the public marketing
site (`src/site/`, now a **download-only portal**).

**Repo:** `https://github.com/bickworld555-blip/Hidden-chat.git` — a fresh clone of this
repo **is** the project root (`chat-app/`). Main branch: `main`. All work below is on
`main`; `origin/main` is up to date through the latest commit (see §6).

---

## 2. The 6-phase native migration plan + status

The app is becoming "native-first": a native Compose UI runs on top, while the WebView
is still the **engine** (login, E2E crypto, relay socket, message projection, calls).
The goal is to replace each engine piece natively, then remove the WebView **last**.

| Phase | Scope | Status |
|---|---|---|
| **1 — Native shell & entry** | Native login/onboarding/unlock, launcher retirement, Settings/Profile/Contacts/Linked-Devices | **Partial.** Settings/Profile/Contacts/Unlock screens DONE + verified on device (commit `3f6f2dd`). Native **login/onboarding**, **launcher retirement**, and **Linked Devices** DEFERRED — they need the native crypto core (Phase 2). |
| **2 — Crypto core** | Enable the native E2E ratchet (`core/crypto/*`, `NativeFlag`) so sealing is native, not bridged to the WebView | **BLOCKED on 2-device verification** (the next real milestone). Code exists; gated OFF. |
| **3 — Transport / message ownership** | Native owns the `/ws` relay socket (`socket_owner`); native produces its own message data (drop the WebView projection) | Not started. Depends on Phase 2. |
| **4 — Calls** | Native libwebrtc call media (`NativeCallBridge`), replace WebView WebRTC | Not started. Gated (`hm_native_calls` off). |
| **5 — Media & edges** | Native media upload; reply-target send; view-once; scheduled; stickers | **Partial.** Native **photo upload** DONE + verified on device (commit `642b60e`). **Reply-target send** already works natively (fallback drops the reply — small fix open). **View-once, scheduled messages, stickers** NOT started. |
| **6 — Decommission WebView** | Remove `BridgeActivity`, the web bundle, and `src/` | **Must stay LAST.** Blocked until Phases 2–5 are done AND verified in production — removing the WebView now bricks the app (no login, no crypto, no send, no data, no calls). |

---

## 3. Current feature / phase status (detail)

### Done & verified on device
- **Native-first build:** after sign-in the native Compose UI (`NativeUiActivity`) opens
  automatically instead of the WebView. Gated by `hm_native_ui/enabled`, now **default ON**.
  (Both `nativeUiAllowed` and `openNativeUi` default true — a subtle earlier bug where only
  one was flipped is fixed.) Commit `6fbb128` + `3f6f2dd`.
- **Native read UI:** chat list, conversation (read), new-chat w/ account-ID search, real
  avatars, media (photo/video full-res), voice notes (waveform/seek), documents, captions,
  albums, native store + FTS search. Verified across earlier commits (`3edf3bc` et al.).
- **Phase 1 screens:** native Settings (secure-screen toggle, native app-lock), Profile
  (read-only `/api/v1/me`), Contacts (search over native store), Unlock (biometric via
  `AppSecurity`). `NativeUiActivity` extends `FragmentActivity` for `BiometricPrompt`. `3f6f2dd`.
- **Phase 5 native photo upload (`642b60e`):** `NativeMediaCrypto.encrypt` (exact inverse of
  the proven decrypt; v1 HKDF→AES-GCM), `NativeServer.uploadMedia` (POST `/api/v1/media`),
  `NativeSend.sendMedia` + WebView-bridge fallback, `NativeMediaSend`, composer attach button +
  `PickVisualMedia` picker. Verified on device: encrypt→upload→download→decrypt round-trip
  `ok=true` against the real server; send→local-echo produced a `kind=photo` message.
- **Website = download portal only:** `entryFor` returns the public site for every browser
  path (no web messenger/login in a browser); the installed app runs the messenger. `6fbb128`.
- **Android release signing:** website APK is a **GitHub Release** asset (latest tag
  `android-v1.0.1`, signed vc78), not EAS. See §4 for the signing flow.

### Open / remaining
- **Phase 5 photo upload — still needs the 2-device check:** recipient **delivery + decrypt**
  (the native send currently bridges to the WebView's audited E2E because the native crypto
  core is off; a real second device with published keys is needed to confirm the recipient
  can open the photo). Send + local echo are verified on one device; recipient side is pending.
- **Reply-target fallback fix (small):** native reply-target send works, but the WebView
  fallback (`requestSend`) drops `replyToId`. Carry it through `requestSendMedia`-style.
- **Phase 5 remaining:** view-once media, scheduled messages, stickers (each a net-new build).
- **Phase 2 — crypto core 2-device verification** (the key unblocker for Phases 1/2/3/6).
- **Phase 3 — native socket ownership** (`socket_owner`).
- **Phase 4 — native calls** (`hm_native_calls`).
- **Phase 6 — WebView decommission** (keep LAST).

### What STILL depends on the WebView (do not remove it)
Login/onboarding (React `UsernameGate`), **all E2E sealing/sending** (native `NativeSend`
needs `CryptoCores.current()`, which is null while `NativeFlag` is off → falls back to the
WebView), **all chat/message data** (the WebView mirrors into the native store via
`nativeSaveChats`/`nativeSaveMessages`), the relay `/ws` socket (`RealtimeClient`), and calls.
The launcher still targets `.AppActivity` (the WebView).

---

## 4. Build & environment notes

- **Android build:** Gradle **8.14.3** (wrapper). Use **JBR 21** as `JAVA_HOME`
  (was at `C:\Users\shakil\.jdks\jbr-21.0.11`; reinstall any JDK 21 — JetBrains Runtime 21
  preferred). A newer system Java (25) breaks Gradle 8.14.3 ("Unsupported class file major
  version"). Set `ANDROID_HOME` to the Android SDK.
- **Build a debug/lab APK:** `export JAVA_HOME=<jbr21>; export ANDROID_HOME=<sdk>;
  export ANDROID_VERSION_CODE=<n>; cd android; ./gradlew :app:assembleDebug`. The debug build
  installs as **HM Lab** (applicationId `.lab`), separate from the release.
- **Build a signed release APK:** `ANDROID_APP_URL=https://hiddenmessenger.com npm run
  android:sync` (rebuilds the web bundle into `android/app/src/main/assets/public` — **required**
  whenever `src/` changes), then in `android/`, export the 4 keystore vars (source the backed-up
  `credentials.txt`) + `ANDROID_VERSION_CODE` + `JAVA_HOME=<jbr21>`, then
  `./gradlew :app:assembleRelease`. Output: `android/app/build/outputs/apk/release/app-release.apk`.
  Verify the signer with `build-tools/*/apksigner.bat verify --print-certs`.
- **Website APK link:** `src/site/links.js` `ANDROID_APK_URL` points at a GitHub Release asset.
  To publish a new APK: create a `android-v<ver>` release via the GitHub API, upload the APK,
  update `links.js`, push → `deploy-vps.yml` auto-deploys the site.
- **Tests:** `npm test` (Node `--test server/*.test.mjs`, includes guard tests that read `src/`
  and `android/` source). Must stay green (currently 882 pass). `npm ci` for a clean install;
  check `.nvmrc` / `package.json#packageManager` for the pinned Node/npm.
- **Deploy pipeline:** push to `main` → GitHub Actions `deploy-vps.yml` builds + auto-deploys
  the web/server to the **VPS** (production is the VPS, `hiddenmessenger.com`, HTTP 200). No SSH
  from this PC. `build-apk.yml` is a separate workflow and currently fails (needs repo var
  `ANDROID_APP_URL` + keystore secrets configured in GitHub settings) — the APK is built locally
  + uploaded as a Release asset instead.

### Safety rules (keep intact)
- **Do NOT enable `NativeFlag`, `socket_owner`, or `hm_native_calls` by default** before the
  two-device verification. They gate crypto/transport/calls; flipping them unverified risks
  breaking message delivery/decryption for real accounts.
- **Do NOT remove or break the `hiddenmessenger.com` backend / API.** "Decommissioning the
  WebView" (Phase 6) is about the local WebView UI + JS engine, NOT the server. The server is
  independent and must keep working through every phase.
- **No test hooks in release code.** Earlier temporary hooks (WebView debugging in
  `AppActivity`, a `hm_native_for` intent handler, a `P5VERIFY` self-test) were all removed.
  If you add a temporary on-device verification, remove it before committing.
- Work only in this repo (`chat-app`). (Historically it sat inside an unrelated outer repo on
  this machine; after a fresh clone of `Hidden-chat` that no longer applies — this IS the root.)

---

## 5. First steps after reinstalling Windows

1. **Restore the backed-up keystore** to `~/HiddenChatSigning/` (`hidden-chat-release.jks` +
   `credentials.txt`). Without it you cannot sign compatible APK updates.
2. **Clone:** `git clone https://github.com/bickworld555-blip/Hidden-chat.git` → this is the
   project root.
3. **Install toolchain:** Node (per `.nvmrc` / `package.json#packageManager`), a JDK 21
   (JetBrains Runtime 21 preferred), the Android SDK + platform-tools (adb), and set
   `JAVA_HOME` (JBR 21) + `ANDROID_HOME`. Android Studio installs the SDK cleanly.
4. **Install deps + sanity check:** `npm ci` then `npm test` (expect all green).
5. **Build check:** `ANDROID_APP_URL=https://hiddenmessenger.com npm run android:sync`, then
   `cd android && JAVA_HOME=<jbr21> ANDROID_HOME=<sdk> ANDROID_VERSION_CODE=100 ./gradlew
   :app:assembleDebug`. Install on the device: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
6. **Device:** the test phone is a Samsung S23 Ultra (serial `R5CW90HMM2B`). The native UI opens
   after sign-in (flag default on). The Compose UI is hard to drive via `adb`/uiautomator (no
   accessibility nodes) — verify native crypto/send with a small temporary on-device self-test
   (then remove it), or manual taps.
7. **Resume the plan:** the next real milestone is **Phase 2 — the two-device crypto-core
   verification**, which unblocks native login, native send, socket ownership, and eventually
   the Phase 6 WebView decommission. Then the remaining Phase 5 edges (view-once, scheduled,
   stickers) and the reply-target fallback fix.

---

## 6. Quick reference

- **Remote:** `https://github.com/bickworld555-blip/Hidden-chat.git`, branch `main`.
- **Recent commits (newest first):** `642b60e` Phase 5 native photo upload · `3f6f2dd` Phase 1
  native screens · `6fbb128` native-first + download-only site · `e3e7051` APK link ·
  `f602ebc` test guards · `3edf3bc` native voice/docs/albums/captions.
- **Native UI entry:** `android/.../ui/NativeUiActivity.kt` (hosts the Compose screens).
- **Native crypto / send:** `NativeMediaCrypto.kt`, `NativeSend.kt`, `core/crypto/*`,
  `NativeFlag.java`, `NativeServer.kt`.
- **WebView bridge seam:** `NativeUiBridge.kt` ↔ `src/App.jsx` (`nativeUiSend`).
- **Web app:** `src/` (React). **Site:** `src/site/`. **Desktop:** `desktop/`.
- **Backend:** `server/` (Node) → deployed to the VPS as `hiddenmessenger.com`.

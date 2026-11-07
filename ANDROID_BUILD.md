# GitHub push and Android device-test APK

## 1. Push the chat app, not the parent REA repository

The parent `WorldMessenger` folder is already a Git repository pointing at
`morluto/rea`. Leave it unchanged. Create a separate repository **inside chat-app**
so Hidden-chat contains this app, its server, and its Android build workflow.
The following are PowerShell commands. They are instructions, not commands
already executed on your behalf.

Before making a public commit, inspect the app's files for private data.
Do not publish database backups, user data, credentials, logs or signing keys.
The ignore rules exclude environment files, local data, dependencies, build output
and keystores. Existing report/documentation files still need your review.

```powershell
Set-Location C:\Users\shakil\WorldMessenger\chat-app
if (-not (Test-Path .git)) { git init -b main }
git remote -v
```

For a newly initialized repository:

```powershell
git remote add origin https://github.com/bickworld555-blip/Hidden-chat.git
```

If **this chat-app repository** already has an `origin`, inspect it first,
then replace it only if Hidden-chat is the intended destination:

```powershell
git remote set-url origin https://github.com/bickworld555-blip/Hidden-chat.git
```

Stage and review before committing:

```powershell
git check-ignore .env node_modules dist .data
git add .
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached --name-only
```

Inspect the staged diff locally. If a private file was staged, unstage that
specific file and add an ignore rule before continuing. Never use `git add .`
from the parent folder.

```powershell
git commit -m "feat: add chat app and signed Android test APK pipeline" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push -u origin main
```

Use Git Credential Manager's browser login when prompted. Do not put a token in
the remote URL. If Git requests your author name/email, configure your own values
or GitHub-provided no-reply email; the assistant must not choose your identity.
If the remote already has commits, fetch and inspect its history before merging.
Do not force-push to resolve a rejection.

This pushes `.github/workflows/build-apk.yml` at **Hidden-chat's root**.
Putting this workflow beneath `chat-app` inside the parent REA repository would
not make GitHub discover it.

## 2. Supply an HTTPS app URL (Hostinger is not required)

GitHub Actions builds an APK. It does **not** run a persistent Express server,
Supabase project, TURN relay or WebSocket signaling service for your phones.

This first APK is a **Capacitor remote-URL device-test shell**, not an offline
app or Play Store production package. It loads your selected HTTPS app origin,
so existing relative `/api`, `/ws`, media and model requests continue to work.
Only use an origin you control: it runs inside the app's privileged WebView.
Capacitor documents `server.url` as a development/live-reload facility.
Shipping a bundled production client requires a separate API-origin integration.

You can use the existing temporary tunnel workflow:

```powershell
Set-Location C:\Users\shakil\WorldMessenger\chat-app
npm ci
npm run tunnel:ngrok
```

Install/authenticate the Ngrok CLI separately if not already available.
Keep the local API, Vite and tunnel running while testing. The HTTPS origin
printed by the launcher must open the real login page from your phone's browser
and proxy `/api` and `/ws`. Use test accounts only; a tunnel exposes the running
app. See the README's tunnel and TURN notes.

In Hidden-chat on GitHub:

1. Open **Settings > Secrets and variables > Actions > Variables**.
2. Add repository variable **`ANDROID_APP_URL`** with that exact HTTPS origin.
   Example shape: `https://your-controlled-host.example`.
3. Do not include credentials, URL paths, query strings or fragments.

No URL was provided during implementation. The workflow intentionally fails with
an actionable error until this variable is set. If the tunnel URL changes, update
the variable and rebuild/reinstall the APK. A stopped tunnel means the APK
cannot connect. Rebuilding the APK does not update the web server's deployed code.

## 3. Create a persistent APK signing key

A release APK must be signed to install. The workflow does **not** fall back to a
debug key or generate a different signing identity on each run.

On a machine with Java 21 / `keytool` available, run PowerShell:

```powershell
$keyDirectory = Join-Path $env:USERPROFILE "HiddenChatSigning"
New-Item -ItemType Directory -Path $keyDirectory
$keyPath = Join-Path $keyDirectory "hidden-chat-release.jks"
keytool -genkeypair -v -keystore $keyPath -alias hiddenchat -keyalg RSA -keysize 3072 -validity 10000 -storetype JKS
```

Supply passwords through `keytool`'s interactive prompts. Back up the key and
passwords securely. Do not regenerate it for subsequent APK updates.
If the directory or key already exists, inspect and reuse the intended key
rather than overwriting it.

Copy the base64-encoded key to your clipboard locally:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPath)) | Set-Clipboard
```

Add these **repository Actions secrets** under
**Settings > Secrets and variables > Actions > Secrets**:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Clipboard base64 key |
| `ANDROID_STORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `hiddenchat` |
| `ANDROID_KEY_PASSWORD` | Password for that alias |

Clear the clipboard after pasting:

```powershell
Set-Clipboard -Value ""
```

Do not send these values in chat, commit them, or set them as public variables.
Only trusted people should have repository write/workflow-edit permissions:
workflows on trusted branch pushes can access signing secrets.
No Supabase secret is required for the APK build.

## 4. Trigger and download the APK

The action runs on pushes to `main`, `v*` tags, or manual dispatch.
If your first push ran before configuring the variable/secrets, use
**Actions > Build Android test APK > Run workflow > main** after setting them.

The workflow installs locked dependencies, runs tests, builds Vite, syncs
Capacitor, uses Java 21/Android SDK 36, builds a signed release APK, and verifies
its signature. A failing check prevents artifact upload.

After a successful run:

1. Open **Hidden-chat > Actions > Build Android test APK**.
2. Select the green successful run.
3. Scroll to **Artifacts**.
4. Download **`Hidden-chat-release-<run number>`** (sign in to GitHub if necessary).
5. Extract the ZIP: it contains `Hidden-chat-release.apk` and a SHA-256 checksum.
6. Transfer the APK to your Android phone and open it.
7. Allow **Install unknown apps** for the file manager/browser you used.
   Respect Android/Play Protect warnings; do not disable protection globally.
8. Launch **Hidden Chat Test** and allow camera/microphone/location permissions
   when prompted by a feature.

Artifacts are retained for 14 days. This is an installable APK artifact,
not a Play Store listing, GitHub Release attachment, or AAB.
Android 7+ is supported by this Capacitor version; keep Android System WebView
and Chrome up to date.

## 5. Test and iterate

Use two real test accounts on two devices:

- Registration/login and contact search.
- Messages, replies, reactions, read receipts and offline/reconnect behavior.
- Original-byte uploads/downloads, profile photos and resumable uploads.
- Camera, microphone, avatar calibration and animation On/Off during calls.
- Calls across Wi-Fi and mobile data with your own TURN relay configured.
- Live-location consent, permission denial, expiry and stop.
- App background/foreground and network loss. Background calls, PiP,
  screen capture and native push notifications are **not certified** by wrapping
  the web app; verify support separately.

Push the next reviewed commit to `main` to generate another APK. Install it over
the previous one; GitHub run numbers provide increasing Android version codes.
Keep the package ID and signing key unchanged. If Android reports a signature
conflict, first check whether an earlier APK used a different key; uninstalling
erases the app's local accounts/data.

Web content follows the configured server, not the bundled `dist` fallback.
Deploy/run your changed web/server code at the test URL too. A workflow artifact
alone does not prove that the phone saw the latest code.

### Local checks and native build limitations

```powershell
npm test
npm run build
$env:ANDROID_APP_URL = "https://YOUR-ACTUAL-APP-ORIGIN"
npm run android:sync
```

The Android native project is committed source; copied web assets and generated
Capacitor config are ignored and recreated by sync. A local native build requires
Java 21 and Android SDK 36 / Android Studio. CI provisions those tools.
This environment did not have Java/Android SDK available; no local native APK
compilation, GitHub run or real-device installation is claimed.

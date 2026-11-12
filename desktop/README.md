# Hidden Messenger for Windows

A small Electron window around the web companion at `https://hiddenmessenger.com/app`. It opens only by linking with
the phone: scan the QR code with the Android app (Settings › Linked devices › Link a device). Password sign-in and
new accounts are refused on computers, by the page and by the server (`server/clientGate.mjs`).

Each deploy of the website updates the desktop app; rebuild only when this folder changes.

- The page runs sandboxed, without Node.js.
- Links to other sites open in the default browser.
- Only the camera and microphone (calls), notifications, clipboard writes and screen sharing are allowed, and only for the messenger.
- Chats are kept in the app's own private storage on this computer (`%APPDATA%\Hidden Messenger`).

## Build

Requires Node.js 22 or newer on Windows. Nothing else needs installing; Electron and the installer tools are fetched
by npm.

```sh
cd desktop
npm ci
npm test            # the window's rules (config.cjs)
npm run build:win   # → dist/HiddenMessenger-Setup-<version>.exe and dist/HiddenMessenger-<version>-portable.exe
```

- `HiddenMessenger-Setup-<version>.exe` installs per user, with Start menu and desktop shortcuts.
- `HiddenMessenger-<version>-portable.exe` runs without installing.

## Try it against a local server

```sh
HM_APP_URL=http://localhost:5173/app npm start
```

`HM_APP_URL` must be https, or http on localhost.

Terminals inside VS Code (and other Electron-based tools) set `ELECTRON_RUN_AS_NODE=1`. With it set, Electron runs as
plain Node and the app exits at once ("bad option"). Clear it first: `env -u ELECTRON_RUN_AS_NODE npm start`, or in
PowerShell `Remove-Item Env:ELECTRON_RUN_AS_NODE`. A normal double-click is not affected.

## Signing

The builds are not code-signed, so Windows SmartScreen warns on first launch ("More info › Run anyway"). To sign, set
`CSC_LINK` (path or base64 of a .pfx) and `CSC_KEY_PASSWORD` before `npm run build:win`. Never commit the certificate.

## Version

Raise `version` in `package.json` for every release you hand out.
